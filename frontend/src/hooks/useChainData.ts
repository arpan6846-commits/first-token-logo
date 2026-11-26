import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Address, type Log, type PublicClient } from "viem";
import { contracts, deployment } from "../config";

/** Every value shown in the UI is read directly from BNB Smart Chain. Nothing here is simulated. */

type C = (typeof contracts)[keyof typeof contracts];

function read<T>(client: PublicClient, c: C, functionName: string, args: unknown[] = []): Promise<T> {
  return client.readContract({ address: c.address as Address, abi: c.abi, functionName, args }) as Promise<T>;
}

export interface StrategyView {
  adapter: Address;
  protocol: Address;
  name: string;
  targetBps: number;
  active: boolean;
  principal: bigint;
  markValue: bigint;
  bookValue: bigint;
  availableLiquidity: bigint;
  riskScore: number;
  acceptingDeposits: boolean;
  realizedGain: bigint;
  recognizedLoss: bigint;
}

export interface ProtocolData {
  blockNumber: bigint;
  /** Timestamp of the latest block: the chain's own notion of "now". */
  blockTimestamp: number;
  totalAssets: bigint;
  estimatedNav: bigint;
  idle: bigint;
  availableLiquidity: bigint;
  totalSupply: bigint;
  pricePerShare: bigint;
  depositCap: bigint;
  minDeposit: bigint;
  paused: boolean;
  guardedLaunch: boolean;
  withdrawalsFrozenUntil: bigint;
  lastHarvest: bigint;
  performanceFeeBps: number;
  harvestCostBps: number;
  harvestCostCap: bigint;
  minReserveBps: number;
  reserveTargetBps: number;
  strategies: StrategyView[];
  highWaterMark: bigint;
  lossCarryforward: bigint;
  cumulativeRealizedGain: bigint;
  cumulativeRecognizedLoss: bigint;
  cumulativeExecutionCost: bigint;
  cumulativeRecovered: bigint;
  cumulativeFees: bigint;
  cumulativeRewards: bigint;
  rewardLiabilities: bigint;
  fundingSurplus: bigint;
  totalClaimed: bigint;
  totalCompounded: bigint;
}

export function useProtocolData() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["protocol", deployment?.contracts.AMYEVault],
    enabled: !!client && !!deployment,
    refetchInterval: 15_000,
    queryFn: async (): Promise<ProtocolData> => {
      const cl = client!;
      const { vault, router, profitAccounting: pa, distributor: rd, risk } = contracts;
      const [
        blockNumber, totalAssets, estimatedNav, idle, availableLiquidity, totalSupply, pricePerShare, depositCap,
        minDeposit, paused, guardedLaunch, withdrawalsFrozenUntil, lastHarvest, performanceFeeBps, harvestCostBps,
        harvestCostCap, minReserveBps, reserveTargetBps, rawStrategies, highWaterMark, cumulativeRealizedGain,
        cumulativeRecognizedLoss, cumulativeExecutionCost, cumulativeRecovered, cumulativeFees, cumulativeRewards,
        rewardLiabilities, fundingSurplus, totalClaimed, totalCompounded,
      ] = await Promise.all([
        cl.getBlockNumber(),
        read<bigint>(cl, vault, "totalAssets"),
        read<bigint>(cl, vault, "estimatedNav"),
        read<bigint>(cl, vault, "idleAssets"),
        read<bigint>(cl, vault, "availableLiquidity"),
        read<bigint>(cl, vault, "totalSupply"),
        read<bigint>(cl, vault, "pricePerShare"),
        read<bigint>(cl, vault, "depositCap"),
        read<bigint>(cl, vault, "minDeposit"),
        read<boolean>(cl, vault, "paused"),
        read<boolean>(cl, vault, "guardedLaunch"),
        read<bigint>(cl, vault, "withdrawalsFrozenUntil"),
        read<bigint>(cl, vault, "lastHarvest"),
        read<number>(cl, vault, "performanceFeeBps"),
        read<number>(cl, vault, "harvestCostBps"),
        read<bigint>(cl, vault, "harvestCostCap"),
        read<number>(cl, risk, "minReserveBps"),
        read<number>(cl, router, "reserveTargetBps"),
        read<Omit<StrategyView, "realizedGain" | "recognizedLoss">[]>(cl, router, "getAllStrategies"),
        read<bigint>(cl, pa, "highWaterMark"),
        read<bigint>(cl, pa, "cumulativeRealizedGain"),
        read<bigint>(cl, pa, "cumulativeRecognizedLoss"),
        read<bigint>(cl, pa, "cumulativeExecutionCost"),
        read<bigint>(cl, pa, "cumulativeRecovered"),
        read<bigint>(cl, pa, "cumulativeFees"),
        read<bigint>(cl, pa, "cumulativeRewards"),
        read<bigint>(cl, rd, "totalLiabilities"),
        read<bigint>(cl, rd, "fundingSurplus"),
        read<bigint>(cl, rd, "totalClaimed"),
        read<bigint>(cl, rd, "totalCompounded"),
      ]);
      const pnl = await Promise.all(
        rawStrategies.map((_, i) => read<[bigint, bigint, bigint]>(cl, pa, "strategyPnl", [BigInt(i)])),
      );
      const strategies = rawStrategies.map((s, i) => ({
        ...s,
        targetBps: Number(s.targetBps),
        riskScore: Number(s.riskScore),
        realizedGain: pnl[i][0],
        recognizedLoss: pnl[i][1],
      }));
      const lossCarryforward = await read<bigint>(cl, pa, "lossCarryforward", [totalAssets, totalSupply]);
      const blockTimestamp = Number((await cl.getBlock({ blockNumber })).timestamp);
      return {
        blockNumber, blockTimestamp, totalAssets, estimatedNav, idle, availableLiquidity, totalSupply, pricePerShare, depositCap,
        minDeposit, paused, guardedLaunch, withdrawalsFrozenUntil, lastHarvest,
        performanceFeeBps: Number(performanceFeeBps), harvestCostBps: Number(harvestCostBps), harvestCostCap,
        minReserveBps: Number(minReserveBps), reserveTargetBps: Number(reserveTargetBps), strategies, highWaterMark,
        lossCarryforward, cumulativeRealizedGain, cumulativeRecognizedLoss, cumulativeExecutionCost,
        cumulativeRecovered, cumulativeFees, cumulativeRewards, rewardLiabilities, fundingSurplus, totalClaimed,
        totalCompounded,
      };
    },
  });
}

export interface UserData {
  usdtBalance: bigint;
  allowance: bigint;
  shares: bigint;
  positionValue: bigint;
  maxWithdraw: bigint;
  maxRedeem: bigint;
  pendingReward: bigint;
  claimed: bigint;
  compounded: bigint;
  autoCompound: boolean;
  isDepositor: boolean;
}

export function useUserData(account?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["user", account, deployment?.contracts.AMYEVault],
    enabled: !!client && !!deployment && !!account,
    refetchInterval: 15_000,
    queryFn: async (): Promise<UserData> => {
      const cl = client!;
      const { vault, distributor: rd, usdt } = contracts;
      const depositorRole = await read<`0x${string}`>(cl, vault, "DEPOSITOR_ROLE");
      const [usdtBalance, allowance, shares, maxWithdraw, maxRedeem, pendingReward, claimed, compounded, autoCompound, isDepositor] =
        await Promise.all([
          read<bigint>(cl, usdt, "balanceOf", [account]),
          read<bigint>(cl, usdt, "allowance", [account, vault.address]),
          read<bigint>(cl, vault, "balanceOf", [account]),
          read<bigint>(cl, vault, "maxWithdraw", [account]),
          read<bigint>(cl, vault, "maxRedeem", [account]),
          read<bigint>(cl, rd, "pendingReward", [account]),
          read<bigint>(cl, rd, "claimedBy", [account]),
          read<bigint>(cl, rd, "compoundedBy", [account]),
          read<boolean>(cl, rd, "autoCompound", [account]),
          read<boolean>(cl, vault, "hasRole", [depositorRole, account]),
        ]);
      const positionValue = await read<bigint>(cl, vault, "convertToAssets", [shares]);
      return { usdtBalance, allowance, shares, positionValue, maxWithdraw, maxRedeem, pendingReward, claimed, compounded, autoCompound, isDepositor };
    },
  });
}

export interface RoleData {
  isKeeper: boolean;
  isGuardian: boolean;
}

export function useRoles(account?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["roles", account, deployment?.contracts.AMYEVault],
    enabled: !!client && !!deployment && !!account,
    queryFn: async (): Promise<RoleData> => {
      const cl = client!;
      const v = contracts.vault;
      const [keeperRole, guardianRole] = await Promise.all([
        read<`0x${string}`>(cl, v, "KEEPER_ROLE"),
        read<`0x${string}`>(cl, v, "GUARDIAN_ROLE"),
      ]);
      const [isKeeper, isGuardian] = await Promise.all([
        read<boolean>(cl, v, "hasRole", [keeperRole, account]),
        read<boolean>(cl, v, "hasRole", [guardianRole, account]),
      ]);
      return { isKeeper, isGuardian };
    },
  });
}

// ------------------------------------------------------------------------------------------------ events

export interface ChainEvent {
  contract: string;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
  timestamp?: number;
}

const CHUNK = 4_000n; // public BSC RPCs cap eth_getLogs ranges; the backend indexer removes this limit
const MAX_RANGE = 200_000n; // browser fallback scans at most this many recent blocks

async function fetchLogs(cl: PublicClient, address: Address, from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = [];
  for (let start = from; start <= to; start += CHUNK) {
    const end = start + CHUNK - 1n < to ? start + CHUNK - 1n : to;
    out.push(...(await cl.getLogs({ address, fromBlock: start, toBlock: end })));
  }
  return out;
}

export function useEvents() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["events", deployment?.contracts.AMYEVault],
    enabled: !!client && !!deployment,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ChainEvent[]> => {
      const cl = client!;
      const latest = await cl.getBlockNumber();
      const start = BigInt(deployment!.startBlock ?? 0);
      const from = latest - start > MAX_RANGE ? latest - MAX_RANGE : start;
      const sources = [
        ["AMYEVault", contracts.vault],
        ["RewardDistributor", contracts.distributor],
        ["ProfitAccounting", contracts.profitAccounting],
        ["RiskController", contracts.risk],
        ["AdaptiveYieldRouter", contracts.router],
      ] as const;
      const all: ChainEvent[] = [];
      for (const [name, c] of sources) {
        const logs = await fetchLogs(cl, c.address as Address, from, latest);
        for (const l of parseEventLogs({ abi: c.abi, logs })) {
          all.push({
            contract: name,
            eventName: l.eventName,
            args: (l.args ?? {}) as Record<string, unknown>,
            blockNumber: l.blockNumber,
            txHash: l.transactionHash,
            logIndex: l.logIndex,
          });
        }
      }
      // Timestamps for the blocks we show (deduplicated).
      const blocks = [...new Set(all.map((e) => e.blockNumber))];
      const times = new Map<bigint, number>();
      await Promise.all(blocks.map(async (b) => times.set(b, Number((await cl.getBlock({ blockNumber: b })).timestamp))));
      for (const e of all) e.timestamp = times.get(e.blockNumber);
      return all.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
    },
  });
}
