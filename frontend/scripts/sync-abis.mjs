// Copies contract ABIs and deployment records from ../contracts into src/ (run after `npx hardhat compile`).
import fs from "fs";
import path from "path";
const root = path.resolve(import.meta.dirname, "..", "..", "contracts");
const names = ["AMYEVault", "AdaptiveYieldRouter", "ProfitAccounting", "RewardDistributor", "RiskController", "MockERC20"];
for (const n of names) {
  const [file] = fs.globSync(`${root}/artifacts/contracts/**/${n}.sol/${n}.json`);
  if (!file) throw new Error(`Artifact for ${n} not found; run npx hardhat compile in contracts/`);
  const { abi } = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(path.resolve(import.meta.dirname, "..", "src", "abi", `${n}.json`), JSON.stringify(abi, null, 2) + "\n");
}
const depDir = path.join(root, "deployments");
for (const f of fs.existsSync(depDir) ? fs.readdirSync(depDir) : []) {
  if (f.endsWith(".json")) fs.copyFileSync(path.join(depDir, f), path.resolve(import.meta.dirname, "..", "src", "deployments", f));
}
console.log("ABIs and deployments synced");
