// Money helpers. All ledger amounts are integer paise (1 INR = 100 paise) to
// avoid floating-point drift. Prices and quantities stay as numbers, but every
// value that touches the ledger passes through `toPaise`.

export type Paise = number;

export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`Invalid rupee amount: ${rupees}`);
  return Math.round(rupees * 100);
}

export function toRupees(p: Paise): number {
  return p / 100;
}

/** Value of qty × price in paise, rounded half away from zero. */
export function notionalPaise(qty: number, price: number): Paise {
  if (!Number.isFinite(qty) || !Number.isFinite(price)) throw new Error('Invalid qty/price');
  return Math.round(qty * price * 100);
}

export function assertPaise(p: number, label = 'amount'): void {
  if (!Number.isInteger(p)) throw new Error(`${label} must be integer paise, got ${p}`);
}

export function formatInr(p: Paise, opts: { sign?: boolean } = {}): string {
  const r = p / 100;
  const s = Math.abs(r).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = r < 0 ? '-' : opts.sign && r > 0 ? '+' : '';
  return `${sign}₹${s}`;
}

/** Round a quantity down to the allowed decimals (never round up a buy). */
export function floorQty(qty: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(qty * f + 1e-9) / f;
}

/** Round a price to the instrument tick size. */
export function roundToTick(price: number, tick: number, mode: 'nearest' | 'down' | 'up' = 'nearest'): number {
  const n = price / tick;
  const k = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n);
  const decimals = Math.max(0, -Math.floor(Math.log10(tick)) + 2);
  return Number((k * tick).toFixed(decimals));
}

export function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}
