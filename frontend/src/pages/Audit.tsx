import { useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, NotConnected, PageHeader, Section, istTime } from '../components/ui.tsx';

export function Audit() {
  const { state } = useApp();
  const [q, setQ] = useState('');
  if (!state.connected) return <><PageHeader title="Audit logs" /><NotConnected env={state.environment} /></>;
  const rows = state.audit.filter((a) => !q || `${a.actor} ${a.action} ${JSON.stringify(a.details)}`.toLowerCase().includes(q.toLowerCase()));
  const c = state.auditChain;
  return (
    <>
      <PageHeader title="Audit logs" subtitle="Append-only, hash-chained record of every owner, system and AI action. Any edit to a stored record breaks the chain and is detected." />
      <Section title="Integrity" right={<input className="input !w-64" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />}>
        {c && <div className={`flex items-center gap-2 text-sm ${c.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{c.ok ? <ShieldCheck size={16} /> : <ShieldX size={16} />}{c.ok ? `Audit chain verified (${c.records} records)` : `Audit chain broken at ${c.brokenAt}`}</div>}
      </Section>
      <Section title={`Records (${rows.length})`} className="mt-4">
        {rows.length === 0 ? <Empty>No audit records.</Empty> : (
          <div className="max-h-[70vh] overflow-auto"><table className="data"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Env</th><th>Details</th><th>Hash</th></tr></thead>
            <tbody>{rows.slice(0, 500).map((a) => <tr key={a.id}><td className="whitespace-nowrap text-xs text-slate-400">{istTime(a.ts)}</td><td className={`text-xs ${a.actor === 'ai' ? 'text-indigo-300' : a.actor === 'owner' ? 'text-emerald-300' : ''}`}>{a.actor}</td><td className="font-mono text-xs">{a.action}</td><td className="text-xs">{a.environment}</td><td className="max-w-[480px] break-all font-mono text-[10px] text-slate-400">{JSON.stringify(a.details)}</td><td className="font-mono text-[10px] text-slate-500">{a.hash.slice(0, 10)}…</td></tr>)}</tbody></table></div>
        )}
      </Section>
    </>
  );
}
