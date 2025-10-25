import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  JsonRpcProvider,
  Wallet,
  formatEther,
  parseEther,
  Contract,
  parseUnits,
} from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* ---------- setup ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Provider: disable batching to avoid free-tier RPC limits
const provider = new JsonRpcProvider(
  process.env.RPC_URL,
  undefined,
  { batchMaxCount: 1 }
);

const relayer = new Wallet(process.env.RELAYER_PK, provider);

// helper to load artifacts with absolute path
function loadArtifact(relPath) {
  const p = path.resolve(__dirname, relPath);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ---------- basic routes ---------- */
app.get('/health', (_req, res) => res.send('ok'));

app.get('/chain', async (_req, res) => {
  try {
    const net = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    res.json({
      chainId: net.chainId.toString(),
      name: net.name || 'unknown',
      latestBlock: block.toString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/relayer', async (_req, res) => {
  try {
    const addr = await relayer.getAddress();
    const bal = await provider.getBalance(addr);
    res.json({
      address: addr,
      balanceWei: bal.toString(),
      balance: formatEther(bal),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ---------- AA: deterministic address (no deploy) ---------- */
/* ---------- AA: deterministic address (no deploy) ---------- */
// GET /api/aa/address?user=<string>
app.get('/api/aa/address', async (req, res) => {
  try {
    const userId = String(req.query.user || '');
    if (!userId) return res.status(400).json({ error: 'missing ?user=<string>' });

    const factoryAddr = process.env.AA_FACTORY;
    if (!factoryAddr) return res.status(400).json({ error: 'AA_FACTORY not set' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/aa/AccountFactory.sol/AccountFactory.json'
    );
    const factory = new Contract(factoryAddr, artifact.abi, provider);

    // IMPORTANT: call by signature to avoid ethers.js collision
    const predicted = await factory['getAddress(string)'](userId);
    const impl = await factory.implementation();

    res.json({
      userId,
      factory: factoryAddr,
      implementation: impl,
      smartAccount: predicted,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ---------- AA: deploy account (idempotent) ---------- */
// POST /api/aa/deploy?user=<string>&owner=0x... (owner optional; defaults to relayer)
app.post('/api/aa/deploy', async (req, res) => {
  try {
    const userId = String((req.query.user || req.body?.user || '').toString());
    if (!userId) return res.status(400).json({ error: 'missing ?user=<string>' });

    const owner =
      String((req.query.owner || req.body?.owner || '').toString()) ||
      (await relayer.getAddress());

    const factoryAddr = process.env.AA_FACTORY;
    if (!factoryAddr) return res.status(400).json({ error: 'AA_FACTORY not set' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/aa/AccountFactory.sol/AccountFactory.json'
    );
    const factory = new Contract(factoryAddr, artifact.abi, relayer);

    // predict using signature
    const predicted = await factory['getAddress(string)'](userId);

    // deploy using signature (idempotent)
    const tx = await factory['createAccount(string,address)'](userId, owner);
    const receipt = await tx.wait();

    const code = await provider.getCode(predicted);
    const deployed = code && code !== '0x';

    res.json({
      userId,
      factory: factoryAddr,
      predicted,
      owner,
      txHash: tx.hash,
      deployed,
      receiptBlock: receipt.blockNumber?.toString?.() || null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


/* ---------- Token helpers ---------- */
const REWARD_TOKEN = process.env.REWARD_TOKEN;

app.get('/api/token/info', async (_req, res) => {
  try {
    if (!REWARD_TOKEN) return res.status(400).json({ error: 'REWARD_TOKEN not set' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json'
    );
    const token = new Contract(REWARD_TOKEN, artifact.abi, provider);

    const [name, symbol, decimals, owner, supply, price] = await Promise.all([
      token.name(),
      token.symbol(),
      token.decimals(),
      token.owner(),
      token.totalSupply(),
      token.pricePerTokenWei(),
    ]);

    res.json({
      address: REWARD_TOKEN,
      name,
      symbol,
      decimals: Number(decimals),
      owner,
      totalSupply: supply.toString(),
      totalSupplyFormatted: (Number(supply) / 10 ** Number(decimals)).toString(),
      pricePerTokenWei: price.toString(), // should be "0" by default as you wanted
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// /api/token/set-price?wei=...
app.get('/api/token/set-price', async (req, res) => {
  try {
    if (!REWARD_TOKEN) return res.status(400).json({ error: 'REWARD_TOKEN not set' });
    const wei = req.query.wei;
    if (!wei) return res.status(400).json({ error: 'missing wei' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json'
    );
    const token = new Contract(REWARD_TOKEN, artifact.abi, relayer);

    const tx = await token.setPricePerTokenWei(wei);
    await tx.wait();

    res.json({ status: '✅ price updated', wei, tx: tx.hash });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// /api/token/set-minter?wallet=0x...&allowance=...
app.get('/api/token/set-minter', async (req, res) => {
  try {
    if (!REWARD_TOKEN) return res.status(400).json({ error: 'REWARD_TOKEN not set' });
    const { wallet, allowance } = req.query;
    if (!wallet || !allowance)
      return res.status(400).json({ error: 'missing wallet or allowance' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json'
    );
    const token = new Contract(REWARD_TOKEN, artifact.abi, relayer);

    const tx = await token.setMinterAllowance(wallet, allowance);
    await tx.wait();

    res.json({ status: '✅ minter added', wallet, allowance, tx: tx.hash });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// owner-style mint: ensure relayer has allowance, then mintTo()
app.get('/api/token/mint', async (req, res) => {
  try {
    if (!REWARD_TOKEN) return res.status(400).json({ error: 'REWARD_TOKEN not set' });

    const to = String(req.query.wallet || '');
    const amountStr = String(req.query.amount || '10');
    if (!to.startsWith('0x')) return res.status(400).json({ error: 'bad wallet' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json'
    );
    const token = new Contract(REWARD_TOKEN, artifact.abi, relayer);

    const relayerAddr = await relayer.getAddress();
    const current = await token.minterAllowance(relayerAddr);
    const MAX = 2n ** 256n - 1n;
    if (current !== MAX) {
      const txA = await token.setMinterAllowance(relayerAddr, MAX);
      await txA.wait();
    }

    const tx = await token.mintTo(to, parseUnits(amountStr, 18));
    await tx.wait();

    res.json({ status: '✅ minted', to, amount: amountStr, txHash: tx.hash });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// buy() flow (price*amount; works even when price == 0)
app.get('/api/token/buy', async (req, res) => {
  try {
    if (!REWARD_TOKEN) return res.status(400).json({ error: 'REWARD_TOKEN not set' });

    const to = String(req.query.wallet || '');
    const amount = BigInt(String(req.query.amount || '10'));
    if (!to.startsWith('0x')) return res.status(400).json({ error: 'bad wallet' });

    const artifact = loadArtifact(
      '../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json'
    );
    const token = new Contract(REWARD_TOKEN, artifact.abi, relayer);

    const price = await token.pricePerTokenWei();
    const value = price * amount;

    const tx = await token.buy(to, amount, { value });
    await tx.wait();

    res.json({
      status: '✅ bought',
      to,
      amount: String(amount),
      paidWei: value.toString(),
      txHash: tx.hash,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ---------- Paymaster helpers ---------- */
app.get('/api/paymaster/balance', async (_req, res) => {
  try {
    const paymaster = process.env.PAYMASTER;
    if (!paymaster) return res.status(400).json({ error: 'PAYMASTER not set in .env' });

    const bal = await provider.getBalance(paymaster);
    res.json({
      paymaster,
      balanceWei: bal.toString(),
      balance: formatEther(bal),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ---------- misc ---------- */
app.get('/sendtest', async (_req, res) => {
  try {
    const to = await relayer.getAddress();
    const tx = await relayer.sendTransaction({ to, value: parseEther('0.0001') });
    await tx.wait();
    res.json({ hash: tx.hash, status: 'sent ✅' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API running on :${PORT}`));
