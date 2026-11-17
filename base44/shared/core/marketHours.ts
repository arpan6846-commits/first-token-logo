// Market-hours awareness. All exchange times are IST (UTC+05:30, no DST).
// NSE holidays change yearly: load the official NSE list into `holidays`
// (YYYY-MM-DD). An empty list means "unknown", and the app warns about it.

const IST_OFFSET_MS = 330 * 60 * 1000;

export function istParts(ts: number): { date: string; minutes: number; weekday: number } {
  const d = new Date(ts + IST_OFFSET_MS);
  const date = d.toISOString().slice(0, 10);
  return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

export function istDate(ts: number): string {
  return istParts(ts).date;
}

/** Monday (IST) of the week containing ts, as YYYY-MM-DD. */
export function istWeekStart(ts: number): string {
  const { weekday } = istParts(ts);
  const back = (weekday + 6) % 7;
  return istDate(ts - back * 86_400_000);
}

export interface MarketCalendar {
  holidays: string[];
  openMinutes: number;   // 09:15
  closeMinutes: number;  // 15:30
}

export const NSE_CALENDAR: MarketCalendar = { holidays: [], openMinutes: 9 * 60 + 15, closeMinutes: 15 * 60 + 30 };

export function isNseTradingDay(ts: number, cal: MarketCalendar = NSE_CALENDAR): boolean {
  const { date, weekday } = istParts(ts);
  return weekday !== 0 && weekday !== 6 && !cal.holidays.includes(date);
}

export function isNseOpen(ts: number, cal: MarketCalendar = NSE_CALENDAR): boolean {
  if (!isNseTradingDay(ts, cal)) return false;
  const { minutes } = istParts(ts);
  return minutes >= cal.openMinutes && minutes < cal.closeMinutes;
}

/** Next NSE trading date strictly after `date` (YYYY-MM-DD). Used for T+1 settlement. */
export function nextTradingDate(date: string, cal: MarketCalendar = NSE_CALENDAR): string {
  let t = Date.parse(`${date}T06:00:00Z`);
  for (let i = 0; i < 15; i++) {
    t += 86_400_000;
    if (isNseTradingDay(t, cal)) return istDate(t);
  }
  throw new Error('No trading day found within 15 days — check holiday calendar');
}

export function settlementDate(assetClass: 'EQUITY' | 'CRYPTO', tradeTs: number, cal: MarketCalendar = NSE_CALENDAR): string {
  const d = istDate(tradeTs);
  return assetClass === 'EQUITY' ? nextTradingDate(d, cal) : d;
}

export function marketStatus(ts: number, cal: MarketCalendar = NSE_CALENDAR): { nse: 'OPEN' | 'CLOSED'; crypto: 'OPEN'; holidayListLoaded: boolean } {
  return { nse: isNseOpen(ts, cal) ? 'OPEN' : 'CLOSED', crypto: 'OPEN', holidayListLoaded: cal.holidays.length > 0 };
}
