import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { JsonRpcProvider, Wallet, formatEther, parseEther, Contract, parseUnits } from 'ethers';

const app = express();
app.use(cors());
app.use(express.json());

// === Provider & Relayer Setup ===
const provider = new JsonRpcProvider(process.env.RPC_URL);
const relayer = new Wallet(process.env.RELAYER_PK, provider);

// === Health Route ===
app.get('/health', (req, res) => res.send('ok'));

// === Chain Info ===
app.get('/chain', async (req, res) => {
  try {
    const net = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    res.json({
      chainId: net.chainId.toString(),
      name: net.name || 'unknown',
      latestBlock: block.toString()
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === Relayer Status ===
app.get('/relayer', async (req, res) => {
  try {
    const addr = await relayer.getAddress();
    const bal = await provider.getBalance(addr);
    res.json({
      address: addr,
      balanceWei: bal.toString(),
      balance: formatEther(bal)
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === Paymaster Balance ===
app.get('/api/paymaster/balance', async (req, res) => {
  try {
    const paymaster = process.env.PAYMASTER;
    if (!paymaster) return res.status(400).json({ error: 'PAYMASTER not set in .env' });

    const bal = await provider.getBalance(paymaster);
    return res.json({
      paymaster,
      balanceWei: bal.toString(),
      balance: formatEther(bal)
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === Mint Token to a Wallet ===
app.get('/api/mint', async (req, res) => {
  try {
    const walletAddress = req.query.wallet;
    if (!walletAddress) {
      return res.status(400).json({ error: 'Missing wallet query param ?wallet=0x...' });
    }

    const contractAddr = process.env.SMARTACCOUNT; // NOTE: set this to your actual token contract if mint() is there
    if (!contractAddr) {
      return res.status(400).json({ error: 'SMARTACCOUNT not set in .env' });
    }

    // Use the artifact from the contracts workspace
    const artifactPath = "../contracts/artifacts/contracts/SmartAccount.sol/SmartAccount.json";
    const fs = await import('fs');
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    const contract = new Contract(contractAddr, artifact.abi, relayer);

    // If your contract is an ERC20 with mint(address,uint256):
    const tx = await contract.mint(String(walletAddress), parseUnits("10", 18));
    await tx.wait();

    res.json({
      status: "✅ minted",
      to: walletAddress,
      amount: "10",
      txHash: tx.hash
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// === Test Transaction ===
app.get('/sendtest', async (req, res) => {
  try {
    const to = await relayer.getAddress();
    const tx = await relayer.sendTransaction({
      to,
      value: parseEther("0.0001")
    });
    await tx.wait();
    res.json({ hash: tx.hash, status: "sent ✅" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API running on :${PORT}`));
