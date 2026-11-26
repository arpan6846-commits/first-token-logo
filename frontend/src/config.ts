import { createConfig, http } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { bscTestnet, bsc, hardhat, type Chain } from "viem/chains";
import type { Abi, Address } from "viem";
import vaultAbi from "./abi/AMYEVault.json";
import routerAbi from "./abi/AdaptiveYieldRouter.json";
import paAbi from "./abi/ProfitAccounting.json";
import rdAbi from "./abi/RewardDistributor.json";
import riskAbi from "./abi/RiskController.json";
import erc20Abi from "./abi/MockERC20.json";

export interface Deployment {
  network: string;
  chainId: number;
  startBlock: number | null;
  usesMocks: boolean;
  roles: { multisig: Address; keeper: Address; riskReporter: Address; treasury: Address; timelockDelaySeconds: number };
  contracts: Record<string, Address>;
}

// Deployment records are written by contracts/scripts/deploy.ts and copied in by `npm run sync-abis`.
const records = import.meta.glob<Deployment>("./deployments/*.json", { eager: true, import: "default" });
const wanted = import.meta.env.VITE_DEPLOYMENT ?? "bscTestnet";
const found = Object.entries(records).find(([file]) => file.endsWith(`/${wanted}.json`));
export const deployment: Deployment | null = found ? found[1] : null;
export const deploymentError = found
  ? null
  : `No deployment record "${wanted}.json" found in src/deployments. Deploy the contracts and run npm run sync-abis.`;

const chains: Record<number, Chain> = { 97: bscTestnet, 56: bsc, 31337: hardhat };
export const chain: Chain = chains[deployment?.chainId ?? 97] ?? bscTestnet;
export const isTestnet = chain.id !== 56;

const rpcUrl = import.meta.env.VITE_RPC_URL as string | undefined;
const e2eAccount = import.meta.env.VITE_E2E_ACCOUNT as Address | undefined;

export const wagmiConfig = createConfig({
  chains: [chain],
  // The mock connector exists only for automated end-to-end tests against a local Hardhat node, where
  // the node itself signs for its unlocked accounts. It is never enabled for a non-local chain.
  connectors: e2eAccount && chain.id === 31337 ? [mock({ accounts: [e2eAccount] }), injected()] : [injected()],
  transports: { [chain.id]: http(rpcUrl) } as Record<number, ReturnType<typeof http>>,
});

const c = deployment?.contracts ?? {};
export const contracts = {
  vault: { address: c.AMYEVault, abi: vaultAbi as Abi },
  router: { address: c.AdaptiveYieldRouter, abi: routerAbi as Abi },
  profitAccounting: { address: c.ProfitAccounting, abi: paAbi as Abi },
  distributor: { address: c.RewardDistributor, abi: rdAbi as Abi },
  risk: { address: c.RiskController, abi: riskAbi as Abi },
  usdt: { address: c.USDT, abi: erc20Abi as Abi },
} as const;

export function explorerTx(hash: string): string | null {
  return chain.blockExplorers?.default ? `${chain.blockExplorers.default.url}/tx/${hash}` : null;
}
