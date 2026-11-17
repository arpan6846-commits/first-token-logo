# Deployment checklist

Tick each line in order. Don't skip phases. Production orders are refused by the risk engine until Phase 5 criteria pass **and** you enable live trading.

## Phase 1: Frontend, database, ledger, dashboards, simulation ✅ (done in this repo)
- [x] `npm install && npm test`: 83/83 pass
- [x] `cd frontend && npm install && npm run build`
- [x] Simulation flow works locally (scripted setup → arm → fill → exit → compounding)

## Phase 2: Base44 deployment + read-only APIs
- [ ] Create the Base44 app; set it **private**; invite nobody else. Your account must be the app admin.
- [ ] `node scripts/gen-entities.mjs && node scripts/sync-shared.mjs`; deploy `base44/entities` and `base44/functions` with the Base44 CLI (`base44 functions deploy`). **Verify the RLS rules on the live app**: a non-admin test account must read nothing.
- [ ] Base44 secrets (copy names from `.env.example`): `OWNER_EMAIL`, `KITE_API_KEY`, `KITE_API_SECRET`, `COINDCX_API_KEY`, `COINDCX_API_SECRET`, `ANTHROPIC_API_KEY`, `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`), `COMMAND_SIGNING_SECRET`, `WORKER_GATEWAY_SECRET` (each `openssl rand -hex 32`), `APP_URL`.
- [ ] Kite developer console: create the app in your name; set the redirect URL to the `kiteCallback` function URL and the postback URL to `kitePostback` (HTTPS).
- [ ] CoinDCX: create the API key with **trade only, withdrawals disabled**, IP-bound to the worker host if available.
- [ ] Frontend: build with `VITE_DATA_MODE=base44 VITE_BASE44_APP_ID=<id>`; host it in Base44.
- [ ] Worker host with a static IP (if required): install Deno; set `WORKER_GATEWAY_URL`, `WORKER_GATEWAY_SECRET`, `COMMAND_SIGNING_SECRET`, `TOKEN_ENCRYPTION_KEY`, `KITE_API_KEY`, `COINDCX_API_KEY/SECRET`, `WORKER_ENVS=paper`, `WATCHLIST_STOCKS`, `WATCHLIST_CRYPTO`. Run `deno run --allow-net --allow-env worker/main.ts` under a supervisor (systemd/pm2) with restart on failure. **Only one worker instance.**
- [ ] Log in to Kite from *API connections*; confirm the status shows AUTHENTICATED, quotes are LIVE with fresh timestamps, health checks are OK, and the watchdog shows no alerts.
- [ ] Verify the `[VERIFY]` CoinDCX endpoints against live responses; fix field mappings if they differ.
- [ ] Load the NSE holiday calendar for the year into `NSE_CALENDAR.holidays`.
- [ ] Mark connections TESTED_READ_ONLY only after quotes, balances and holdings match what you see in Kite and CoinDCX.

## Phase 3: Historical testing and paper trading
- [ ] Backtest each watchlist symbol on real historical candles; record ≥ 30 trades; read the caveats.
- [ ] Run paper trading (`WORKER_ENVS=paper`) for ≥ 20 trading days and ≥ 30 closed trades; write post-trade reviews.
- [ ] Paper reconciliations MATCHED; daily close, compounding and reports correct.
- [ ] Decide on the cost-gate setting (see STATUS.md finding 1) with real numbers.

## Phase 4: Order APIs in controlled testing
Neither Kite nor CoinDCX offers a full sandbox for this flow. Use the smallest possible real orders, far-from-market limit prices, during market hours, with the kill switch ready.
- [ ] place → venue id → cancel (far limit, should never fill)
- [ ] partial fill handling (or verify via a small marketable order split by liquidity)
- [ ] rejection (e.g. quantity above available funds) → REJECTED, no ledger change
- [ ] duplicate retry: same idempotency key → one venue order; reuse of the `tag`/`client_order_id`
- [ ] reconciliation after each test: MATCHED
- [ ] kill switch: blocks new orders and cancels open ones
- [ ] record each passed test in `UserProfile.sandboxOrderTests`

## Phase 5: Limited real-money trading
- [ ] Compliance checklist fully ticked (Settings)
- [ ] Owner sets `phase: 5` and `liveTradingEnabled: true` (typed confirmation; loosening takes effect next trading day)
- [ ] First-live-order confirmation phrase entered
- [ ] Start with `executionMode: manual_approval`; keep `dailyRiskBudgetPct` at the lowest tier until ≥ 30 real trades
- [ ] Daily: Kite login, review alerts, read the daily report; weekly: review journal and limits
