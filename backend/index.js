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
  Interface,
  ZeroAddress,
  toBeHex,
  getBytes,
} from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';



// -------- SAFE RPC HELPERS (no batching + retry + timeouts) --------
const READS = [process.env.READ_RPC_1, process.env.READ_RPC_2].filter(Boolean);

async function rpcFetch(url, method, params = []) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000); // 8s guard
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.result !== undefined) return j.result;
    throw new Error(j?.error?.message || `rpc error ${r.status}`);
  } finally {
    clearTimeout(t);
  }
}

async function rpc(method, params = []) {
  let lastErr;
  for (const url of READS) {
    try {
      return await rpcFetch(url, method, params);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all RPCs failed");
}

// tiny helpers for common reads we need in /send
const toHex = (v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v);






/* ---------- setup ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Prefer a stable read RPC; default to Pimlico RPC (same BUNDLER_URL works as a plain JSON-RPC node).
const READ_RPC = process.env.READ_RPC || process.env.BUNDLER_URL || process.env.RPC_URL;

const provider = new JsonRpcProvider(
  READ_RPC,
  undefined,
  { batchMaxCount: 1 }   // keep batching off for free/strict tiers
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
    // Always hit the normal RPC here (not the bundler)
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
// GET /api/aa/address?user=<string>
// --- AA: get deterministic smart-account address from userId (no deploy) ---
// GET /api/aa/address?user=<string>
app.get('/api/aa/address', async (req, res) => {
  try {
    const userId = String(req.query.user || "");
    if (!userId) return res.status(400).json({ error: "missing ?user=<string>" });

    const factoryAddr = process.env.AA_FACTORY;
    if (!factoryAddr) return res.status(400).json({ error: "AA_FACTORY not set" });

    // load ABI once from your artifacts
    const factoryArt = loadArtifact("../contracts/artifacts/contracts/aa/AccountFactory.sol/AccountFactory.json");
    const facIf = new Interface(factoryArt.abi);

    // helper to call safely and catch CALL_EXCEPTION
    const safeCall = async (to, data) => {
      try {
        return await rpc("eth_call", [{ to, data }, "latest"]);
      } catch (e) {
        return null;
      }
    };

    // 1) Try getAddress(string)
    let data = facIf.encodeFunctionData("getAddress", [userId]);
    let out  = await safeCall(factoryAddr, data);

    let smartAccount = null;
    if (out) {
      try {
        smartAccount = facIf.decodeFunctionResult("getAddress", out)[0];
      } catch {
        smartAccount = null;
      }
    }

    // 2) If that failed, try getAddress(bytes32) with keccak256(userId)
    if (!smartAccount) {
      const salt32 = keccak256(toUtf8Bytes(userId)); // 0x…32 bytes
      // Build an alternate interface on-the-fly in case the artifact doesn't include this variant
      const altIf = new Interface(["function getAddress(bytes32) view returns (address)"]);
      data = altIf.encodeFunctionData("getAddress", [salt32]);
      out  = await safeCall(factoryAddr, data);
      if (out) {
        try {
          smartAccount = altIf.decodeFunctionResult("getAddress", out)[0];
        } catch { /* ignore */ }
      }
    }

    // 3) Also return implementation (most factories expose it; ignore if missing)
    let implementation = null;
    try {
      const implData = facIf.encodeFunctionData("implementation", []);
      const implOut  = await rpc("eth_call", [{ to: factoryAddr, data: implData }, "latest"]);
      implementation = facIf.decodeFunctionResult("implementation", implOut)[0];
    } catch { /* optional */ }

    if (!smartAccount) {
      return res.status(500).json({
        error: "Factory reverted for both signatures (string/bytes32). Check ABI or AA_FACTORY.",
        factory: factoryAddr,
      });
    }

    return res.json({
      userId,
      factory: factoryAddr,
      implementation,
      smartAccount,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});



// === AA DEBUG: owner, nonce, allowance, etc. ===
// DEBUG: show AA + token/paymaster status for a user
app.get('/api/aa/debug', async (req, res) => {
  try {
    const userId = String(req.query.user || '').trim();
    if (!userId) return res.status(400).json({ error: "missing ?user=<string>" });

    const factoryAddr   = process.env.AA_FACTORY;
    const entryPoint    = process.env.ENTRYPOINT;            // 0x26fa019bd82eC5D47e946a80b5929DE2ee274c01
    const tokenAddr     = process.env.REWARD_TOKEN;
    const paymasterAddr = process.env.PAYMASTER;

    // small helpers that never throw
    const safe = async (fn, fallback = null) => {
      try { return await fn(); } catch { return fallback; }
    };
    const getCode = (addr) => safe(() => provider.getCode(addr), "0x");
    const getBal  = (addr) => safe(() => provider.getBalance(addr), 0n);

    // load ABIs
    const factoryAbi = loadArtifact("../contracts/artifacts/contracts/aa/AccountFactory.sol/AccountFactory.json").abi;
    const tokenAbi   = loadArtifact("../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json").abi;
    const epAbi      = [
      "function getNonce(address sender, uint192 key) view returns (uint256)"
    ];

    // contracts
    const factory = new Contract(factoryAddr, factoryAbi, provider);
    const token   = new Contract(tokenAddr,   tokenAbi,   provider);
    const ep      = new Contract(entryPoint,  epAbi,      provider);

    // compute deterministic AA address
    const sender  = await factory.getAddress(userId);

    // queries (each individually guarded)
    const senderCode   = await getCode(sender);
    const deployed     = senderCode && senderCode !== "0x";
    const epNonce      = await safe(() => ep.getNonce(sender, 0), null);
    const tokenPrice   = await safe(() => token.pricePerTokenWei(), null);
    const allowance    = await safe(() => token.minterAllowance(sender), null);
    const senderBal    = await getBal(sender);
    const paymasterBal = await getBal(paymasterAddr);

    // just for reference: verify entrypoint has code
    const epHasCode    = (await getCode(entryPoint)) !== "0x";

    return res.json({
      userId,
      sender,
      deployed,
      entryPoint,
      entrypointHasCode: epHasCode,
      entryPointNonce: epNonce?.toString?.() ?? null,
      token: tokenAddr,
      pricePerTokenWei: tokenPrice?.toString?.() ?? null,
      minterAllowance: allowance?.toString?.() ?? null,
      balances: {
        senderWei: senderBal.toString(),
        paymasterWei: paymasterBal.toString()
      }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});






/* ---------- AA: deploy account (idempotent) ---------- */
// POST /api/aa/deploy?user=<string>&owner=0x...
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

    const predicted = await factory['getAddress(string)'](userId);
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

/* ---------- 4337 preflight ---------- */
app.get('/api/4337/preflight', async (_req, res) => {
  try {
    const entrypoint = process.env.ENTRYPOINT;
    const bundlerUrl = process.env.BUNDLER_URL;
    if (!entrypoint) return res.status(400).json({ error: 'ENTRYPOINT not set' });
    if (!bundlerUrl) return res.status(400).json({ error: 'BUNDLER_URL not set' });

    const code = await provider.getCode(entrypoint);
    const epOk = code && code !== '0x';

    const r = await fetch(bundlerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
    });
    const bundlerResp = await r.json();

    res.json({
      entrypoint,
      entrypointHasCode: epOk,
      bundlerUrl,
      bundlerClientVersion: bundlerResp?.result ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// --- Step 1: deploy user's Smart Account wallet ---
app.get("/api/aa/create", async (req, res) => {
  try {
    const user = String(req.query.user || "");
    if (!user) return res.status(400).json({ error: "missing ?user=" });

    const FACTORY = process.env.AA_FACTORY;
    if (!FACTORY) return res.status(400).json({ error: "AA_FACTORY not set" });

    const factoryArt = loadArtifact("../contracts/artifacts/contracts/aa/AccountFactory.sol/AccountFactory.json");
    const factory = new Contract(FACTORY, factoryArt.abi, relayer);

    const sender = await factory["getAddress(string)"](user);
    const code = await provider.getCode(sender);

    if (code && code !== "0x") {
      return res.json({ ok: true, user, smartAccount: sender, alreadyDeployed: true });
    }

    const owner = await relayer.getAddress();
    const tx = await factory.createAccount(user, owner);
    await tx.wait();

    const codeAfter = await provider.getCode(sender);
    const deployed = codeAfter && codeAfter !== "0x";

    res.json({ ok: true, user, smartAccount: sender, deployed, txHash: tx.hash });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



/* -----------------------------------------------------------
 * 4337 v0.7: DRAFT a UserOperation for gasless mint (no send)
 * GET /api/aa/gasless-mint/draft?user=<id>&to=0x...&amount=10
 * --------------------------------------------------------- */
const ENTRYPOINT_ABI = [
  'function getNonce(address sender, uint192 key) view returns (uint256)',
];
const FACTORY_ABI = [
  'function getAddress(string userId) view returns (address)',
  'function createAccount(string userId, address owner) returns (address)',
];
const MINIMAL_ACCOUNT_ABI = [
  'function execute(address dest, uint256 value, bytes calldata func) external'
];

// ---------- helpers to load factory and try both ABIs ----------
//function loadArtifact(relPath) {
  //const p = path.resolve(__dirname, relPath);
  //return JSON.parse(fs.readFileSync(p, 'utf8'));
//}

function accountFactoryContract(address) {
  // your compiled factory abi (string version)
  const abiVString = loadArtifact('../contracts/artifacts/contracts/aa/AccountFactory.sol/AccountFactory.json').abi;
  return new Contract(address, abiVString, provider);
}

async function getSenderAndInit(factoryAddr, userId) {
  const factory = accountFactoryContract(factoryAddr);

  // 1) Try string signature
  try {
    const sender = await factory.getAddress(userId); // string
    const code = await provider.getCode(sender);
    const deployed = code && code !== '0x';
    let factoryData = '0x';
    if (!deployed) {
      factoryData = factory.interface.encodeFunctionData('createAccount', [userId]);
    }
    return { sender, deployed, factoryData };
  } catch (_) {
    // 2) Fallback to bytes32 signature
    const salt = ethers.id(userId); // keccak256(string)
    // Rebuild an Interface that *also* has bytes32 overloads if needed
    // (If your JSON already contains both overloads, you can reuse the same `factory`.)
    let iface = factory.interface;
    if (!iface.getFunction('getAddress(bytes32)')) {
      // In case the compiled ABI doesn't include the bytes32 version, build one quickly:
      iface = new ethers.Interface([
        'function getAddress(bytes32) view returns (address)',
        'function createAccount(bytes32) returns (address)',
      ]);
    }

    // raw call for getAddress(bytes32)
    const data = iface.encodeFunctionData('getAddress(bytes32)', [salt]);
    const result = await provider.call({ to: factoryAddr, data });
    const [sender] = iface.decodeFunctionResult('getAddress(bytes32)', result);

    const code = await provider.getCode(sender);
    const deployed = code && code !== '0x';
    let factoryData = '0x';
    if (!deployed) {
      factoryData = iface.encodeFunctionData('createAccount(bytes32)', [salt]);
    }
    return { sender, deployed, factoryData, usedBytes32: true };
  }
}


app.get('/api/aa/gasless-mint/send', async (req, res) => {
  try {
    const user = String(req.query.user || '');
    const receiver = String(req.query.to || '');
    const amountStr = String(req.query.amount || '10');

    if (!user) return res.status(400).json({ error: 'missing ?user=' });
    if (!receiver.startsWith('0x')) return res.status(400).json({ error: 'bad ?to=' });

    const factoryAddr = process.env.AA_FACTORY;
    const tokenAddr = process.env.REWARD_TOKEN;
    const paymasterAddr = process.env.PAYMASTER;
    const bundlerUrl = process.env.BUNDLER_URL;
    const entryPoint = process.env.ENTRYPOINT;

    if (!factoryAddr || !tokenAddr || !paymasterAddr || !bundlerUrl || !entryPoint)
      return res.status(400).json({ error: 'missing env vars' });

    const { sender, deployed, factoryData } = await getSenderAndInit(factoryAddr, user);

    // encode mint call
    const tokenAbi = loadArtifact('../contracts/artifacts/contracts/RewardToken.sol/RewardToken.json').abi;
    const tokenIface = new ethers.Interface(tokenAbi);
    const innerCall = tokenIface.encodeFunctionData('mintTo', [receiver, parseUnits(amountStr, 18)]);

    const accountAbi = ['function execute(address target, uint256 value, bytes data) external'];
    const accountIface = new ethers.Interface(accountAbi);
    const callData = accountIface.encodeFunctionData('execute', [tokenAddr, 0, innerCall]);

    const userOp = {
      sender,
      nonce: '0x0',
      callData,
      callGasLimit: '0x5208',
      verificationGasLimit: '0x989680',
      preVerificationGas: '0x186a0',
      maxFeePerGas: '0x3b9aca00',
      maxPriorityFeePerGas: '0x3b9aca00',
      paymaster: paymasterAddr,
      paymasterData: '0x',
      signature: '0x',
    };

    if (!deployed) {
      userOp.factory = factoryAddr;
      userOp.factoryData = factoryData;
    }

    const reqBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendUserOperation',
      params: [userOp, entryPoint],
    };

    const resp = await fetch(bundlerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    });

    const json = await resp.json();
    if (json.error) {
      return res.status(400).json({
        error: 'Bundler rejected',
        details: json.error,
        sentUserOp: userOp,
      });
    }

    res.json({ ok: true, userOpHash: json.result, sender, receiver, amount: amountStr });
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
      pricePerTokenWei: price.toString(),
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

// buy() flow
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
