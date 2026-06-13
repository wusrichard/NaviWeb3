# NaviWeb3

Chrome 擴充功能，讀取你的錢包持倉，透過 AI 查詢即時兌換報價，給出具體 DeFi 操作步驟。

## Problem / Solution

| Problem | Solution |
|---|---|
| 不知道 USDC 換 ETH 哪邊最便宜 | 串接 Paraswap API 即時比較路由與 Gas |
| DeFi 操作步驟複雜、費用難估算 | AI 根據真實持倉給出具體步驟與數字 |
| 每次都要手動查詢、手動輸入 | 快捷按鈕一鍵帶入持倉自動查詢 |

## Tech Stack

| 層 | 技術 |
|---|---|
| 前端 | Chrome Extension (Manifest V3) |
| 後端 | Python FastAPI |
| 即時報價 | Paraswap Aggregation API（免費，無需 key） |
| 語意搜尋 | Z.AI Embedding API (embedding-3) + cosine similarity |
| 重排序 | Z.AI Rerank API |
| 生成 | Z.AI GLM-4-Flash |
| 錢包讀取 | MetaMask / Rabby `window.ethereum` |

---

## 安裝步驟

### 1. 後端

```bash
git clone https://github.com/wusrichard/NaviWeb3.git
cd NaviWeb3/backend

# 建立虛擬環境（需要 Python 3.11+）
python3 -m venv .venv && source .venv/bin/activate

# 安裝依賴
pip install -r requirements.txt

# 設定 API Key
cp ../.env.example .env
# 編輯 .env，填入你的 Z.AI API Key：
# ZAI_API_KEY=your_key_here

# 啟動 server
uvicorn main:app --port 8000 --reload
```

### 2. Chrome 擴充功能

1. 開啟 Chrome，網址列輸入 `chrome://extensions`
2. 右上角開啟「**開發人員模式**」
3. 點「**載入未封裝項目**」→ 選擇專案內的 `extension/` 資料夾
4. 工具列出現 🧭 NaviWeb3 圖示即完成

> 每次開瀏覽器後，需先啟動後端 server，插件才能正常運作。

---

## 操作示範流程

### Step 1：連接錢包

1. 確保 MetaMask 或 Rabby 已安裝並解鎖
2. 開啟任意 https:// 網站（例如 `https://app.ether.fi`）
3. 點擊工具列 🧭 NaviWeb3 圖示
4. 點「**連接錢包**」→ 在錢包彈窗中授權

連接成功後，頂部顯示：
```
0xAbcd...1234 · Ethereum     ETH: 0.5231   weETH: 0.3000   USDC: 150.00
```

### Step 2：使用快捷按鈕

點任一快捷按鈕，自動帶入你的實際持倉：

| 按鈕 | 自動填入內容 |
|---|---|
| USDC → ETH | 我有 150.00 USDC，想換成 ETH，透過 Curve 最划算的路徑是？ |
| ETH → weETH | 我有 0.5231 ETH，想質押成 weETH 賺利息，步驟和費用是？ |
| weETH → ETH | 我有 0.3000 weETH，想換回 ETH，最快路徑和費用是？ |
| 查看收益 | 我持有 0.5231 ETH 和 0.3000 weETH，各協議年化收益如何？ |

### Step 3：送出查詢

按 **Enter** 或點「詢問 AI 顧問」，AI 回應包含：

- 📊 **Paraswap 即時報價**：實際換出數量、最佳路由、Gas 費用
- 📋 **具體操作步驟**：逐步說明，附每步費用數字
- 💰 **預期年化收益**：各協議 APY 比較

**範例回應：**
```
【即時報價 via Paraswap】
150 USDC → 0.04821 ETH
最佳路由：Uniswap V3 → Curve
預估 Gas：$3.42 USD

操作步驟：
① 前往 curve.fi，選擇 USDC/ETH 池...
② 輸入 150 USDC，確認滑點 < 0.1%...
③ 確認交易，Gas 費約 $3-5 USD...
```

### Step 4：自訂問題

也可以直接輸入問題，AI 自動偵測協議：
- 提到 USDC / Curve / swap → 選 Curve
- 提到 Hyperliquid / HYPE / 永續 → 選 Hyperliquid
- 其他 → 預設 EtherFi

---

## Z.AI API 說明

| API | 用途 | Model |
|---|---|---|
| Embeddings | 問題與知識庫段落向量化 | `embedding-3` |
| Rerank | Top-5 候選段落重排序，選出最相關 2 篇 | `rerank` |
| Chat Completions | 根據即時報價 + 知識庫生成操作說明 | `glm-4-flash` |

Base URL：`https://open.bigmodel.cn/api/paas/v4`

---

## Hackathon 賽道說明

**Z.AI 賽道 · Long-Horizon Task**

NaviWeb3 展示 AI Agent 執行多步驟長程任務：

1. 透過 `window.ethereum` 讀取用戶實際持倉
2. Paraswap API 即時查詢最佳兌換路由
3. Z.AI Embedding 語意搜尋知識庫
4. Z.AI Rerank 精選最相關段落
5. Z.AI GLM-4-Flash 整合即時數據 + 知識庫，生成具體操作建議

五個步驟串成單一流暢體驗，從「我有多少幣」到「我該怎麼操作」一鍵完成。
