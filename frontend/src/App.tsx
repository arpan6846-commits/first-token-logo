import { useEffect, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { chain, deployment, deploymentError, isTestnet } from "./config";
import { short } from "./lib/format";
import { UserDashboard } from "./pages/UserDashboard";
import { AdminDashboard } from "./pages/AdminDashboard";

type Page = "user" | "admin";
const pageFromHash = (): Page => (window.location.hash === "#/admin" ? "admin" : "user");

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash());
  useEffect(() => {
    const on = () => setPage(pageFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span>
          <div>
            <div className="brand-name">AMYE</div>
            <div className="brand-sub">Adaptive Multi-Strategy Yield Engine</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          <a href="#/" className={page === "user" ? "active" : ""}>Dashboard</a>
          <a href="#/admin" className={page === "admin" ? "active" : ""}>Protocol</a>
        </nav>
        <Wallet />
      </header>

      {isTestnet && (
        <div className="banner" role="note">
          <strong>{chain.name} — test environment.</strong> Contracts are unaudited
          {deployment?.usesMocks ? " and use simulated test protocols and test USDT" : ""}. Do not send real funds.
          Public deposits stay closed until independent audits, legal review and stress testing are complete.
        </div>
      )}

      <main className="main">
        {deploymentError ? <div className="card error">{deploymentError}</div> : page === "user" ? <UserDashboard /> : <AdminDashboard />}
      </main>

      <footer className="footer muted small">
        Rewards come only from realized, net strategy profit. There is no guaranteed, fixed or target return, and you can
        lose principal through strategy, smart-contract or stablecoin failures. Every figure is read from {chain.name}.
      </footer>
    </div>
  );
}

function Wallet() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);

  if (isConnected && address) {
    return (
      <div className="wallet">
        {chainId !== chain.id && <button className="btn-danger small" onClick={() => switchChain({ chainId: chain.id })}>Switch to {chain.name}</button>}
        <span className="pill mono" data-testid="account">{short(address)}</span>
        <button className="btn-ghost small" onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button className="btn-primary" onClick={() => setOpen(!open)} disabled={isPending} data-testid="connect">
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className="menu" role="menu">
          {connectors.map((c) => (
            <button key={c.uid} role="menuitem" onClick={() => { connect({ connector: c, chainId: chain.id }); setOpen(false); }}>
              {c.name === "Injected" ? "Browser wallet (MetaMask, Trust, Binance…)" : c.name}
            </button>
          ))}
          {error && <div className="error small">{error.message.split("\n")[0]}</div>}
        </div>
      )}
    </div>
  );
}
