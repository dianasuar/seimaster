import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.SEI_PRIVATE_KEY!;
const PAYMASTER = process.env.PAYMASTER!;
const TARGET = process.env.TARGET!;

async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !PAYMASTER || !TARGET) {
    throw new Error("Missing RPC_URL, PRIVATE_KEY, PAYMASTER, or TARGET in .env");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const signerAddr = await wallet.getAddress();

  console.log("👤 Signer:", signerAddr);
  console.log("🏦 Paymaster:", PAYMASTER);
  console.log("🎯 Target:", TARGET);

  // 1️⃣ Fund the Paymaster
  const tx1 = await wallet.sendTransaction({
    to: PAYMASTER,
    value: ethers.parseEther("0.05"),
  });
  await tx1.wait();
  console.log("✅ Funded Paymaster with 0.05 SEI | Tx:", tx1.hash);

  // 2️⃣ Whitelist the target (using inline ABI)
  const paymasterAbi = [
    "function setAllowedTarget(address target, bool allowed) external",
  ];
  const paymaster = new ethers.Contract(PAYMASTER, paymasterAbi, wallet);

  const tx2 = await paymaster.setAllowedTarget(TARGET, true);
  await tx2.wait();
  console.log("✅ Whitelisted target:", TARGET);

  // 3️⃣ Show Paymaster balance
  const bal = await provider.getBalance(PAYMASTER);
  console.log("💰 Paymaster balance:", ethers.formatEther(bal), "SEI");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
