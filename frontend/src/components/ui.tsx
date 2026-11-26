import type { ReactNode } from "react";
import { explorerTx } from "../config";
import type { TxState } from "../hooks/useTx";
import { short } from "../lib/format";

export function Card({ title, subtitle, children, className = "" }: { title?: string; subtitle?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <h2>{title}</h2>
          {subtitle && <span className="muted small">{subtitle}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function TxLink({ hash }: { hash: string }) {
  const url = explorerTx(hash);
  return url ? (
    <a className="mono" href={url} target="_blank" rel="noreferrer">{short(hash)} ↗</a>
  ) : (
    <span className="mono">{short(hash)}</span>
  );
}

export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss: () => void }) {
  if (state.status === "idle") return null;
  const tone = state.status === "confirmed" ? "good" : state.status === "failed" ? "bad" : "info";
  const text: Record<TxState["status"], string> = {
    idle: "",
    simulating: "Checking transaction against current chain state…",
    signing: "Waiting for your signature in the wallet…",
    pending: "Submitted. Waiting for confirmation on BNB Smart Chain…",
    confirmed: "Confirmed on-chain.",
    failed: "Failed.",
  };
  return (
    <div className={`txstatus tone-${tone}`} role="status" aria-live="polite" data-testid="tx-status" data-status={state.status}>
      <div>
        <strong>{state.label}:</strong> {text[state.status]}
        {state.status === "failed" && <span> {state.error}</span>}
        {"hash" in state && state.hash && <> · <TxLink hash={state.hash} /></>}
        {state.status === "confirmed" && <span className="muted"> · block {state.block.toString()}</span>}
      </div>
      {(state.status === "confirmed" || state.status === "failed") && (
        <button className="btn-ghost small" onClick={onDismiss} aria-label="Dismiss">✕</button>
      )}
    </div>
  );
}

export function RiskMeter({ score }: { score: number }) {
  const tone = score >= 80 ? "bad" : score >= 60 ? "warn" : "good";
  return (
    <span className={`risk risk-${tone}`} title={`Risk score ${score}/100 (higher = riskier)`}>
      <span className="risk-bar"><span style={{ width: `${score}%` }} /></span>
      <span className="mono small">{score}</span>
    </span>
  );
}
