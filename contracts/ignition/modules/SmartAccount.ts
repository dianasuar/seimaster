import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import * as dotenv from "dotenv";
dotenv.config();

const OWNER = process.env.OWNER as string;
const ENTRYPOINT = process.env.ENTRYPOINT as string;

export default buildModule("SmartAccountModule", (m) => {
  if (!OWNER || !ENTRYPOINT) throw new Error("Set OWNER and ENTRYPOINT in contracts/.env");

  const smartAccount = m.contract("SmartAccount", [OWNER, ENTRYPOINT]);

  return { smartAccount };
});
