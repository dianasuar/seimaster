import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AAFactoryModule", (m) => {
  const minimal = m.contract("MinimalAccount");               // implementation
  const factory = m.contract("AccountFactory", [minimal]);    // factory with impl
  return { minimal, factory };
});
