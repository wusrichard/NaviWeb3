import os
import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from knowledge import KNOWLEDGE

load_dotenv()

ZAI_API_KEY = os.getenv("ZAI_API_KEY")
ZAI_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    protocol: str
    question: str


def _headers() -> dict:
    return {"Authorization": f"Bearer {ZAI_API_KEY}", "Content-Type": "application/json"}


def get_embedding(text: str) -> list[float]:
    resp = requests.post(
        f"{ZAI_BASE_URL}/embeddings",
        headers=_headers(),
        json={"model": "embedding-3", "input": text},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    norm = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / norm) if norm > 0 else 0.0


def rerank(query: str, passages: list[str]) -> list[str]:
    resp = requests.post(
        f"{ZAI_BASE_URL}/rerank",
        headers=_headers(),
        json={"model": "rerank", "query": query, "documents": passages, "top_n": 2},
        timeout=30,
    )
    if resp.status_code != 200:
        # fallback: return top 2 from cosine ranking
        return passages[:2]
    results = resp.json().get("results", [])
    sorted_results = sorted(results, key=lambda x: x.get("relevance_score", 0), reverse=True)
    return [passages[r["index"]] for r in sorted_results[:2]]


def generate_answer(question: str, context: str) -> str:
    resp = requests.post(
        f"{ZAI_BASE_URL}/chat/completions",
        headers=_headers(),
        json={
            "model": "glm-4-flash",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是 DeFi 操作路徑顧問，用繁體中文回答。"
                        "回答必須包含：① 具體操作步驟（用編號列出）② 每個步驟的預估費用（Gas 費或手續費數字）③ 預期 APY 或報酬率數字。"
                        "如果第一次回答缺少具體費用數字，請自動補充並重新整理。"
                    ),
                },
                {
                    "role": "user",
                    "content": f"參考資料：\n{context}\n\n問題：{question}\n\n請給出具體操作步驟、費用數字與預期收益。",
                },
            ],
            "temperature": 0.3,
        },
        timeout=60,
    )
    resp.raise_for_status()
    answer: str = resp.json()["choices"][0]["message"]["content"]

    # retry if answer lacks any digit (likely missing fee/APY numbers)
    if not any(c.isdigit() for c in answer):
        retry_resp = requests.post(
            f"{ZAI_BASE_URL}/chat/completions",
            headers=_headers(),
            json={
                "model": "glm-4-flash",
                "messages": [
                    {"role": "system", "content": "你是 DeFi 操作路徑顧問，用繁體中文回答，必須提供具體費用數字和操作步驟。"},
                    {"role": "user", "content": f"參考資料：\n{context}\n\n問題：{question}\n\n請務必提供具體費用數字（例如 Gas 費 $5 USD、手續費 0.04%）和操作步驟。"},
                ],
                "temperature": 0.3,
            },
            timeout=60,
        )
        retry_resp.raise_for_status()
        answer = retry_resp.json()["choices"][0]["message"]["content"]

    return answer


@app.post("/query")
async def query(req: QueryRequest):
    protocol = req.protocol.lower()
    question = req.question.strip()

    passages = KNOWLEDGE.get(protocol)
    if not passages:
        raise HTTPException(status_code=400, detail=f"不支援的協議：{req.protocol}，請選擇 etherfi / curve / hyperliquid")

    # Step 1: embed question
    q_emb = get_embedding(question)

    # Step 2: cosine similarity, pick top 5
    scored = []
    for p in passages:
        p_emb = get_embedding(p)
        scored.append((cosine_similarity(q_emb, p_emb), p))
    scored.sort(key=lambda x: x[0], reverse=True)
    top5 = [p for _, p in scored[:5]]

    # Step 3: rerank to top 2
    top2 = rerank(question, top5)

    # Step 4: generate answer
    context = "\n\n".join(top2)
    suggestion = generate_answer(question, context)

    return {"suggestion": suggestion}
