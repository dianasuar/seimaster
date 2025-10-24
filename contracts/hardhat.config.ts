import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

dotenv.config();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxMochaEthersPlugin],

  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },

  networks: {
    // built-in local networks
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    hardhatOp: { type: "edr-simulated", chainType: "op" },

    // optional: Sepolia fallback
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL || "https://rpc-testnet.sei-evm.com",
      accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
    },

    // ✅ Sei Testnet network
    seiTestnet: {
      type: "http",                       // required by Hardhat 3
      chainType: "l1",                    // EVM-compatible chain
      url: "https://evm-rpc-testnet.sei-apis.com",
      accounts: process.env.RELAYER_PK ? [process.env.RELAYER_PK] : [],
    },
  },
};

export default config;