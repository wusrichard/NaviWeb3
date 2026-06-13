import asyncio
import os
import re
import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from cobo_agentic_wallet.client import WalletAPIClient
from cobo_agentic_wallet.errors import PolicyDeniedError

from knowledge import KNOWLEDGE

load_dotenv()

ZAI_API_KEY = os.getenv("ZAI_API_KEY")
ZAI_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"

COBO_API_KEY  = os.getenv("COBO_API_KEY")
COBO_API_URL  = os.getenv("COBO_API_URL", "https://api.agenticwallet.cobo.com")
COBO_WALLET_ID = os.getenv("COBO_WALLET_ID")

# ── Token 地址 ────────────────────────────────────────────
TOKENS = {
    "USDC":  {"addr": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "decimals": 6},
    "ETH":   {"addr": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "decimals": 18},
    "weETH": {"addr": "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", "decimals": 18},
}

# ── Paraswap 即時報價 ─────────────────────────────────────
def get_swap_quote(src: str, dst: str, amount_human: float) -> dict | None:
    src_info, dst_info = TOKENS.get(src), TOKENS.get(dst)
    if not src_info or not dst_info:
        return None
    amount_wei = int(amount_human * 10 ** src_info["decimals"])
    try:
        resp = requests.get(
            "https://apiv5.paraswap.io/prices",
            params={
                "srcToken": src_info["addr"],
                "destToken": dst_info["addr"],
                "amount": str(amount_wei),
                "srcDecimals": src_info["decimals"],
                "destDecimals": dst_info["decimals"],
                "network": 1,
                "side": "SELL",
            },
            timeout=8,
        )
        route = resp.json().get("priceRoute", {})
        dest_amount = round(int(route.get("destAmount", 0)) / 10 ** dst_info["decimals"], 6)
        gas_usd = route.get("gasCostUSD", "?")
        exchanges = " → ".join(
            swap["swapExchanges"][0]["exchange"]
            for swap in route.get("bestRoute", [])
            if swap.get("swapExchanges")
        ) or "未知"
        return {"src": src, "dst": dst, "amount": amount_human,
                "dest_amount": dest_amount, "gas_usd": gas_usd, "route": exchanges}
    except Exception:
        return None

def detect_swap_intent(question: str) -> tuple[str, str, float] | None:
    """從問題解析 (from_token, to_token, amount)"""
    patterns = [
        (r"(\d+\.?\d*)\s*USDC.*?換.*?ETH",  "USDC", "ETH"),
        (r"(\d+\.?\d*)\s*ETH.*?換.*?weETH",  "ETH",  "weETH"),
        (r"(\d+\.?\d*)\s*weETH.*?換.*?ETH",  "weETH","ETH"),
        (r"USDC.*?換.*?ETH",                  "USDC", "ETH"),   # 無金額版本
        (r"ETH.*?換.*?weETH",                 "ETH",  "weETH"),
        (r"weETH.*?換.*?ETH",                 "weETH","ETH"),
    ]
    for pattern, src, dst in patterns:
        m = re.search(pattern, question, re.IGNORECASE)
        if m:
            try:
                amount = float(m.group(1))
            except (IndexError, ValueError):
                amount = 100.0 if src == "USDC" else 0.5
            return src, dst, amount
    return None

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


SYSTEM_PROMPT = (
    "你是一位區塊鏈協議技術文件助手，專門用繁體中文說明各協議的操作流程。"
    "請根據參考資料，條列說明操作步驟、每步驟涉及的網路手續費（Gas）數字，以及協議公開文件所載的年化數據。"
    "僅做技術流程說明，不提供任何個人化投資判斷。"
)


def _call_glm(messages: list) -> str:
    resp = requests.post(
        f"{ZAI_BASE_URL}/chat/completions",
        headers=_headers(),
        json={"model": "glm-4-flash", "messages": messages, "temperature": 0.3},
        timeout=60,
    )
    data = resp.json()
    # 內容審查觸發時 (code 1301)，改用更中性的措辭重試
    if not resp.ok:
        code = data.get("error", {}).get("code", "")
        if code == "1301":
            raise ValueError("CONTENT_FILTER")
        resp.raise_for_status()
    return data["choices"][0]["message"]["content"]


def generate_answer(question: str, context: str) -> str:
    user_msg = f"技術參考資料：\n{context}\n\n使用者查詢：{question}\n\n請條列操作步驟與相關費用數字。"
    try:
        answer = _call_glm([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ])
    except ValueError as e:
        if str(e) != "CONTENT_FILTER":
            raise
        # 內容審查觸發：改用純中性技術提問重試
        neutral_msg = f"請根據以下技術文件，說明操作流程與費用：\n\n{context}\n\n查詢：{question}"
        answer = _call_glm([
            {"role": "system", "content": "你是技術文件整理助手，用繁體中文條列說明操作步驟。"},
            {"role": "user", "content": neutral_msg},
        ])

    # 若回答完全沒有數字，補充費用提示重試一次
    if not any(c.isdigit() for c in answer):
        answer = _call_glm([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg + "\n（請務必包含 Gas 費用數字與年化數據）"},
        ])

    return answer


@app.post("/query")
async def query(req: QueryRequest):
    protocol = req.protocol.lower()
    question = req.question.strip()

    passages = KNOWLEDGE.get(protocol)
    if not passages:
        raise HTTPException(status_code=400, detail=f"不支援的協議：{req.protocol}，請選擇 etherfi / curve / hyperliquid")

    try:
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

        # Step 4: 注入即時 Paraswap 報價（若問題涉及兌換）
        context = "\n\n".join(top2)
        swap_intent = detect_swap_intent(question)
        if swap_intent:
            src, dst, amount = swap_intent
            quote = get_swap_quote(src, dst, amount)
            if quote:
                context = (
                    f"【即時報價 via Paraswap】\n"
                    f"{amount} {src} → {quote['dest_amount']} {dst}\n"
                    f"最佳路由：{quote['route']}\n"
                    f"預估 Gas：${quote['gas_usd']} USD\n\n"
                ) + context

        suggestion = generate_answer(question, context)

        return {"suggestion": suggestion}

    except requests.exceptions.HTTPError as e:
        body = {}
        try:
            body = e.response.json()
        except Exception:
            body = {"raw": e.response.text[:300]}
        raise HTTPException(status_code=502, detail=f"Z.AI API 錯誤 {e.response.status_code}: {body}")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Z.AI API 請求逾時，請稍後再試")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Cobo 執行交易 ─────────────────────────────────────────

class ExecuteRequest(BaseModel):
    dst_addr: str
    amount: str
    chain_id: str = "SETH"
    token_id: str = "SETH"


@app.post("/execute")
async def execute(req: ExecuteRequest):
    if not COBO_API_KEY or not COBO_WALLET_ID:
        raise HTTPException(status_code=500, detail="Cobo 憑證未設定")

    pact_spec = {
        "policies": [{
            "name": "allow-transfer",
            "type": "transfer",
            "rules": {
                "effect": "allow",
                "when": {
                    "chain_in": [req.chain_id],
                    "token_in": [{"chain_id": req.chain_id, "token_id": req.token_id}],
                },
            },
        }],
        "completion_conditions": [{"type": "tx_count", "threshold": "1"}],
    }

    try:
        async with WalletAPIClient(base_url=COBO_API_URL, api_key=COBO_API_KEY) as client:
            # 提交 pact（無配對時立即 active）
            pact_resp = await client.submit_pact(
                wallet_id=COBO_WALLET_ID,
                intent=f"NaviWeb3 transfer {req.amount} {req.token_id} to {req.dst_addr}",
                spec=pact_spec,
            )
            pact_id = pact_resp["pact_id"]

            # 輪詢等待 active（無配對約 1-3 秒）
            for _ in range(20):
                pact = await client.get_pact(pact_id)
                status = pact.get("status", "")
                if status == "active":
                    break
                if status in ("rejected", "expired", "revoked"):
                    raise HTTPException(status_code=400, detail=f"Pact 狀態異常：{status}")
                await asyncio.sleep(1)
            else:
                raise HTTPException(status_code=408, detail="Pact 等待逾時")

            # 用 pact-scoped key 執行交易
            async with WalletAPIClient(base_url=COBO_API_URL, api_key=pact["api_key"]) as pact_client:
                tx = await pact_client.transfer_tokens(
                    COBO_WALLET_ID,
                    chain_id=req.chain_id,
                    src_addr="0x1f066352df53d05737872598575cb6e828a77eec",
                    dst_addr=req.dst_addr,
                    token_id=req.token_id,
                    amount=req.amount,
                )

            return {
                "tx_id": tx.get("id"),
                "status": tx.get("status"),
                "request_id": tx.get("request_id"),
                "pact_id": pact_id,
            }

    except PolicyDeniedError as exc:
        raise HTTPException(status_code=403, detail=f"Policy 拒絕：{exc.denial.reason}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
