import { useAccount } from "wagmi";
import type { Address } from "viem";
import { contracts, deployment } from "../config";
import { useEvents, useProtocolData, useRoles, type ChainEvent, type ProtocolData } from "../hooks/useChainData";
import { useTx } from "../hooks/useTx";
import { Badge, Card, RiskMeter, Stat, TxLink, TxStatus } from "../components/ui";
import { AllocationChart, PerformanceChart } from "../components/Charts";
import { bps, fmt, fmtUsd, pct, ratio, short } from "../lib/format";

interface Alert {
  level: "critical" | "warning" | "info";
  text: string;
}

export function computeAlerts(p: ProtocolData, nowSec: number): Alert[] {
  const a: Alert[] = [];
  if (p.paused) a.push({ level: "critical", text: "Vault is PAUSED — deposits, rebalances and harvests are halted." });
  if (Number(p.withdrawalsFrozenUntil) > nowSec)
    a.push({ level: "critical", text: `Withdrawals frozen until ${new Date(Number(p.withdrawalsFrozenUntil) * 1000).toLocaleString("en-US")}.` });
  if (p.fundingSurplus < 0n) a.push({ level: "critical", text: "Reward liabilities exceed funded balance in RewardDistributor." });
  if (p.lossCarryforward > 0n) a.push({ level: "warning", text: `Loss carryforward of ${fmtUsd(p.lossCarryforward)}: no rewards until recovered.` });
  if (p.totalAssets > 0n && ratio(p.availableLiquidity, p.totalAssets) < p.minReserveBps / 10_000)
    a.push({ level: "warning", text: `Withdrawal liquidity ${pct(ratio(p.availableLiquidity, p.totalAssets))} is below the ${bps(p.minReserveBps)} reserve floor.` });
  for (const s of p.strategies) {
    if (!s.active) continue;
    if (!s.acceptingDeposits) a.push({ level: "warning", text: `${s.name}: not accepting deposits (blocked or risk score ${s.riskScore}).` });
    if (s.markValue < s.principal) a.push({ level: "warning", text: `${s.name}: unrealized loss of ${fmtUsd(s.principal - s.markValue)}.` });
    const actual = p.totalAssets ? ratio(s.bookValue, p.totalAssets) * 10_000 : 0;
    if (Math.abs(actual - s.targetBps) > 500) a.push({ level: "info", text: `${s.name}: allocation ${bps(actual)} drifts from target ${bps(s.targetBps)} — rebalance due.` });
  }
  if (p.lastHarvest > 0n && nowSec - Number(p.lastHarvest) > 3 * 86_400) a.push({ level: "info", text: "No harvest in the last 3 days." });
  return a;
}

export function AdminDashboard() {
  const { address } = useAccount();
  const protocol = useProtocolData();
  const events = useEvents();
  const roles = useRoles(address);
  const tx = useTx();
  const p = protocol.data;
  const now = p?.blockTimestamp ?? Math.floor(Date.now() / 1000);
  const vault = { address: contracts.vault.address as Address, abi: contracts.vault.abi };
  const busy = ["simulating", "signing", "pending"].includes(tx.state.status);

  if (!p) return <Card>{protocol.isError ? <div className="error">Could not read chain data: {(protocol.error as Error).message}</div> : <div className="skeleton" />}</Card>;
  const alerts = computeAlerts(p, now);
  const unrealized = p.estimatedNav - p.totalAssets;

  return (
    <div className="grid">
      <Card title="Protocol overview" subtitle={`Block ${p.blockNumber.toString()}`} className="span-all">
        <div className="stats">
          <Stat label="Total assets (book)" value={fmtUsd(p.totalAssets)} hint="Idle + min(principal, mark)" />
          <Stat label="Estimated NAV" value={fmtUsd(p.estimatedNav)} hint="Includes unrealized gains" />
          <Stat label="Unrealized P&L" value={fmtUsd(unrealized)} tone={unrealized < 0n ? "bad" : "good"} />
          <Stat label="Withdrawal liquidity" value={fmtUsd(p.availableLiquidity)} hint={pct(ratio(p.availableLiquidity, p.totalAssets))} />
          <Stat label="Reward liabilities" value={fmtUsd(p.rewardLiabilities)} hint={`Funding surplus ${fmt(p.fundingSurplus < 0n ? -p.fundingSurplus : p.fundingSurplus, 6)}${p.fundingSurplus < 0n ? " DEFICIT" : ""}`} tone={p.fundingSurplus < 0n ? "bad" : undefined} />
          <Stat label="Share value / HWM" value={`${fmt(p.pricePerShare, 6)} / ${fmt(p.highWaterMark, 6)}`} />
          <Stat label="Deposit cap" value={fmtUsd(p.depositCap)} hint={p.guardedLaunch ? "Guarded launch: allowlist only" : "Public deposits open"} />
          <Stat label="Shares outstanding" value={fmt(p.totalSupply, 2)} />
        </div>
      </Card>

      <Card title="Alerts" subtitle={`${alerts.length} active`} className="span-all">
        {alerts.length === 0 ? <div className="empty">No active alerts.</div> : (
          <ul className="alerts">
            {alerts.map((al, i) => <li key={i} className={`alert alert-${al.level}`}><Badge tone={al.level === "critical" ? "bad" : al.level === "warning" ? "warn" : "info"}>{al.level}</Badge> {al.text}</li>)}
          </ul>
        )}
      </Card>

      <Card title="Realized P&L (all time)">
        <div className="kv">
          <div><span>Realized gross gain</span><span className="mono">{fmtUsd(p.cumulativeRealizedGain)}</span></div>
          <div><span>Recognized losses</span><span className="mono bad">−{fmtUsd(p.cumulativeRecognizedLoss)}</span></div>
          <div><span>Execution costs</span><span className="mono">−{fmtUsd(p.cumulativeExecutionCost)}</span></div>
          <div><span>Retained to restore NAV</span><span className="mono">{fmtUsd(p.cumulativeRecovered)}</span></div>
          <div><span>Performance fees ({bps(p.performanceFeeBps)})</span><span className="mono">{fmtUsd(p.cumulativeFees)}</span></div>
          <div><span>Rewards distributed</span><span className="mono good">{fmtUsd(p.cumulativeRewards)}</span></div>
          <div><span>Claimed / compounded</span><span className="mono">{fmtUsd(p.totalClaimed)} / {fmtUsd(p.totalCompounded)}</span></div>
          <div><span>Loss carryforward</span><span className="mono">{fmtUsd(p.lossCarryforward)}</span></div>
        </div>
      </Card>

      <Card title="Allocation vs target"><AllocationChart data={p} /></Card>

      <Card title="Strategies" className="span-all">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Strategy</th><th>Target</th><th>Principal</th><th>Mark</th><th>Unrealized</th><th>Realized gain</th><th>Losses</th><th>Liquidity</th><th>Risk</th><th>Status</th></tr></thead>
            <tbody>
              {p.strategies.map((s, i) => (
                <tr key={s.adapter}>
                  <td>{s.name}<div className="muted small mono">{short(s.protocol)}</div></td>
                  <td className="mono">{bps(s.targetBps)}</td>
                  <td className="mono">{fmt(s.principal)}</td>
                  <td className="mono">{fmt(s.markValue)}</td>
                  <td className={`mono ${s.markValue < s.principal ? "bad" : "good"}`}>{s.markValue < s.principal ? "−" : ""}{fmt(s.markValue < s.principal ? s.principal - s.markValue : s.markValue - s.principal)}</td>
                  <td className="mono">{fmt(s.realizedGain)}</td>
                  <td className="mono">{fmt(s.recognizedLoss)}</td>
                  <td className="mono">{fmt(s.availableLiquidity)}</td>
                  <td><RiskMeter score={s.riskScore} /></td>
                  <td>
                    {!s.active ? <Badge tone="bad">Exited</Badge> : s.acceptingDeposits ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Blocked</Badge>}
                    {roles.data?.isGuardian && s.active && (
                      <button className="btn-danger small" disabled={busy}
                        onClick={() => window.confirm(`Exit ${s.name}? All funds return to the vault and the strategy is deactivated.`) &&
                          tx.send({ label: `Emergency exit ${s.name}`, ...vault, functionName: "emergencyExitStrategy", args: [BigInt(i)] })}>
                        Exit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Operations" subtitle={address ? `Connected ${short(address)}` : "Connect to see your roles"}>
        <div className="roles">
          <Badge tone={roles.data?.isKeeper ? "good" : "neutral"}>Keeper {roles.data?.isKeeper ? "✓" : "—"}</Badge>
          <Badge tone={roles.data?.isGuardian ? "good" : "neutral"}>Guardian {roles.data?.isGuardian ? "✓" : "—"}</Badge>
        </div>
        {roles.data?.isKeeper && (
          <div className="btn-row">
            <button className="btn-primary" disabled={busy || p.paused} onClick={() => tx.send({ label: "Harvest", ...vault, functionName: "harvest", args: [0n] })}>Harvest</button>
            <button className="btn-secondary" disabled={busy || p.paused} onClick={() => tx.send({ label: "Rebalance", ...vault, functionName: "rebalance" })}>Rebalance</button>
          </div>
        )}
        {roles.data?.isGuardian && (
          <div className="btn-row">
            <button className="btn-danger" disabled={busy || p.paused} onClick={() => window.confirm("Pause the vault? Only governance (timelock) can unpause.") && tx.send({ label: "Pause", ...vault, functionName: "pause" })}>Emergency pause</button>
            <button className="btn-secondary" disabled={busy} onClick={() => window.confirm("Freeze withdrawals for 24 hours?") && tx.send({ label: "Freeze withdrawals 24h", ...vault, functionName: "freezeWithdrawals", args: [86_400n] })}>Freeze withdrawals 24h</button>
          </div>
        )}
        <TxStatus state={tx.state} onDismiss={tx.reset} />
        <p className="muted small">
          Governance changes (targets, caps, fees, unpausing, opening public deposits) can only be proposed by the multisig{" "}
          <span className="mono">{short(deployment?.roles.multisig)}</span> and execute after the {Math.round((deployment?.roles.timelockDelaySeconds ?? 0) / 3600)}h timelock.
          This dashboard never holds keys.
        </p>
      </Card>

      <Card title="Performance"><PerformanceChart events={events.data ?? []} /></Card>

      <Card title="Contract events" className="span-all">
        {!events.data ? <div className="skeleton" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Contract</th><th>Event</th><th>Details</th><th>Tx</th></tr></thead>
              <tbody>
                {[...events.data].reverse().slice(0, 50).map((e) => (
                  <tr key={`${e.txHash}-${e.logIndex}`}>
                    <td className="small">{e.timestamp ? new Date(e.timestamp * 1000).toLocaleString("en-US") : "—"}</td>
                    <td className="small">{e.contract}</td>
                    <td>{e.eventName}</td>
                    <td className="small mono">{describe(e)}</td>
                    <td><TxLink hash={e.txHash} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function describe(e: ChainEvent): string {
  return Object.entries(e.args)
    .filter(([k]) => Number.isNaN(Number(k)))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "bigint" ? (v > 10n ** 12n ? fmt(v) : v.toString()) : typeof v === "string" && v.startsWith("0x") ? short(v) : String(v)}`)
    .join(" ");
}
