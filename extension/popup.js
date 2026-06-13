const API_URL   = 'http://localhost:8000/query';
const COBO_ADDR = '0x1f066352df53d05737872598575cb6e828a77eec';

let selectedProtocol = 'etherfi';
let walletContext    = '';
let cachedCoboBal    = 0;   // 後端讀取後快取，供快捷按鈕直接使用

// ── helpers ───────────────────────────────────────────────

function shortAddr(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ── 後端：讀取 Cobo 錢包餘額 ─────────────────────────────

async function loadCoboBalance() {
  const el = document.getElementById('coboBalance');
  try {
    const data = await fetch('http://localhost:8000/cobo-balance').then(r => r.json());
    const bal  = data.balance;
    cachedCoboBal = parseFloat(bal);

    // 頂部錢包列
    document.getElementById('walletStatus').textContent = `${shortAddr(COBO_ADDR)} · Sepolia (Cobo)`;
    document.getElementById('walletStatus').className   = 'wallet-status connected';
    document.getElementById('ethBal').textContent       = `${bal} SETH ★`;
    document.getElementById('weethBal').textContent     = '0.00';
    document.getElementById('usdcBal').textContent      = '0.00';
    document.getElementById('walletBalances').style.display = 'flex';
    document.getElementById('connectBtn').textContent   = '更新';
    document.getElementById('execUnit').textContent     = 'SETH';

    // 執行區塊餘額標示
    if (el) el.textContent = `Cobo 可用：${bal} SETH`;

    // 快捷按鈕固定顯示 ETH 操作
    updateQuickButtons('eth');

    walletContext = `Cobo 錢包：${shortAddr(COBO_ADDR)}，網路：Sepolia，持有 ${bal} SETH。`;
    return cachedCoboBal;
  } catch {
    if (el) el.textContent = 'Cobo 可用：讀取失敗';
    return null;
  }
}

// 啟動即讀取
loadCoboBalance();

// ── 更新按鈕 ──────────────────────────────────────────────

document.getElementById('connectBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectBtn');
  btn.disabled    = true;
  btn.textContent = '讀取中…';
  await loadCoboBalance();
  btn.disabled = false;
});

// ── 快捷操作按鈕 ──────────────────────────────────────────

const ACTIONS_BY_TOP = {
  eth: [
    { label: 'ETH → weETH', protocol: 'etherfi',      question: (s) => `我有 ${s} SETH，想質押成 weETH 賺利息，步驟和費用是？` },
    { label: 'ETH → USDC',  protocol: 'curve',        question: (s) => `我有 ${s} SETH，想換成 USDC 穩定幣，最划算路徑和費用？` },
    { label: '查看收益',     protocol: 'etherfi',      question: (s) => `我持有 ${s} SETH，各協議質押年化收益如何？哪個最划算？` },
    { label: 'Hyperliquid', protocol: 'hyperliquid',  question: (s) => `我有 ${s} SETH，怎麼存入 Hyperliquid 交易？步驟和費用？` },
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
    document.getElementById('question').value = action.question(cachedCoboBal || '?');
    document.getElementById('question').focus();
  });
});

// ── 自動偵測協議 ──────────────────────────────────────────

function detectProtocol(question) {
  const q = question.toLowerCase();
  if (/curve|usdc|usdt|dai|穩定幣|swap/.test(q))          return 'curve';
  if (/hyperliquid|hype|behype|perp|永續|槓桿/.test(q))   return 'hyperliquid';
  return 'etherfi';
}

// ── 清除 ──────────────────────────────────────────────────

document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('question').value = '';
  const box = document.getElementById('resultBox');
  box.textContent = '等待你的問題…';
  box.className   = 'result-box empty';
});

// ── 送出查詢（後端 /query） ───────────────────────────────

document.getElementById('submitBtn').addEventListener('click', async () => {
  const raw = document.getElementById('question').value.trim();
  if (!raw) return;

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
    box.className = 'result-box';
    box.textContent = data.suggestion || '（未收到回應）';

    // 顯示執行區塊，自動帶入 Cobo 地址
    document.getElementById('executeSection').style.display = 'block';
    document.getElementById('execAddr').value = COBO_ADDR;
    if (!document.getElementById('execAmount').value) {
      document.getElementById('execAmount').value = '0.001';
    }
    loadCoboBalance();
  } catch (e) {
    box.className = 'result-box';
    box.innerHTML = `<span class="error">⚠️ ${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('question').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('submitBtn').click();
  }
});

// ── Cobo 執行交易（後端 /execute） ────────────────────────

document.getElementById('executeBtn').addEventListener('click', async () => {
  const addr   = document.getElementById('execAddr').value.trim();
  const amount = document.getElementById('execAmount').value.trim();
  const result = document.getElementById('execResult');

  if (!addr || !amount) {
    result.style.color = '#f87171';
    result.textContent = '請填入地址與金額';
    return;
  }

  const btn = document.getElementById('executeBtn');
  btn.disabled    = true;
  btn.textContent = '送出中…';
  result.style.color = '#64748b';
  result.textContent = '等待 Cobo 確認…';

  try {
    // 先刷新餘額，確認夠用
    const coboBal = await loadCoboBalance();
    if (coboBal !== null && parseFloat(amount) > coboBal) {
      throw new Error(`Cobo 餘額不足（可用 ${coboBal} SETH，需要 ${amount} SETH）`);
    }

    const resp = await fetch('http://localhost:8000/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dst_addr: addr, amount, chain_id: 'SETH', token_id: 'SETH' }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

    result.style.color = '#34d399';
    result.textContent = '✅ 交易送出中，等待確認…';

    // 輪詢 tx hash（後端 /tx-status）
    const txId = data.tx_id;
    let hash = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const sd = await fetch(`http://localhost:8000/tx-status/${txId}`).then(r => r.json());
        if (sd.hash) { hash = sd.hash; break; }
      } catch (_) {}
    }

    loadCoboBalance(); // 交易後刷新餘額
    if (hash) {
      const url = `https://sepolia.etherscan.io/tx/${hash}`;
      result.innerHTML = `✅ 交易成功！<a href="${url}" target="_blank" style="color:#818cf8;text-decoration:underline;">在 Etherscan 查看 ↗</a>`;
    } else {
      const url = `https://sepolia.etherscan.io/address/${COBO_ADDR}`;
      result.innerHTML = `✅ 已送出！<a href="${url}" target="_blank" style="color:#818cf8;text-decoration:underline;">在 Etherscan 查看確認狀態 ↗</a>`;
    }
  } catch (e) {
    result.style.color = '#f87171';
    result.textContent = `⚠️ ${e.message}`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '⚡ 用 Cobo Wallet 執行交易';
  }
});
