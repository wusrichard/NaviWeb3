const API_URL = 'http://localhost:8000/query';
let selectedProtocol = 'etherfi';
let walletContext = '';

const CHAIN_NAMES = { 1: 'Ethereum', 11155111: 'Sepolia', 8453: 'Base', 42161: 'Arbitrum' };
const WEETH_ADDR = { 1: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee' };
const USDC_ADDR  = { 1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' };

// ── UI helpers ────────────────────────────────────────────

function shortAddr(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function applyWalletUI(w) {
  const chainName = CHAIN_NAMES[w.chainId] || `Chain ${w.chainId}`;
  const isTestnet = w.chainId === 11155111;
  const ethUnit = isTestnet ? 'SETH' : 'ETH';

  // 找最高餘額的 token，加星號標示
  const balances = [
    { id: 'ethBal',   val: parseFloat(w.ethBalance),   unit: ethUnit },
    { id: 'weethBal', val: parseFloat(w.weETHBalance), unit: 'weETH' },
    { id: 'usdcBal',  val: parseFloat(w.usdcBalance),  unit: 'USDC' },
  ];
  const maxIdx = balances.reduce((m, b, i) => b.val > balances[m].val ? i : m, 0);

  document.getElementById('walletStatus').textContent = `${shortAddr(w.address)} · ${chainName}`;
  document.getElementById('walletStatus').className = 'wallet-status connected';
  document.getElementById('ethBal').textContent = `${w.ethBalance} ${ethUnit}${maxIdx === 0 ? ' ★' : ''}`;
  document.getElementById('weethBal').textContent = `${w.weETHBalance}${maxIdx === 1 ? ' ★' : ''}`;
  document.getElementById('usdcBal').textContent = `${w.usdcBalance}${maxIdx === 2 ? ' ★' : ''}`;
  document.getElementById('walletBalances').style.display = 'flex';
  document.getElementById('connectBtn').textContent = '更新';

  // 執行區塊的單位同步
  document.getElementById('execUnit').textContent = ethUnit;

  // 更新快捷按鈕對應最多資產
  const topKey = ['eth', 'weeth', 'usdc'][maxIdx];
  updateQuickButtons(topKey);

  walletContext = `我的錢包：${shortAddr(w.address)}，網路：${chainName}，持有 ${w.ethBalance} ${ethUnit}、${w.weETHBalance} weETH、${w.usdcBalance} USDC。最多資產：${balances[maxIdx].val} ${balances[maxIdx].unit}。`;
}

// ── 啟動時還原已存的錢包狀態 ──────────────────────────────

chrome.storage.local.get(['wallet'], ({ wallet }) => {
  if (wallet) applyWalletUI(wallet);
});


// ── 從頁面讀取錢包 ────────────────────────────────────────

async function readWalletFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('無法取得目前頁面');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (weethAddrs, usdcAddrs) => {
      if (!window.ethereum) return { error: '未偵測到 MetaMask / Rabby' };
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const address = accounts[0];
        const ethHex = await window.ethereum.request({ method: 'eth_getBalance', params: [address, 'latest'] });
        const ethBalance = (parseInt(ethHex, 16) / 1e18).toFixed(4);
        const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
        const chainId = parseInt(chainHex, 16);

        async function erc20Balance(contractAddr, decimals) {
          const callData = '0x70a08231' + address.slice(2).padStart(64, '0');
          const hex = await window.ethereum.request({ method: 'eth_call', params: [{ to: contractAddr, data: callData }, 'latest'] });
          return (parseInt(hex, 16) / Math.pow(10, decimals)).toFixed(2);
        }

        let weETHBalance = '0.0000';
        if (weethAddrs[chainId]) weETHBalance = await erc20Balance(weethAddrs[chainId], 18).catch(() => '0.0000');

        let usdcBalance = '0.00';
        if (usdcAddrs[chainId]) usdcBalance = await erc20Balance(usdcAddrs[chainId], 6).catch(() => '0.00');

        return { address, ethBalance, weETHBalance, usdcBalance, chainId };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [WEETH_ADDR, USDC_ADDR],
  });

  const result = results[0]?.result;
  if (!result) throw new Error('執行腳本失敗');
  if (result.error) throw new Error(result.error);
  return result;
}

// ── 連接錢包按鈕 ──────────────────────────────────────────

document.getElementById('connectBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectBtn');
  const status = document.getElementById('walletStatus');
  btn.disabled = true;
  btn.textContent = '讀取中…';

  try {
    const w = await readWalletFromPage();
    applyWalletUI(w);
    chrome.storage.local.set({ wallet: w }); // 存起來，下次開 popup 自動還原
  } catch (e) {
    status.textContent = `⚠️ ${e.message}`;
    status.className = 'wallet-status';
    btn.textContent = '重試';
  } finally {
    btn.disabled = false;
  }
});

// ── 快捷操作按鈕 ──────────────────────────────────────────

const ACTIONS_BY_TOP = {
  eth: [
    { label: 'ETH → weETH', protocol: 'etherfi', question: (w) => `我有 ${w.eth} ETH，想質押成 weETH 賺利息，步驟和費用是？` },
    { label: 'ETH → USDC',  protocol: 'curve',   question: (w) => `我有 ${w.eth} ETH，想換成 USDC 穩定幣，最划算路徑和費用？` },
    { label: '查看收益',     protocol: 'etherfi', question: (w) => `我持有 ${w.eth} ETH，各協議質押年化收益如何？哪個最划算？` },
    { label: 'Hyperliquid', protocol: 'hyperliquid', question: (w) => `我有 ${w.eth} ETH，怎麼存入 Hyperliquid 交易？步驟和費用？` },
  ],
  weeth: [
    { label: 'weETH → ETH', protocol: 'etherfi', question: (w) => `我有 ${w.weeth} weETH，想換回 ETH，最快路徑和費用是？` },
    { label: 'weETH → USDC',protocol: 'curve',   question: (w) => `我有 ${w.weeth} weETH，想換成 USDC，步驟和費用？` },
    { label: '查看收益',     protocol: 'etherfi', question: (w) => `我有 ${w.weeth} weETH，目前年化收益多少？有更好的策略嗎？` },
    { label: 'Curve 池',    protocol: 'curve',   question: (w) => `我有 ${w.weeth} weETH，在 Curve 提供流動性的步驟和 APY？` },
  ],
  usdc: [
    { label: 'USDC → ETH',  protocol: 'curve',   question: (w) => `我有 ${w.usdc} USDC，想換成 ETH，透過 Curve 最划算的路徑是？請給步驟和費用。` },
    { label: 'USDC → weETH',protocol: 'etherfi', question: (w) => `我有 ${w.usdc} USDC，想換成 weETH 賺質押收益，步驟和費用？` },
    { label: '查看收益',     protocol: 'curve',   question: (w) => `我有 ${w.usdc} USDC，在 Curve 穩定幣池提供流動性的 APY 和步驟？` },
    { label: 'Hyperliquid', protocol: 'hyperliquid', question: (w) => `我有 ${w.usdc} USDC，存入 Hyperliquid 的步驟和費用？` },
  ],
};

let currentTopToken = 'eth';

function updateQuickButtons(topToken) {
  currentTopToken = topToken;
  const actions = ACTIONS_BY_TOP[topToken];
  document.querySelectorAll('.quick-btn').forEach((btn, i) => {
    if (actions[i]) btn.textContent = actions[i].label;
  });
}

document.querySelectorAll('.quick-btn').forEach((btn, i) => {
  btn.addEventListener('click', () => {
    const actions = ACTIONS_BY_TOP[currentTopToken];
    const action = actions[i];
    if (!action) return;
    selectedProtocol = action.protocol;

    chrome.storage.local.get(['wallet'], ({ wallet }) => {
      const w = {
        eth:   wallet?.ethBalance   || '?',
        weeth: wallet?.weETHBalance || '?',
        usdc:  wallet?.usdcBalance  || '?',
      };
      document.getElementById('question').value = action.question(w);
      document.getElementById('question').focus();
    });
  });
});

// ── 根據問題自動偵測協議 ──────────────────────────────────

function detectProtocol(question) {
  const q = question.toLowerCase();
  if (/curve|usdc|usdt|dai|穩定幣|swap/.test(q)) return 'curve';
  if (/hyperliquid|hype|behype|perp|永續|槓桿/.test(q)) return 'hyperliquid';
  return 'etherfi'; // 預設
}

// ── 清除 ──────────────────────────────────────────────────

document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('question').value = '';
  const box = document.getElementById('resultBox');
  box.textContent = '等待你的問題…';
  box.className = 'result-box empty';
});

// ── 送出查詢 ──────────────────────────────────────────────

document.getElementById('submitBtn').addEventListener('click', async () => {
  const raw = document.getElementById('question').value.trim();
  if (!raw) return;

  const question = walletContext ? `${walletContext} ${raw}` : raw;
  selectedProtocol = detectProtocol(raw);
  const btn = document.getElementById('submitBtn');
  const box = document.getElementById('resultBox');

  btn.disabled = true;
  box.className = 'result-box';
  box.innerHTML = '<div class="loading"><div class="spinner"></div>AI 顧問思考中…</div>';

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: selectedProtocol, question }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    box.className = 'result-box';
    box.textContent = data.suggestion || '（未收到回應）';
    document.getElementById('executeSection').style.display = 'block';
    // 自動帶入錢包地址與預設金額
    chrome.storage.local.get(['wallet'], ({ wallet }) => {
      if (wallet?.address) document.getElementById('execAddr').value = wallet.address;
      if (!document.getElementById('execAmount').value) document.getElementById('execAmount').value = '0.001';
    });
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

// ── Cobo 執行交易 ──────────────────────────────────────────

document.getElementById('executeBtn').addEventListener('click', async () => {
  const addr = document.getElementById('execAddr').value.trim();
  const amount = document.getElementById('execAmount').value.trim();
  const result = document.getElementById('execResult');

  if (!addr || !amount) {
    result.style.color = '#f87171';
    result.textContent = '請填入地址與金額';
    return;
  }

  const btn = document.getElementById('executeBtn');
  btn.disabled = true;
  btn.textContent = '送出中…';
  result.style.color = '#64748b';
  result.textContent = '等待 Cobo 確認…';

  try {
    const resp = await fetch('http://localhost:8000/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dst_addr: addr, amount, chain_id: 'SETH', token_id: 'SETH' }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

    result.style.color = '#34d399';
    result.textContent = `✅ 交易送出中，等待確認…`;

    // 輪詢直到拿到 transaction_hash
    const txId = data.tx_id;
    let hash = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const sr = await fetch(`http://localhost:8000/tx-status/${txId}`);
        const sd = await sr.json();
        if (sd.hash) { hash = sd.hash; break; }
      } catch (_) {}
    }

    const COBO_ADDR = '0x1f066352df53d05737872598575cb6e828a77eec';
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
    btn.disabled = false;
    btn.textContent = '⚡ 用 Cobo Wallet 執行交易';
  }
});
