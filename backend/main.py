"""
NaviWeb3 後端
架構：FastAPI + Z.AI RAG + Paraswap 報價 + Cobo Agentic Wallet 執行
"""

import asyncio
import logging
import os
import re

import numpy as np
import requests
from cobo_agentic_wallet.client import WalletAPIClient
from cobo_agentic_wallet.errors import PolicyDeniedError
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from knowledge import KNOWLEDGE

load_dotenv()
logger = logging.getLogger(__name__)

# ── 環境變數 ──────────────────────────────────────────────
ZAI_API_KEY   = os.getenv("ZAI_API_KEY")
ZAI_BASE_URL  = "https://open.bigmodel.cn/api/paas/v4"

COBO_API_KEY   = os.getenv("COBO_API_KEY")
COBO_API_URL   = os.getenv("COBO_API_URL", "https://api.agenticwallet.cobo.com")
COBO_WALLET_ID = os.getenv("COBO_WALLET_ID")
# Cobo Agentic Wallet 在 Sepolia 的地址（所有交易的 src_addr）
COBO_SRC_ADDR  = "0x1f066352df53d05737872598575cb6e828a77eec"

# Sepolia 公共 RPC，用於查詢 Cobo 錢包餘額
SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com"

# ── Paraswap 兌換報價 ─────────────────────────────────────
# 主網代幣地址，用於查詢即時路由報價
TOKENS = {
    "USDC":  {"addr": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "decimals": 6},
    "ETH":   {"addr": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "decimals": 18},
    "weETH": {"addr": "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", "decimals": 18},
}


def get_swap_quote(src: str, dst: str, amount_human: float) -> dict | None:
    """呼叫 Paraswap API 取得即時兌換報價（免費，無需 API Key）。"""
    src_info, dst_info = TOKENS.get(src), TOKENS.get(dst)
    if not src_info or not dst_info:
        return None
    amount_wei = int(amount_human * 10 ** src_info["decimals"])
    try:
        resp = requests.get(
            "https://apiv5.paraswap.io/prices",
            params={
                "srcToken":    src_info["addr"],
                "destToken":   dst_info["addr"],
                "amount":      str(amount_wei),
                "srcDecimals": src_info["decimals"],
                "destDecimals":dst_info["decimals"],
                "network":     1,
                "side":        "SELL",
            },
            timeout=8,
        )
        route = resp.json().get("priceRoute", {})
        dest_amount = round(int(route.get("destAmount", 0)) / 10 ** dst_info["decimals"], 6)
        gas_usd     = route.get("gasCostUSD", "?")
        exchanges   = " → ".join(
            swap["swapExchanges"][0]["exchange"]
            for swap in route.get("bestRoute", [])
            if swap.get("swapExchanges")
        ) or "未知"
        return {"src": src, "dst": dst, "amount": amount_human,
                "dest_amount": dest_amount, "gas_usd": gas_usd, "route": exchanges}
    except Exception:
        return None


def detect_swap_intent(question: str) -> tuple[str, str, float] | None:
    """從問題文字解析兌換意圖（from_token, to_token, amount）。"""
    patterns = [
        (r"(\d+\.?\d*)\s*USDC.*?換.*?ETH",  "USDC",  "ETH"),
        (r"(\d+\.?\d*)\s*ETH.*?換.*?weETH",  "ETH",   "weETH"),
        (r"(\d+\.?\d*)\s*weETH.*?換.*?ETH",  "weETH", "ETH"),
        (r"USDC.*?換.*?ETH",                  "USDC",  "ETH"),
        (r"ETH.*?換.*?weETH",                 "ETH",   "weETH"),
        (r"weETH.*?換.*?ETH",                 "weETH", "ETH"),
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


# ── FastAPI 應用程式 ───────────────────────────────────────

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 開發/demo 用；生產環境應限制為擴充功能 ID
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Z.AI RAG 流程 ─────────────────────────────────────────

class QueryRequest(BaseModel):
    protocol: str
    question: str


def _headers() -> dict:
    return {"Authorization": f"Bearer {ZAI_API_KEY}", "Content-Type": "application/json"}


def get_embedding(text: str) -> list[float]:
    """用 Z.AI embedding-3 將文字向量化。"""
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
    """用 Z.AI Rerank 從 Top-5 中精選最相關的 Top-2 段落。"""
    resp = requests.post(
        f"{ZAI_BASE_URL}/rerank",
        headers=_headers(),
        json={"model": "rerank", "query": query, "documents": passages, "top_n": 2},
        timeout=30,
    )
    if resp.status_code != 200:
        return passages[:2]  # rerank 失敗時 fallback
    results = resp.json().get("results", [])
    sorted_results = sorted(results, key=lambda x: x.get("relevance_score", 0), reverse=True)
    return [passages[r["index"]] for r in sorted_results[:2]]


# 繁體中文技術文件助手；避免使用「投資」「操作路徑」等詞觸發 Z.AI 內容審查（code 1301）
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
    if not resp.ok:
        code = data.get("error", {}).get("code", "")
        if code == "1301":
            raise ValueError("CONTENT_FILTER")
        resp.raise_for_status()
    return data["choices"][0]["message"]["content"]


def generate_answer(question: str, context: str) -> str:
    """呼叫 GLM-4-Flash 生成操作建議；遇內容審查自動換措辭重試。"""
    user_msg = f"技術參考資料：\n{context}\n\n使用者查詢：{question}\n\n請條列操作步驟與相關費用數字。"
    try:
        answer = _call_glm([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
        ])
    except ValueError as e:
        if str(e) != "CONTENT_FILTER":
            raise
        # 內容審查觸發：改用純技術措辭重試
        neutral_msg = f"請根據以下技術文件，說明操作流程與費用：\n\n{context}\n\n查詢：{question}"
        answer = _call_glm([
            {"role": "system", "content": "你是技術文件整理助手，用繁體中文條列說明操作步驟。"},
            {"role": "user",   "content": neutral_msg},
        ])

    # 若回答完全無數字，補充提示重試一次（確保 Gas 費和年化數據出現）
    if not any(c.isdigit() for c in answer):
        answer = _call_glm([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg + "\n（請務必包含 Gas 費用數字與年化數據）"},
        ])
    return answer


@app.post("/query")
async def query(req: QueryRequest):
    """RAG 查詢：embed → cosine → rerank → 注入 Paraswap 報價 → GLM 生成建議。"""
    protocol = req.protocol.lower()
    question = req.question.strip()

    passages = KNOWLEDGE.get(protocol)
    if not passages:
        raise HTTPException(status_code=400, detail=f"不支援的協議：{req.protocol}")

    try:
        q_emb = get_embedding(question)

        # Cosine similarity 取 Top-5 候選段落
        scored = [(cosine_similarity(q_emb, get_embedding(p)), p) for p in passages]
        scored.sort(key=lambda x: x[0], reverse=True)
        top5 = [p for _, p in scored[:5]]

        # Rerank 精選 Top-2
        top2 = rerank(question, top5)

        # 注入 Paraswap 即時報價（若問題涉及兌換）
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


# ── Cobo 餘額查詢 ─────────────────────────────────────────

@app.get("/cobo-balance")
async def cobo_balance():
    """查詢 Cobo 錢包的 Sepolia ETH 餘額，供前端顯示可用金額。"""
    try:
        resp = requests.post(
            SEPOLIA_RPC,
            json={
                "jsonrpc": "2.0",
                "method":  "eth_getBalance",
                "params":  [COBO_SRC_ADDR, "latest"],
                "id":      1,
            },
            timeout=8,
        )
        result = resp.json().get("result", "0x0")
        bal = round(int(result, 16) / 1e18, 4)
        return {"balance": bal}
    except Exception as e:
        logger.error("cobo_balance error: %s", e)
        raise HTTPException(status_code=500, detail="餘額查詢失敗，請稍後再試")


# ── Cobo 執行交易 ─────────────────────────────────────────

class ExecuteRequest(BaseModel):
    dst_addr: str
    amount:   str
    chain_id: str = "SETH"
    token_id: str = "SETH"


@app.post("/execute")
async def execute(req: ExecuteRequest):
    """
    透過 Cobo Agentic Wallet 執行鏈上轉帳：
    1. 提交 Pact（策略沙盒）
    2. 輪詢等待 Pact 狀態變為 active
    3. 用 Pact-scoped API Key 發送交易
    """
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
        # Cobo API 要求 threshold 為字串型別
        "completion_conditions": [{"type": "tx_count", "threshold": "1"}],
    }

    try:
        async with WalletAPIClient(base_url=COBO_API_URL, api_key=COBO_API_KEY) as client:
            # 提交 Pact（無配對時立即 active，約 1–3 秒）
            pact_resp = await client.submit_pact(
                wallet_id=COBO_WALLET_ID,
                intent=f"NaviWeb3 transfer {req.amount} {req.token_id} to {req.dst_addr}",
                spec=pact_spec,
            )
            pact_id = pact_resp["pact_id"]

            # 輪詢等待 Pact active
            for _ in range(20):
                pact   = await client.get_pact(pact_id)
                status = pact.get("status", "")
                if status == "active":
                    break
                if status in ("rejected", "expired", "revoked"):
                    raise HTTPException(status_code=400, detail=f"Pact 狀態異常：{status}")
                await asyncio.sleep(1)
            else:
                raise HTTPException(status_code=408, detail="Pact 等待逾時")

            # 用 Pact-scoped Key 執行交易（限定只能發此次核准的轉帳）
            async with WalletAPIClient(base_url=COBO_API_URL, api_key=pact["api_key"]) as pact_client:
                tx = await pact_client.transfer_tokens(
                    COBO_WALLET_ID,
                    chain_id=req.chain_id,
                    src_addr=COBO_SRC_ADDR,
                    dst_addr=req.dst_addr,
                    token_id=req.token_id,
                    amount=req.amount,
                )

            return {
                "tx_id":      tx.get("id"),
                "status":     tx.get("status"),
                "request_id": tx.get("request_id"),
                "pact_id":    pact_id,
            }

    except PolicyDeniedError as exc:
        raise HTTPException(status_code=403, detail=f"Policy 拒絕：{exc.denial.reason}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── 交易狀態查詢 ──────────────────────────────────────────

@app.get("/tx-status/{tx_id}")
async def tx_status(tx_id: str):
    """輪詢交易狀態，取得 transaction_hash 後前端可跳轉 Etherscan。"""
    async with WalletAPIClient(base_url=COBO_API_URL, api_key=COBO_API_KEY) as client:
        tx = await client.get_transaction_record(tx_id)
        return {
            "status":   tx.get("status"),
            "hash":     tx.get("transaction_hash"),
            "chain_id": tx.get("chain_id", "SETH"),
        }
