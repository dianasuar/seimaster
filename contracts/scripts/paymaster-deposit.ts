// scripts/paymaster-deposit.ts  (ESM)
import 'dotenv/config'
import { ethers } from 'ethers'
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL)
const wallet = new ethers.Wallet(process.env.SEI_PRIVATE_KEY!, provider)

const ENTRYPOINT = process.env.ENTRYPOINT!.toLowerCase()
const PAYMASTER = process.env.PAYMASTER!

const EP_ABI = [
  'function depositTo(address account) payable',
  'function addStake(uint32 unstakeDelaySec) payable',
  'function getDepositInfo(address account) view returns (uint112 deposit,uint112 staked, uint32 unstakeDelaySec, uint64 stake, uint64 unstakeTime)'
]

async function main() {
  const ep = new ethers.Contract(ENTRYPOINT, EP_ABI, wallet)

  // 0.05 SEI deposit (adjust)
  const tx1 = await ep.depositTo(PAYMASTER, { value: ethers.parseEther('0.05') })
  await tx1.wait()
  console.log('✅ depositTo done:', tx1.hash)

  // optional but recommended for v0.7: addStake (e.g., 1 day)
  const tx2 = await ep.addStake(24 * 60 * 60, { value: ethers.parseEther('0.05') })
  await tx2.wait()
  console.log('✅ addStake done:', tx2.hash)

  const info = await ep.getDepositInfo(PAYMASTER)
  console.log('ℹ️ depositInfo:', info)
}
main().catch(console.error)