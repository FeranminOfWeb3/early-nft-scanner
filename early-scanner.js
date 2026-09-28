/**
 * Early NFT Contract Scanner
 * Watches new Ethereum contract deployments, filters for NFT contracts
 * (ERC-721 / ERC-1155), and sends a Telegram alert as soon as one appears —
 * so you can check it out (and its socials) while it's still tiny.
 *
 * Setup:
 *  1. npm install axios
 *  2. Fill in the CONFIG values below
 *  3. node early-scanner.js
 *  4. Deploy to Railway like your other bots for 24/7 uptime
 */

const axios = require('axios');
const fs = require('fs');

// ---------- CONFIG ----------
const CONFIG = {
  ETHERSCAN_API_KEY: 'HTYN4VH683829VS7YI1ENVN43FEEUW566H',
  TELEGRAM_BOT_TOKEN: '8661078368:AAF2lFZsUZX0KC5jnoDj7acVCqx_bl8x7L8',
  TELEGRAM_CHAT_ID: '6955687699',
  CHECK_INTERVAL_MINUTES: 3,
  STORE_FILE: './scanner-store.json',
  ETHERSCAN_BASE: 'https://api.etherscan.io/api',
};
// -----------------------------

// ERC-721 / ERC-1155 identify via function selectors present in verified source,
// or via standard interface signatures in contract ABI when available.
const NFT_SIGNATURES = ['ownerOf', 'safeTransferFrom', 'tokenURI', 'balanceOfBatch'];

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.STORE_FILE, 'utf8'));
  } catch {
    return { lastBlock: null, seen: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(CONFIG.STORE_FILE, JSON.stringify(store, null, 2));
}

async function sendTelegramAlert(message) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('Telegram send failed:', err.response?.data || err.message);
  }
}

async function getLatestBlockNumber() {
  const res = await axios.get(CONFIG.ETHERSCAN_BASE, {
    params: {
      module: 'proxy',
      action: 'eth_blockNumber',
      apikey: CONFIG.ETHERSCAN_API_KEY,
    },
  });
  return parseInt(res.data.result, 16);
}

// Get contract-creation transactions within a block range using Etherscan's
// "internal transactions by block range" endpoint, filtered to contract creations.
async function getContractCreations(fromBlock, toBlock) {
  const res = await axios.get(CONFIG.ETHERSCAN_BASE, {
    params: {
      module: 'account',
      action: 'txlistinternal',
      startblock: fromBlock,
      endblock: toBlock,
      sort: 'asc',
      apikey: CONFIG.ETHERSCAN_API_KEY,
    },
  });

  const results = Array.isArray(res.data.result) ? res.data.result : [];
  return results.filter((tx) => tx.type === 'create' && tx.contractAddress);
}

// Check if a contract's verified source code looks like an NFT contract
async function isLikelyNftContract(address) {
  try {
    const res = await axios.get(CONFIG.ETHERSCAN_BASE, {
      params: {
        module: 'contract',
        action: 'getsourcecode',
        address,
        apikey: CONFIG.ETHERSCAN_API_KEY,
      },
    });

    const result = res.data.result?.[0];
    if (!result || !result.SourceCode) return null; // not verified, skip

    const source = result.SourceCode;
    const matchesNft = NFT_SIGNATURES.some((sig) => source.includes(sig));
    if (!matchesNft) return null;

    return {
      name: result.ContractName || 'Unknown',
      address,
    };
  } catch (err) {
    console.error(`Failed checking contract ${address}:`, err.response?.data || err.message);
    return null;
  }
}

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning for new NFT contracts...`);
  const store = loadStore();

  let latestBlock;
  try {
    latestBlock = await getLatestBlockNumber();
  } catch (err) {
    console.error('Failed to fetch latest block:', err.response?.data || err.message);
    return;
  }

  const fromBlock = store.lastBlock ? store.lastBlock + 1 : latestBlock - 20;

  if (fromBlock > latestBlock) {
    console.log('No new blocks yet.');
    return;
  }

  let creations;
  try {
    creations = await getContractCreations(fromBlock, latestBlock);
  } catch (err) {
    console.error('Failed to fetch contract creations:', err.response?.data || err.message);
    return;
  }

  console.log(`Found ${creations.length} new contract(s) in blocks ${fromBlock}-${latestBlock}.`);

  for (const tx of creations) {
    const address = tx.contractAddress.toLowerCase();
    if (store.seen[address]) continue;

    const nftInfo = await isLikelyNftContract(address);
    store.seen[address] = true; // mark seen either way, to avoid re-checking

    if (nftInfo) {
      const message =
        `🆕 *New NFT Contract Deployed*\n\n` +
        `Name: \`${nftInfo.name}\`\n` +
        `Address: \`${nftInfo.address}\`\n` +
        `Etherscan: https://etherscan.io/address/${nftInfo.address}\n\n` +
        `Check its Twitter/Discord before it grows.`;
      console.log(message);
      await sendTelegramAlert(message);
    }
  }

  store.lastBlock = latestBlock;
  saveStore(store);
  console.log('Scan complete.\n');
}

// Run immediately, then on interval
runScan();
setInterval(runScan, CONFIG.CHECK_INTERVAL_MINUTES * 60 * 1000);
