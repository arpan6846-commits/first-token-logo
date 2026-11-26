import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUnits } from "viem";
import type { ChainEvent, ProtocolData } from "../hooks/useChainData";

const PALETTE = ["#5b8cff", "#2fd3a7", "#f0b94a", "#8a94a8", "#c084fc", "#f472b6"];
const num = (v: bigint) => Number(formatUnits(v, 18));

export function AllocationChart({ data }: { data: ProtocolData }) {
  const slices = [
    ...data.strategies.map((s) => ({ name: s.name, value: num(s.bookValue), target: s.targetBps / 100 })),
    { name: "Liquid reserve", value: num(data.idle), target: data.reserveTargetBps / 100 },
  ];
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <div className="alloc">
      <div className="alloc-chart" aria-hidden={total === 0}>
        {total === 0 ? (
          <div className="empty">No capital deployed yet</div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="none">
                {slices.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Pie>
              <Tooltip formatter={(v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`} contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
      <ul className="legend">
        {slices.map((s, i) => (
          <li key={s.name}>
            <span className="dot" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="legend-name">{s.name}</span>
            <span className="mono">{total ? ((s.value / total) * 100).toFixed(1) : "0.0"}%</span>
            <span className="muted small mono">target {s.target.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const tooltipStyle = { background: "#121826", border: "1px solid #253047", borderRadius: 8, color: "#e6ebf5" };

/** Share value and cumulative distributed rewards over time, built from on-chain Settled events. */
export function PerformanceChart({ events }: { events: ChainEvent[] }) {
  let cumulativeRewards = 0;
  const points = events
    .filter((e) => e.eventName === "Settled" || e.eventName === "RewardNotified")
    .reduce<{ t: number; pps?: number; rewards: number }[]>((acc, e) => {
      if (e.eventName === "RewardNotified") cumulativeRewards += num(e.args.amount as bigint);
      if (e.eventName === "Settled") {
        acc.push({ t: (e.timestamp ?? 0) * 1000, pps: num(e.args.pricePerShare as bigint), rewards: cumulativeRewards });
      } else if (acc.length) {
        acc[acc.length - 1].rewards = cumulativeRewards;
      }
      return acc;
    }, []);
  if (points.length === 0) return <div className="empty">No harvests yet — performance history appears after the first realized settlement.</div>;
  return (
    <div className="perf">
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
          <defs>
            <linearGradient id="gr" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2fd3a7" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#2fd3a7" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1c2436" vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })} stroke="#5f6b82" fontSize={11} />
          <YAxis yAxisId="r" stroke="#5f6b82" fontSize={11} width={56} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => new Date(t as number).toLocaleString("en-US")} formatter={(v: number, n) => [n === "rewards" ? `${v.toFixed(2)} USDT` : v.toFixed(6), n === "rewards" ? "Cumulative realized rewards" : "Share value"]} />
          <Area yAxisId="r" type="stepAfter" dataKey="rewards" stroke="#2fd3a7" fill="url(#gr)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
      <p className="muted small">Cumulative rewards distributed from realized, net profit at each settlement. Past results do not predict future results.</p>
    </div>
  );
}
