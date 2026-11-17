import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import './index.css';
import { AppProvider } from './runtime/AppContext.tsx';
import { Layout } from './components/Layout.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Portfolio } from './pages/Portfolio.tsx';
import { Market } from './pages/Markets.tsx';
import { Signals } from './pages/Signals.tsx';
import { Trades } from './pages/Trades.tsx';
import { Ledger } from './pages/Ledger.tsx';
import { Risk } from './pages/Risk.tsx';
import { PropDesk } from './pages/PropDesk.tsx';
import { Connections } from './pages/Connections.tsx';
import { Automation } from './pages/Automation.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Audit } from './pages/Audit.tsx';

// Static hosting (single-file build) uses an in-memory router mirrored to a plain #name.
const HASH_ROUTER = import.meta.env.VITE_ROUTER === 'hash';
const toHash = (path: string) => (path === '/' ? '' : path.slice(1) === 'settings' ? 'app-settings' : path.slice(1));
const fromHash = () => { const h = window.location.hash.replace(/^#/, ''); return h === 'app-settings' ? '/settings' : h ? `/${h}` : '/'; };
function HashSync() {
  const loc = useLocation();
  useEffect(() => { try { history.replaceState(null, '', toHash(loc.pathname) ? `#${toHash(loc.pathname)}` : window.location.pathname + window.location.search); } catch { /* ignore */ } }, [loc.pathname]);
  return null;
}
function AppRouter({ children }: { children: ReactNode }) {
  return HASH_ROUTER ? <MemoryRouter initialEntries={[fromHash()]}><HashSync />{children}</MemoryRouter> : <BrowserRouter>{children}</BrowserRouter>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <AppRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="portfolio" element={<Portfolio />} />
            <Route path="stocks" element={<Market assetClass="EQUITY" />} />
            <Route path="crypto" element={<Market key="crypto" assetClass="CRYPTO" />} />
            <Route path="signals" element={<Signals />} />
            <Route path="trades" element={<Trades />} />
            <Route path="ledger" element={<Ledger />} />
            <Route path="risk" element={<Risk />} />
            <Route path="prop-desk" element={<PropDesk />} />
            <Route path="connections" element={<Connections />} />
            <Route path="automation" element={<Automation />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="audit" element={<Audit />} />
          </Route>
        </Routes>
      </AppRouter>
    </AppProvider>
  </React.StrictMode>,
);
