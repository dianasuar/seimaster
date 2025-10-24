import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import * as dotenv from "dotenv";
dotenv.config();

const OWNER = process.env.OWNER as string;

export default buildModule("RewardTokenModule", (m) => {
  if (!OWNER) throw new Error("OWNER missing in .env");
  const name = m.getParameter<string>("name", "Kazar Reward");
  const symbol = m.getParameter<string>("symbol", "KAZ");
  const token = m.contract("RewardToken", [name, symbol, OWNER]);
  return { token };
});
