import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { parseUnits, type Address } from "viem";
import { contracts } from "../config";
import { useEvents, useProtocolData, useUserData, type ChainEvent } from "../hooks/useChainData";
import { useTx } from "../hooks/useTx";
import { Badge, Card, RiskMeter, Stat, TxLink, TxStatus } from "../components/ui";
import { AllocationChart, PerformanceChart } from "../components/Charts";
import { bps, fmt, fmtUsd, pct, ratio } from "../lib/format";
import { trailingYield } from "../lib/yield";

function parseAmount(input: string): bigint | null {
  if (!/^\d+(\.\d{0,18})?$/.test(input.trim())) return null;
  try {
    return parseUnits(input.trim(), 18);
  } catch {
    return null;
  }
}

export function UserDashboard() {
  const { address } = useAccount();
  const protocol = useProtocolData();
  const user = useUserData(address);
  const events = useEvents();
  const p = protocol.data;
  const u = user.data;

  const myEvents = useMemo(() => {
    if (!address || !events.data) return [];
    const me = address.toLowerCase();
    const mine = (e: ChainEvent) =>
      ["owner", "user", "receiver"].some((k) => typeof e.args[k] === "string" && (e.args[k] as string).toLowerCase() === me);
    return events.data.filter((e) => ["Deposit", "Withdraw", "Claimed", "Compounded"].includes(e.eventName) && mine(e));
  }, [address, events.data]);

  const principal = useMemo(() => {
    // Net principal = deposits (excluding compounded rewards) - withdrawals, from on-chain events.
    const compoundedTx = new Set(myEvents.filter((e) => e.eventName === "Compounded").map((e) => e.txHash));
    return myEvents.reduce((acc, e) => {
      if (e.eventName === "Deposit" && !compoundedTx.has(e.txHash)) return acc + (e.args.assets as bigint);
      if (e.eventName === "Withdraw") return acc - (e.args.assets as bigint);
      return acc;
    }, 0n);
  }, [myEvents]);

  const ty = p && events.data ? trailingYield(events.data, p.totalAssets, p.blockTimestamp) : null;

  return (
    <div className="grid">
      {!address && (
        <Card className="span-all">
          <p className="lead">Connect a wallet to see your position. All figures below are read live from BNB Smart Chain.</p>
        </Card>
      )}

      <Card title="Your position" subtitle={address ? "Live from chain" : undefined} className="span-all">
        <div className="stats">
          <Stat label="Deposited principal" value={address ? fmtUsd(principal) : "—"} hint="Net deposits minus withdrawals" />
          <Stat label="Position value (book)" value={u ? fmtUsd(u.positionValue) : "—"} hint={u ? `${fmt(u.shares, 4)} amyUSDT shares` : undefined} />
          <Stat label="Vault share value" value={p ? fmt(p.pricePerShare, 6) : "—"} hint="USDT per share, excludes unrealized gains" />
          <Stat label="Pending reward" value={u ? fmtUsd(u.pendingReward) : "—"} hint="Realized & funded — claimable now" tone="good" />
          <Stat label="Claimed rewards" value={u ? fmtUsd(u.claimed) : "—"} />
          <Stat label="Compounded rewards" value={u ? fmtUsd(u.compounded) : "—"} />
          <Stat label="Total realized rewards" value={u ? fmtUsd(u.claimed + u.compounded + u.pendingReward) : "—"} hint="Claimed + compounded + pending" />
          <Stat label="Withdrawable now" value={u ? fmtUsd(u.maxWithdraw) : "—"} hint="Limited by vault liquidity" />
        </div>
      </Card>

      <ActionPanel />

      <Card title="Yield projection" subtitle="Backward-looking, not a promise">
        <div className="projection">
          <Stat
            label="Trailing realized net yield (annualized)"
            value={ty?.apr === null || !ty ? "Insufficient history" : pct(ty.apr)}
            hint={ty ? `${ty.settlements} settlement(s) over ${ty.windowDays.toFixed(1)} days, ${ty.rewards.toFixed(2)} USDT distributed` : undefined}
          />
          {ty?.apr != null && u && (
            <Stat
              label="If that rate simply continued — 30 days"
              value={`${((Number(u.positionValue) / 1e18) * ty.apr * (30 / 365)).toFixed(2)} USDT`}
              hint="Hypothetical illustration, not earned income"
            />
          )}
        </div>
        <p className="disclaimer">
          AMYE has <strong>no target or guaranteed return</strong>. Rewards exist only when strategies realize net profit;
          periods with zero rewards or losses are expected. Projections are shown separately from earned income and are
          never credited to your balance.
        </p>
      </Card>

      <Card title="Strategy allocation" subtitle={p ? `Book NAV ${fmtUsd(p.totalAssets)}` : undefined}>
        {p ? <AllocationChart data={p} /> : <Loading q={protocol} />}
      </Card>

      <Card title="Historical performance">
        {events.data ? <PerformanceChart events={events.data} /> : <Loading q={events} />}
      </Card>

      <Card title="Vault health & fees">
        {p ? (
          <div className="kv">
            <div><span>Estimated NAV (incl. unrealized)</span><span className="mono">{fmtUsd(p.estimatedNav)}</span></div>
            <div><span>Book NAV (withdrawable basis)</span><span className="mono">{fmtUsd(p.totalAssets)}</span></div>
            <div><span>Withdrawal liquidity</span><span className="mono">{fmtUsd(p.availableLiquidity)} ({pct(ratio(p.availableLiquidity, p.totalAssets))})</span></div>
            <div><span>Loss carryforward</span><span className="mono">{fmtUsd(p.lossCarryforward)}</span></div>
            <div><span>Recognized strategy losses (all time)</span><span className="mono">{fmtUsd(p.cumulativeRecognizedLoss)}</span></div>
            <div><span>Performance fee</span><span className="mono">{bps(p.performanceFeeBps)} of distributed profit</span></div>
            <div><span>Fees charged (all time)</span><span className="mono">{fmtUsd(p.cumulativeFees)}</span></div>
            <div><span>Keeper gas reimbursement</span><span className="mono">≤ {bps(p.harvestCostBps)} of gain, max {fmtUsd(p.harvestCostCap)}</span></div>
            <div><span>Execution costs (all time)</span><span className="mono">{fmtUsd(p.cumulativeExecutionCost)}</span></div>
          </div>
        ) : <Loading q={protocol} />}
      </Card>

      <Card title="Strategy risk" className="span-all">
        {p ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Strategy</th><th>Allocation</th><th>Target</th><th>Risk</th><th>Status</th></tr></thead>
              <tbody>
                {p.strategies.map((s) => (
                  <tr key={s.adapter}>
                    <td>{s.name}</td>
                    <td className="mono">{fmtUsd(s.bookValue)}</td>
                    <td className="mono">{bps(s.targetBps)}</td>
                    <td><RiskMeter score={s.riskScore} /></td>
                    <td>{!s.active ? <Badge tone="bad">Exited</Badge> : s.acceptingDeposits ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Deposits blocked</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Loading q={protocol} />}
      </Card>

      <Card title="Transaction history" className="span-all">
        {!address ? <div className="empty">Connect a wallet to see your transactions.</div> : myEvents.length === 0 ? (
          <div className="empty">No transactions yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Action</th><th>Amount</th><th>Transaction</th></tr></thead>
              <tbody>
                {[...myEvents].reverse().map((e) => (
                  <tr key={`${e.txHash}-${e.logIndex}`}>
                    <td className="small">{e.timestamp ? new Date(e.timestamp * 1000).toLocaleString("en-US") : "—"}</td>
                    <td>{labelFor(e)}</td>
                    <td className="mono">{fmtUsd((e.args.assets ?? e.args.amount) as bigint)}</td>
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

function labelFor(e: ChainEvent): string {
  return { Deposit: "Stake", Withdraw: "Unstake", Claimed: "Claim rewards", Compounded: "Compound rewards" }[e.eventName] ?? e.eventName;
}

function Loading({ q }: { q: { isError: boolean; error: unknown } }) {
  return q.isError ? <div className="error">Could not read chain data: {String((q.error as Error)?.message ?? q.error)}</div> : <div className="skeleton" />;
}

function ActionPanel() {
  const { address } = useAccount();
  const { data: u } = useUserData(address);
  const { data: p } = useProtocolData();
  const tx = useTx();
  const [tab, setTab] = useState<"stake" | "unstake" | "rewards">("stake");
  const [amount, setAmount] = useState("");
  const parsed = parseAmount(amount);
  const busy = ["simulating", "signing", "pending"].includes(tx.state.status);
  const vault = contracts.vault.address as Address;

  const stakeBlock = !address ? "Connect a wallet"
    : !p ? "Loading…"
    : p.paused ? "Deposits are paused"
    : p.guardedLaunch && !u?.isDepositor ? "Guarded beta: your address is not on the depositor allowlist"
    : null;

  async function stake() {
    if (!parsed) return;
    if ((u?.allowance ?? 0n) < parsed) {
      const ok = await tx.send({ label: "Approve USDT", address: contracts.usdt.address as Address, abi: contracts.usdt.abi, functionName: "approve", args: [vault, parsed] });
      if (!ok) return;
    }
    if (await tx.send({ label: "Stake", address: vault, abi: contracts.vault.abi, functionName: "deposit", args: [parsed, address] })) setAmount("");
  }

  async function unstake() {
    if (!parsed) return;
    if (await tx.send({ label: "Partial unstake", address: vault, abi: contracts.vault.abi, functionName: "withdraw", args: [parsed, address, address] })) setAmount("");
  }

  const rd = { address: contracts.distributor.address as Address, abi: contracts.distributor.abi };

  return (
    <Card title="Manage" className="actions">
      <div className="tabs" role="tablist">
        {(["stake", "unstake", "rewards"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => { setTab(t); setAmount(""); }}>
            {t === "stake" ? "Stake" : t === "unstake" ? "Unstake" : "Rewards"}
          </button>
        ))}
      </div>

      {tab !== "rewards" && (
        <div className="field">
          <label htmlFor="amt">Amount (USDT)</label>
          <div className="input-row">
            <input id="amt" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn-ghost small" onClick={() => setAmount(((tab === "stake" ? u?.usdtBalance : u?.maxWithdraw) ?? 0n) === 0n ? "" : fmt(tab === "stake" ? u!.usdtBalance : u!.maxWithdraw, 6).replace(/,/g, ""))}>Max</button>
          </div>
          <div className="muted small">
            {tab === "stake" ? `Wallet: ${fmtUsd(u?.usdtBalance)} · Min deposit ${fmtUsd(p?.minDeposit)}` : `Withdrawable now: ${fmtUsd(u?.maxWithdraw)}`}
          </div>
          {amount && !parsed && <div className="error small">Enter a valid amount</div>}
        </div>
      )}

      {tab === "stake" && (
        <>
          {stakeBlock && <div className="notice">{stakeBlock}</div>}
          <button className="btn-primary" disabled={!!stakeBlock || !parsed || busy} onClick={stake}>
            {u && parsed && u.allowance < parsed ? "Approve & stake" : "Stake USDT"}
          </button>
        </>
      )}

      {tab === "unstake" && (
        <div className="btn-row">
          <button className="btn-primary" disabled={!address || !parsed || busy} onClick={unstake}>Partial unstake</button>
          <button className="btn-secondary" disabled={!address || !u || u.maxRedeem === 0n || busy}
            onClick={() => tx.send({ label: "Full unstake", address: vault, abi: contracts.vault.abi, functionName: "redeem", args: [u!.maxRedeem, address, address] })}>
            Full unstake
          </button>
          {u && u.maxRedeem < u.shares && <div className="notice">Vault liquidity currently limits withdrawals to {fmtUsd(u.maxWithdraw)}.</div>}
        </div>
      )}

      {tab === "rewards" && (
        <>
          <Stat label="Pending realized reward" value={fmtUsd(u?.pendingReward)} tone="good" />
          <div className="btn-row">
            <button className="btn-primary" disabled={!u || u.pendingReward === 0n || busy} onClick={() => tx.send({ label: "Claim rewards", ...rd, functionName: "claim" })}>Claim</button>
            <button className="btn-secondary" disabled={!u || u.pendingReward === 0n || busy || p?.paused} onClick={() => tx.send({ label: "Compound rewards", ...rd, functionName: "compound" })}>Compound</button>
          </div>
          <label className="toggle">
            <input type="checkbox" disabled={!address || busy} checked={!!u?.autoCompound}
              onChange={(e) => tx.send({ label: e.target.checked ? "Enable auto-compound" : "Disable auto-compound", ...rd, functionName: "setAutoCompound", args: [e.target.checked] })} />
            <span>Automatic compounding <span className="muted small">— keepers may redeposit your rewards into your own position</span></span>
          </label>
        </>
      )}

      <TxStatus state={tx.state} onDismiss={tx.reset} />
      {tab === "stake" && <p className="muted small">USDT approval is requested for the exact amount only, never an unlimited allowance.</p>}
    </Card>
  );
}
