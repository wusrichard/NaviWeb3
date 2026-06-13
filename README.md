# NaviWeb3

> **一句話簡介**：Chrome 擴充功能，讀取你的 MetaMask / Rabby 持倉，即時查詢最佳兌換路由，用 AI 生成具體 DeFi 操作步驟。

---

## 項目背景

DeFi 用戶每次操作都需要：
1. 手動查詢各平台匯率（Curve / Uniswap / 1inch）
2. 估算 Gas 費
3. 搜尋操作步驟文件

NaviWeb3 把這三步壓縮成一個動作：打開插件、點快捷按鈕、30 秒內拿到含真實報價的操作指南。

## 目標用戶

- DeFi 新手：不知道怎麼把 USDC 換成 ETH 最划算
- 中級用戶：每次操作都要切換多個平台比較費率
- 任何持有 weETH / USDC 的錢包用戶

---

## 核心功能

| 功能 | 說明 |
|---|---|
| 🔗 讀取錢包持倉 | 透過 `window.ethereum` 讀取 ETH / weETH / USDC 餘額，持久化存儲 |
| ⚡ 快捷操作按鈕 | 一鍵帶入持倉，自動填入查詢（USDC→ETH、ETH→weETH 等） |
| 📊 即時報價 | 串接 Paraswap Aggregation API，回傳最佳路由與 Gas 費用 |
| 🤖 AI 步驟說明 | Z.AI GLM-4-Flash 根據即時報價 + 知識庫生成繁體中文操作步驟 |
| 🔍 語意搜尋 | Z.AI Embedding + Rerank 從 DeFi 知識庫精選最相關段落 |

---

## 技術架構

```
你的 MetaMask / Rabby                    Cobo Agentic Wallet
(用戶錢包，read-only)                    (0x1f066352...，執行層)
        │                                        │
        │ window.ethereum                        │ Cobo SDK
        │ 讀取 ETH / weETH / USDC 餘額           │ 發出鏈上交易
        ▼                                        ▼
┌─────────────────────────────────────────────────────┐
│            Chrome Extension (popup.js)              │
│   連接錢包 → 快捷按鈕 → 填入問題 → 執行交易           │
└──────────────────────┬──────────────────────────────┘
                       │ fetch POST /query 或 /execute
                       ▼
              FastAPI (backend/main.py)
                       │
         ┌─────────────┼──────────────────┐
         ▼             ▼                  ▼
   Paraswap API    Z.AI Embedding      Cobo Agentic
   即時兌換報價     問題向量化           Wallet API
   最佳路由+Gas         ↓               提交 Pact →
                  Cosine Similarity     等待確認 →
                  知識庫 Top-5          廣播交易 →
                         ↓              Etherscan ↗
                  Z.AI Rerank
                  精選 Top-2
                         ↓
                  GLM-4-Flash
                  生成操作建議
```

## 使用的 API / SDK / AI 工具

| 工具 | 用途 |
|---|---|
| Z.AI Embedding (`embedding-3`) | 語意搜尋知識庫 |
| Z.AI Rerank | 重排序候選段落 |
| Z.AI GLM-4-Flash | 生成中文操作建議 |
| Paraswap Aggregation API | 即時兌換報價（免費，無需 API Key）|
| MetaMask / Rabby `window.ethereum` | 讀取用戶錢包餘額 |
| Claude Code | 輔助開發 |

---

## 安裝與運行

### 環境需求
- Python 3.11+
- Chrome 瀏覽器 + MetaMask 或 Rabby 錢包

### 後端

```bash
git clone https://github.com/wusrichard/NaviWeb3.git
cd NaviWeb3/backend

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp ../.env.example .env
# 編輯 .env，填入 Z.AI API Key：ZAI_API_KEY=your_key_here

uvicorn main:app --port 8000 --reload
```

### Chrome 擴充功能

1. `chrome://extensions` → 開啟「開發人員模式」
2. 「載入未封裝項目」→ 選擇 `extension/` 資料夾
3. 工具列出現 🧭 NaviWeb3 圖示即完成

---

## 操作示範流程

**Step 1** — 開啟任意 https:// 網站（如 `https://app.ether.fi`），點插件 → 「連接錢包」

**Step 2** — 頂部顯示持倉：`0xAbcd...1234 · Ethereum｜ETH: 0.52｜weETH: 0.30｜USDC: 150`

**Step 3** — 點快捷按鈕「USDC → ETH」，自動填入問題（含真實持倉數字）

**Step 4** — 按 Enter，30 秒內收到：

```
【即時報價 via Paraswap】
150 USDC → 0.04821 ETH
最佳路由：Uniswap V3 → Curve
預估 Gas：$3.42 USD

操作步驟：
① 前往 curve.fi，選擇 USDC → ETH 兌換...
② 確認滑點 < 0.1%，Gas 費約 $3-5 USD...
③ 點擊 Swap，在 MetaMask 確認交易...
```

---

## 鏈上 / 測試網證據

| 項目 | 值 |
|---|---|
| Cobo Agentic Wallet 地址 | `0x1f066352df53d05737872598575cb6e828a77eec` |
| Wallet UUID | `2f654afd-3a9e-4029-9212-e79350f8b1e5` |
| 測試網路 | Sepolia Testnet (Chain ID: 11155111) |
| 鏈上交易（已確認） | [`0xa83ab3...a28b93`](https://sepolia.etherscan.io/tx/0xa83ab328e0fefb18468d3627841c1008fa2d571b53530e5664f26837f3a28b93) |
| Paraswap API 查詢 | 每次插件查詢即發生鏈上報價請求（Ethereum Mainnet 路由） |

---

## 當前完成度

| 功能 | 狀態 |
|---|---|
| Chrome 擴充功能 UI | ✅ 完成 |
| 錢包餘額讀取（ETH/weETH/USDC） | ✅ 完成 |
| 快捷操作按鈕 | ✅ 完成 |
| Paraswap 即時報價 | ✅ 完成 |
| Z.AI RAG 流程 | ✅ 完成 |
| 持倉持久化（chrome.storage） | ✅ 完成 |
| Demo 影片 | 🔜 錄製中 |
| 主網實際交易 | 🔜 後續計劃 |

## 後續計劃

1. **串接 1inch 路由比較**：多個聚合器並排比較，讓用戶選最優解
2. **一鍵發起交易**：生成 calldata 直接在 MetaMask / Rabby 發起，不需要跳轉網站
3. **Rabby eth_call 模擬**：送出前先模擬執行，顯示預期結果與失敗風險
4. **多鏈支援**：Base、Arbitrum 的 USDC 路由
5. **Cobo Agentic Wallet 整合**：自動化定期再平衡，搭配策略審批流程

---

## 合規聲明

- 本項目於本次 Hackathon 期間完成
- 使用 Sepolia 測試網，未涉及真實資產自動操作
- 所有鏈上操作需用戶在錢包手動確認，插件不持有任何私鑰
- 第三方工具：Z.AI API、Paraswap API（開放免費使用）、Claude Code（輔助開發）

---

## 團隊資訊

| 成員 | 角色 | 聯絡 |
|---|---|---|
| Yufu Wu | 全端開發 | yufu.wu@gyro.com.tw |

錢包地址：`0x1f066352df53d05737872598575cb6e828a77eec`（Sepolia）
