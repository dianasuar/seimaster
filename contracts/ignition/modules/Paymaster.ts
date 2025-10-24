import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import * as dotenv from "dotenv";
dotenv.config();

const OWNER = process.env.OWNER as string;
const ENTRYPOINT = process.env.ENTRYPOINT as string;

export default buildModule("PaymasterModule", (m) => {
  if (!OWNER || !ENTRYPOINT) throw new Error("Missing OWNER or ENTRYPOINT in .env");

  const paymaster = m.contract("SimplePaymaster", [OWNER, ENTRYPOINT]);

  return { paymaster };
});
