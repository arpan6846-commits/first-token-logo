# Status: what is complete, tested, simulated, or awaiting credentials

Legend: **Complete + tested** = code exists and automated tests exercise it. **Tested offline** = verified against mocked APIs or fakes, never against the real service. **Simulated** = runs on synthetic data only. **Awaiting credentials/deployment** = cannot be verified until real accounts, secrets and hosting exist.

Nothing in this repository has connected to Zerodha, CoinDCX, Base44 or Anthropic. This session had no credentials, and `kite.trade` and `docs.coindcx.com` were blocked by its network policy. API shapes were checked against the official docs through the Context7 documentation service.

## Engine (`core/`)

| Function | Status |
|---|---|
| Double-entry ledger (integer paise, balanced entries, idempotent posting, SHA-256 hash chain, append-only, per-environment books) | Complete + tested (tamper detection proven) |
| Hard separation simulation / paper / production (production ledger refuses SIMULATED/PAPER data; production OMS refuses non-LIVE adapters) | Complete + tested |
| Deterministic risk engine: 0.5%/trade incl. costs, 1% daily stop, 3% weekly stop, 50% exposure, no leverage/shorting/MIS/futures, stale data, expired session, unreconciled balances, venue down, kill switch, phase gate, cost/R:R gates, sector caps, revenge-trade block, loss-streak cooldown, ₹100–4000 universe, TF ≥ 5m, Final Check | Complete + tested |
| Order manager: idempotency keys (DB unique + venue client id), venue-confirmed status only, UNKNOWN on timeout resolved by client id (never re-sent), partial fills, rejections, cancels, fill de-duplication | Complete + tested (paper venue + mocked live APIs) |
| Protective exits (stop/target, reduce-only, allowed even under kill switch; pre-approved by the owner's plan) | Complete + tested |
| Compounding: verified + settled (T+1 equity) + net of fees and estimated tax; high-water mark; configurable reinvest %; equity reclassification only | Complete + tested |
| Tax reserve (crypto VDA flat rate without loss set-off, 1% TDS receivable, equity speculative/STCG) | Complete + tested, **rates are estimates to verify** |
| Fee model (Zerodha delivery, CoinDCX spot) | Complete + tested, **rates are estimates to verify**; broker-reported fees override where provided |
| Reconciliation (cash, holdings, trades, UNKNOWN orders; mismatch blocks production orders) | Complete + tested (paper venue) |
| Daily snapshots, drawdown, daily/cumulative return | Complete + tested |
| Settings governance (owner-only, typed confirmation, loosening deferred to next trading day, hard ceilings, AI/system refused) | Complete + tested |
| Audit log (hash-chained, append-only) | Complete + tested |
| Idempotent job runner (run keys) | Complete + tested |
| Phase gates 1→5 + compliance checklist | Complete; criteria evaluated in UI |

## Prop trading desk (skill features)

| Feature | Status |
|---|---|
| Territory (reacted level, sustained 2-close break, initiator, flip on initiator break) | Complete + tested (heuristic) |
| Momentum retracement classes (10/20/50/>50/60–70/100%) on closes | Complete + tested |
| 4-touch range / build-up, V-formation (normal/lopsided), probes, PDH/PDL, volatility class, V-based 70/30 dominance, liquidity-crunch heuristic | Complete + tested (heuristics) |
| Trade plan: entry on confirmed build-up break (never the breaking candle, no chasing > 0.5 ATR), stop beyond V/build-up, **target = next price-action level (no fixed multiples)**, R:R and qty with reverse checks | Complete + tested |
| 100-point Final Check: auto items from data, manual owner items (calendar, data impact, fundamentals, profile) and written pre-trade journal required outside simulation | Complete + tested |
| Retail illusion, five area questions, invalidation, rationale per signal | Complete |
| Daily risk tier by measured accuracy (0.25/0.5/0.75–1%, lowest tier until ≥ 30 trades) | Complete + tested |
| Sector scoring, universe filter, sector tendency, max 2–3 trades per sector, range-trade ≤ 20% | Complete + tested |
| Journal (pre/post-trade, psychology), 3×3×3 profile scenarios, trader stage, psychology alerts | Complete (UI + engine) |
| Long–short spread tracker (P/E rule, spread stop, 2-week review) | Complete as **analysis only**: shorting is impossible in a cash/spot account |
| Inside-bar math, pyramiding schedule | Complete + tested (calculators; pyramiding is not auto-executed) |
| Economic calendar | **Manual** (Final Check items 1–2). No calendar feed is integrated. |
| Mode A/B narrative (market deep analysis in Hinglish) | Partial: deterministic facts in UI; the optional Claude review adds narrative but can only downgrade |

## Integrations

| Integration | Status |
|---|---|
| Kite Connect adapter (orders, trades, holdings+positions, margins, quotes, historical, instruments dump, session checksum, postback checksum, ticker parser) | **Tested offline** (mocked fetch); **awaiting credentials** |
| CoinDCX adapter (signed orders, status by client id, trade history, balances; ticker/candles/markets marked `[VERIFY]`) | **Tested offline**; **awaiting credentials** |
| Paper adapter | Complete + tested |
| Kite WebSocket ticker (full mode), CoinDCX REST polling, candle builder | Written; parser and candle builder tested; the live sockets are **awaiting credentials** |
| Claude AI review (`claude-opus-5-5`, structured JSON output, server-side refusal fallback, conservative merge only) | Merge logic tested; function **awaiting `ANTHROPIC_API_KEY`** |

## Base44 + worker

| Component | Status |
|---|---|
| 19 entity schemas with owner-only read RLS, no browser writes, encrypted-session fields hidden by FLS | Generated; **schema-drift test passes**; RLS syntax follows Base44 docs but is **unverified on a live app** |
| Base44Repo (id⇄uid, pagination, uniqueness checks, append-only) | Tested against a fake Base44 API |
| Functions (ownerCommand, kiteLogin/Callback/Postback, workerGateway, aiReviewSignal, revokeCredentials, watchdog, dailyReport) | Type-checked against shims; **not deployed** (Deno/Base44 CLI unavailable here) |
| Worker (single writer, commands, feeds, scheduler, heartbeat) | Type-checked; gateway protocol and command execution tested in Node; **not run under Deno** |

## Frontend

| | Status |
|---|---|
| 13 screens (Dashboard, Portfolio, Stocks, Crypto, AI signals, Trade history, Compounding ledger, Risk monitor, Prop desk, API connections, Automation, Settings, Audit) | Complete; built; smoke-tested in Chromium with no console errors, no horizontal overflow at 390px |
| Local simulation runtime (real engine in browser, seeded synthetic market, scripted setup) | Complete + browser-tested |
| Base44 runtime (`VITE_DATA_MODE=base44`) | Written + type-checked; **awaiting deployment** |

## Key findings you should know

1. **Costs dominate at ₹10,000.** With 0.5% risk per trade (₹50), a Zerodha delivery round trip costs about ₹20–26 on a ₹2–5k position: STT 0.1% on each side plus the ~₹15.93 DP charge per sell. That is 40–110% of the price risk. Under the default cost gate (costs ≤ 25% of price risk) the engine rejects nearly every stock trade. Crypto at about 1.2% round-trip fees has the same problem. This is the true economics, not a bug. Options: (a) accept a higher cost ratio (owner-confirmed setting; the net-of-costs R:R ≥ 2 rule still applies), (b) larger capital per trade, (c) only take setups with wide targets. The app will not decide this for you.
2. **About one trade a day.** A 0.5% daily risk budget (₹50) is used up by one trade at ₹47–50 of risk.
3. **A 10%/day target is not reachable at these risk limits.** Even a perfect 1:5 trade risking 0.5% returns 2.5%. The limits stay as you set them, and the app never raises risk to chase the target.
4. **Kite access tokens expire daily.** The owner must log in every trading day; there is no password/TOTP automation, by design and per broker terms.
5. **The signal heuristics are approximations** of a discretionary method. On random-walk data they validate almost nothing (0 of 428 evaluations), which is correct behaviour on noise. Real edge must be shown in Phase 3 backtests and paper trading before any real money is used.

## Known limitations

- Base44 does not enforce unique indexes, so the worker is the single writer and venue client order ids are the final duplicate guard. Two workers must never run against the same app.
- The gateway's replay protection is per-isolate memory. Operations are idempotent, so a cross-isolate replay can't double-execute, but it isn't a global nonce store.
- Kite `/trades` only returns today's trades. Older fills must be reconciled from contract notes or the Console tradebook (not automated).
- Kite charges aren't in the trade book. Fills use the fee model until contract-note charges are imported (not automated).
- CoinDCX TDS is estimated. Reconcile it against the exchange's TDS statement.
- The NSE holiday calendar isn't bundled. Load the official list; until then the UI warns.
- Stock instrument metadata (tick and lot sizes) comes from the Kite instruments dump at runtime. The seed values are for simulation only, and NSE tick sizes changed in 2025.
- The CoinDCX live feed is REST polling (5 s), not WebSocket.
- There's no SMS/push alerting. Alerts are RiskEvents plus e-mail via Base44's `Core.SendEmail` integration (unverified).
- Paper trading needs the worker plus live read-only market data. Local mode shows simulation only.
