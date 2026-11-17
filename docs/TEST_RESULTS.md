# Test results

Run: `npm test` (Node 22, `node --test`). Latest run: **83 tests, 83 pass, 0 fail**. Full output: [`test-output.txt`](test-output.txt).
Also passing: `tsc` on `core/` + `tests/`, `tsc` on `worker/` + `base44/` (Deno shims), and the frontend `tsc` + `vite build`. A browser smoke test (`scripts/ui-smoke.cjs`, headless Chromium) ran the full owner flow with zero console errors.

## Acceptance criteria

| # | Requirement | Result | Tests |
|---|---|---|---|
| 1 | INR 10,000 initial capital appears correctly | ✅ Simulation book shows ₹10,000 with ₹5,000 / ₹2,000 / ₹3,000. Production is **not** pre-funded and only shows owner deposits confirmed by reconciliation | `acceptance › 1` (2) |
| 2 | Simulated trades never alter real cash balances | ✅ Production ledger unchanged while simulation trades on a shared DB. Production ledger refuses SIMULATED/PAPER_FEED data. Production cannot use a paper adapter | `acceptance › 2` (3) |
| 3 | Real orders require actual broker confirmation | ✅ OPEN only with a venue order id. Manual mode waits for the owner. First live order needs a typed phrase. A timeout becomes UNKNOWN and is resolved by client id, with no second placement | `acceptance › 3` (4) |
| 4 | Partial fills and rejected orders handled | ✅ Partial then cancel: holdings and cash reflect only the filled qty. Partial then complete: weighted average. Rejection: no fill, no cash change | `acceptance › 4` (3) |
| 5 | Duplicates cannot be created by retrying | ✅ Same key returns the same order; 4 concurrent retries give 1 order and 1 venue call; replayed trades give 1 fill and 1 ledger entry | `acceptance › 5` (3) |
| 6 | Profits only from verified executions | ✅ Unreconciled production fills are excluded until reconciliation. Unrealized gains never count. Equity sells are not eligible before T+1 | `acceptance › 6` (3) |
| 7 | Fees and losses reduce actual equity | ✅ Equity = capital − price loss − all fees, to the paisa | `acceptance › 7` |
| 8 | Compounding from eligible actual profits | ✅ Reinvested = 50% × (net − estimated tax). Compounding doesn't change equity. Idempotent re-run. Losses below the high-water mark compound nothing | `acceptance › 8` (2), `endToEnd` |
| 9 | Risk limits block unsafe orders | ✅ Risk/trade, missing stop, exposure, leverage, short selling, timeframe, price universe, daily-loss halt latch, expired session, unreconciled balances, venue down, phase gate, cost gate, AI actor | `acceptance › 9` (12) |
| 10 | Emergency stop prevents new orders | ✅ Blocks entries and cancels open orders. Only the owner (with confirmation) can release it. Protective stop exits still run | `acceptance › 10` (2), `integration › owner commands` |
| 11 | Missing market data prevents execution | ✅ No quote, stale quote, stale/incomplete candles → rejected | `acceptance › 11` (3) |
| 12 | 10% target never represented as guaranteed | ✅ Risk decisions are identical whatever the target. `risk.ts` never reads it. No guarantee language anywhere. The UI shows the target only through `TargetProgress` with a "not a guarantee" disclaimer (this test caught one violation during the build, which was fixed) | `acceptance › 12` (3) |

## Other coverage

- **End-to-end on a scripted rulebook setup**: validated signal → owner arms → confirmed break triggers order → fill → TARGET exit → realized ₹296.40, fees ₹21.50, tax reserve ₹86.65, reinvested ₹94.12 → ledger and audit chains verify. Also: an armed signal that's invalidated expires without trading, and production arming without the Final Check is refused.
- **Ledger**: unbalanced/zero/fractional lines rejected; idempotent; update forbidden; tampering detected at the exact sequence number.
- **Hash**: SHA-256 and HMAC match `node:crypto`.
- **Settings governance**: AI/system/worker refused; typed confirmation required; loosening deferred; hard ceilings enforced.
- **Prop desk**: R:R long/short with reverse check, qty reverse check, risk tiers, pyramid, P/E spread rule, stock scoring, 100-item Final Check, sizing incl. costs, retracement bands, range/territory detectors.
- **Signals on synthetic data**: every VALIDATED signal satisfies stop < entry < target, net R:R ≥ 2 and risk ≤ 0.5%. Note: 0 of 428 random-walk evaluations validated, which is expected on noise.
- **Adapters (mocked HTTP)**: Kite CNC-only order body, auth header, tag; 5xx/timeout ⇒ outcome unknown; tag lookup and partial fills; session and postback checksums; ticker binary parsing. CoinDCX exact-body HMAC, spot/INR-only guards, trade/fee mapping, auth errors. Signed webhooks: tampered, stale and replayed requests rejected.
- **Integration**: the full engine on `Base44Repo` against a fake Base44 API; the worker's signed gateway protocol over real HTTP; owner command signature and staleness checks; entity schemas match every engine record (no drift).

## Not tested (requires real services)

Real Kite/CoinDCX authentication, order placement, WebSocket feeds, Base44 deployment and RLS enforcement, Deno runtime execution of functions and worker, Claude API calls, e-mail delivery. See [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md) Phases 2–4.
