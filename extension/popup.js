// ── 常數 ──────────────────────────────────────────────────
// BASE_URL 統一管理，切換環境只改這一行
const BASE_URL  = 'http://localhost:8000';
const API_URL   = `${BASE_URL}/query`;
const COBO_ADDR = '0x1f066352df53d05737872598575cb6e828a77eec'; // Cobo 錢包（發送方）

// ── 狀態 ──────────────────────────────────────────────────
let selectedProtocol = 'etherfi';
let walletContext    = '';
let cachedCoboBal    = null; // null 表示尚未載入，避免誤顯示 0

// ── helpers ───────────────────────────────────────────────

function shortAddr(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// 驗證 Ethereum 地址格式（0x + 40 hex）
function isValidAddr(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// 驗證 tx hash 格式（0x + 64 hex），防止 XSS
function isValidTxHash(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

// ── 後端：讀取 Cobo 錢包餘額 → /cobo-balance ─────────────
// 同時更新頂部狀態列與執行區塊的餘額標示

async function loadCoboBalance() {
  const el  = document.getElementById('coboBalance');
  const btn = document.getElementById('connectBtn');
  try {
    const data = await fetch(`${BASE_URL}/cobo-balance`).then(r => r.json());
    const bal  = data.balance;
    cachedCoboBal = parseFloat(bal);

    // 頂部錢包列
    document.getElementById('walletStatus').textContent     = `${shortAddr(COBO_ADDR)} · Sepolia (Cobo)`;
    document.getElementById('walletStatus').className       = 'wallet-status connected';
    document.getElementById('ethBal').textContent           = `${bal} SETH ★`;
    document.getElementById('weethBal').textContent         = '0.00';
    document.getElementById('usdcBal').textContent          = '0.00';
    document.getElementById('walletBalances').style.display = 'flex';
    document.getElementById('execUnit').textContent         = 'SETH';

    // 執行區塊餘額提示
    if (el) el.textContent = `Cobo 可用：${bal} SETH`;

    // 快捷按鈕固定對應 ETH（Cobo 目前只持有 SETH）
    updateQuickButtons('eth');

    // 傳給 AI 的錢包背景文字
    walletContext = `Cobo 錢包：${shortAddr(COBO_ADDR)}，網路：Sepolia，持有 ${bal} SETH。`;

    btn.textContent = '更新';
    return cachedCoboBal;
  } catch {
    if (el) el.textContent = 'Cobo 可用：讀取失敗';
    btn.textContent = '重試'; // 失敗時重置按鈕文字
    return null;
  }
}

// 啟動即讀取，顯示初始餘額
loadCoboBalance();

// ── 更新按鈕：重新讀取 Cobo 餘額 ─────────────────────────

document.getElementById('connectBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectBtn');
  btn.disabled    = true;
  btn.textContent = '讀取中…';
  await loadCoboBalance();
  btn.disabled = false;
});

// ── 快捷操作按鈕 ──────────────────────────────────────────
// 每個 action 帶入 Cobo 當前 SETH 餘額，自動填入問題

const ACTIONS_BY_TOP = {
  eth: [
    { label: 'ETH → weETH', protocol: 'etherfi',     question: (s) => `我有 ${s} SETH，想質押成 weETH 賺利息，步驟和費用是？` },
    { label: 'ETH → USDC',  protocol: 'curve',       question: (s) => `我有 ${s} SETH，想換成 USDC 穩定幣，最划算路徑和費用？` },
    { label: '查看收益',    protocol: 'etherfi',      question: (s) => `我持有 ${s} SETH，各協議質押年化收益如何？哪個最划算？` },
    { label: 'Hyperliquid', protocol: 'hyperliquid', question: (s) => `我有 ${s} SETH，怎麼存入 Hyperliquid 交易？步驟和費用？` },
  ],
};

let currentTopToken = 'eth';

function updateQuickButtons(topToken) {
  currentTopToken = topToken;
  const actions = ACTIONS_BY_TOP[topToken] || ACTIONS_BY_TOP['eth'];
  document.querySelectorAll('.quick-btn').forEach((btn, i) => {
    if (actions[i]) btn.textContent = actions[i].label;
  });
}

document.querySelectorAll('.quick-btn').forEach((btn, i) => {
  btn.addEventListener('click', () => {
    const action = (ACTIONS_BY_TOP[currentTopToken] || ACTIONS_BY_TOP['eth'])[i];
    if (!action) return;
    selectedProtocol = action.protocol;
    // 餘額未載入時顯示佔位符，避免誤導
    const balStr = cachedCoboBal !== null ? cachedCoboBal : '?';
    document.getElementById('question').value = action.question(balStr);
    document.getElementById('question').focus();
  });
});

// ── 根據問題關鍵字自動偵測協議 ───────────────────────────

function detectProtocol(question) {
  const q = question.toLowerCase();
  if (/curve|usdc|usdt|dai|穩定幣|swap/.test(q))        return 'curve';
  if (/hyperliquid|hype|behype|perp|永續|槓桿/.test(q)) return 'hyperliquid';
  return 'etherfi'; // 預設
}

// ── 清除按鈕 ──────────────────────────────────────────────

document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('question').value = '';
  const box = document.getElementById('resultBox');
  box.textContent = '等待你的問題…';
  box.className   = 'result-box empty';
});

// ── 送出查詢 → 後端 /query（RAG + Paraswap 報價） ────────

document.getElementById('submitBtn').addEventListener('click', async () => {
  const raw = document.getElementById('question').value.trim();
  if (!raw) return;

  // 將錢包背景拼入問題，讓 AI 知道持倉
  const question = walletContext ? `${walletContext} ${raw}` : raw;
  selectedProtocol = detectProtocol(raw);

  const btn = document.getElementById('submitBtn');
  const box = document.getElementById('resultBox');
  btn.disabled  = true;
  box.className = 'result-box';
  box.innerHTML = '<div class="loading"><div class="spinner"></div>AI 顧問思考中…</div>';

  try {
    const resp = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ protocol: selectedProtocol, question }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    box.className   = 'result-box';
    box.textContent = data.suggestion || '（未收到回應）';

    // 顯示執行區塊；execAddr 留空讓使用者填目標地址（Cobo 是 src，不預填）
    document.getElementById('executeSection').style.display = 'block';
    document.getElementById('execAddr').value = '';
    if (!document.getElementById('execAmount').value) {
      document.getElementById('execAmount').value = '0.001';
    }
    loadCoboBalance(); // 顯示執行區塊時同步刷新餘額
  } catch (e) {
    box.className = 'result-box';
    box.innerHTML = `<span class="error">⚠️ ${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// Enter 快速送出（Shift+Enter 換行）
document.getElementById('question').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('submitBtn').click();
  }
});

// ── 執行交易 → 後端 /execute（Cobo Agentic Wallet） ──────

document.getElementById('executeBtn').addEventListener('click', async () => {
  const addr   = document.getElementById('execAddr').value.trim();
  const amount = document.getElementById('execAmount').value.trim();
  const result = document.getElementById('execResult');
  const btn    = document.getElementById('executeBtn');

  // ── 前端驗證 ──────────────────────────────────────────
  if (!addr || !amount) {
    result.style.color = '#f87171';
    result.textContent = '請填入地址與金額';
    return;
  }
  // 驗證 Ethereum 地址格式
  if (!isValidAddr(addr)) {
    result.style.color = '#f87171';
    result.textContent = '地址格式錯誤（需為 0x 開頭的 42 字元）';
    return;
  }
  // 驗證金額為正數
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    result.style.color = '#f87171';
    result.textContent = '請輸入有效的正數金額';
    return;
  }

  btn.disabled    = true;
  btn.textContent = '送出中…';
  result.style.color = '#64748b';
  result.textContent = '等待 Cobo 確認…';

  try {
    // 先刷新餘額，確認 Cobo 錢包有足夠 SETH
    const coboBal = await loadCoboBalance();
    if (coboBal !== null && parsedAmount > coboBal) {
      throw new Error(`Cobo 餘額不足（可用 ${coboBal} SETH，需要 ${amount} SETH）`);
    }

    // 送出交易請求
    const resp = await fetch(`${BASE_URL}/execute`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dst_addr: addr, amount, chain_id: 'SETH', token_id: 'SETH' }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

    result.style.color = '#34d399';
    result.textContent = '✅ 交易送出中，等待確認…';

    // 輪詢 /tx-status 取得 transaction_hash（最多等 60 秒）
    const txId = data.tx_id;
    let hash = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const sd = await fetch(`${BASE_URL}/tx-status/${txId}`).then(r => r.json());
        if (sd.hash) { hash = sd.hash; break; }
      } catch (_) {}
    }

    loadCoboBalance(); // 交易完成後刷新餘額

    if (hash && isValidTxHash(hash)) {
      // hash 格式驗證後才插入 DOM，防止 XSS
      const url = `https://sepolia.etherscan.io/tx/${hash}`;
      const a   = document.createElement('a');
      a.href        = url;
      a.target      = '_blank';
      a.style.cssText = 'color:#818cf8;text-decoration:underline;';
      a.textContent = '在 Etherscan 查看 ↗';
      result.innerHTML = '';
      result.append('✅ 交易成功！', a);
    } else {
      // hash 未到或格式異常，連到錢包地址頁讓使用者自行確認
      const url = `https://sepolia.etherscan.io/address/${COBO_ADDR}`;
      const a   = document.createElement('a');
      a.href        = url;
      a.target      = '_blank';
      a.style.cssText = 'color:#818cf8;text-decoration:underline;';
      a.textContent = '在 Etherscan 查看確認狀態 ↗';
      result.innerHTML = '';
      result.append('✅ 已送出！', a);
    }
  } catch (e) {
    result.style.color = '#f87171';
    result.textContent = `⚠️ ${e.message}`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '⚡ 用 Cobo Wallet 執行交易';
  }
});
