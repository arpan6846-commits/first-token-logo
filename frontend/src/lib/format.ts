import { formatUnits } from "viem";

export function fmt(value: bigint | undefined | null, digits = 2): string {
  if (value === undefined || value === null) return "—";
  const n = Number(formatUnits(value, 18));
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtUsd(value: bigint | undefined | null): string {
  return value === undefined || value === null ? "—" : `${fmt(value)} USDT`;
}

export function bps(value: number | bigint | undefined): string {
  return value === undefined ? "—" : `${(Number(value) / 100).toFixed(2)}%`;
}

export function pct(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export function short(addr?: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

export function ratio(a: bigint, b: bigint): number {
  return b === 0n ? 0 : Number((a * 1_000_000n) / b) / 1_000_000;
}
