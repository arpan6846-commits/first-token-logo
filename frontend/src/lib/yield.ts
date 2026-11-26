import { formatUnits } from "viem";
import type { ChainEvent } from "../hooks/useChainData";

export interface TrailingYield {
  /** Net realized yield to holders, annualized (simple, not compounded). null when history is too short. */
  apr: number | null;
  windowDays: number;
  rewards: number;
  settlements: number;
}

const DAY = 86_400;
const MIN_DAYS = 7;

/**
 * Trailing realized yield over the last `windowDays`: rewards actually distributed to holders (after
 * losses, costs and fees) divided by current book NAV, annualized. Deliberately backward-looking — it is
 * a measurement of what happened, never a forecast or a promise.
 */
export function trailingYield(events: ChainEvent[], totalAssets: bigint, nowSec: number, windowDays = 30): TrailingYield {
  const settled = events.filter((e) => e.eventName === "Settled" && e.timestamp);
  const rewardsEvents = events.filter((e) => e.eventName === "RewardNotified" && e.timestamp);
  if (settled.length === 0 || totalAssets === 0n) return { apr: null, windowDays: 0, rewards: 0, settlements: 0 };
  const first = settled[0].timestamp!;
  const since = Math.max(nowSec - windowDays * DAY, first);
  const span = Math.max(0, (nowSec - since) / DAY);
  const rewards = rewardsEvents
    .filter((e) => e.timestamp! >= since)
    .reduce((a, e) => a + Number(formatUnits(e.args.amount as bigint, 18)), 0);
  const tvl = Number(formatUnits(totalAssets, 18));
  const settlements = settled.filter((e) => e.timestamp! >= since).length;
  if (span < MIN_DAYS) return { apr: null, windowDays: span, rewards, settlements };
  return { apr: (rewards / tvl) * (365 / span), windowDays: span, rewards, settlements };
}
