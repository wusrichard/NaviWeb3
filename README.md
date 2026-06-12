# NaviWeb3

Chrome 瀏覽器擴充功能，在任何 DeFi 頁面詢問「weETH 怎麼換 ETH 最便宜？」，AI Agent 查知識庫給出操作路徑建議。

## Problem / Solution

| Problem | Solution |
|---|---|
| DeFi 新手不知道最佳操作路徑 | AI 顧問提供步驟化指引 |
| 手續費與 Gas 費難以估算 | 知識庫內建真實費用數字 |
| 各協議文件分散難查 | 一個 popup 統一入口 |

## Tech Stack

| 層 | 技術 |
|---|---|
| 前端 | Chrome Extension (Manifest V3), HTML/CSS/JS |
| 後端 | Python FastAPI |
| 語意搜尋 | Z.AI Embedding API (embedding-3) + NumPy cosine similarity |
| 重排序 | Z.AI Rerank API |
| 生成 | Z.AI GLM-4-Flash |

## 安裝步驟

**1. 後端**

```bash
cd backend
cp ../.env.example .env
# 編輯 .env 填入 ZAI_API_KEY
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**2. Chrome 擴充功能**

1. 開啟 Chrome → `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點擊「載入未封裝項目」→ 選擇 `extension/` 資料夾
4. 點擊工具列的 NaviWeb3 圖示即可使用

## Z.AI API 說明

| API | 用途 | Model |
|---|---|---|
| Embeddings | 將問題與知識庫段落向量化 | `embedding-3` |
| Rerank | 對 top-5 候選段落重新排序，選出最相關 2 篇 | `rerank` |
| Chat Completions | 根據 2 篇參考資料生成繁體中文建議 | `glm-4-flash` |

Base URL: `https://open.bigmodel.cn/api/paas/v4`

## Hackathon 賽道說明

**Z.AI 賽道 · Long-Horizon Task**

本專案展示 AI Agent 執行多步驟長程任務的能力：
1. 語意理解用戶意圖（Embedding）
2. 從知識庫精準檢索（Cosine Similarity）
3. 重排序確保最相關結果（Rerank）
4. 生成有具體數字的操作建議（GLM-4-Flash）

四個 AI 步驟串接為單一流暢的用戶體驗，無需用戶手動查詢文件。
