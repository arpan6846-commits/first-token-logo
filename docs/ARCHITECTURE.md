# Architecture

```
 Browser (owner only, Base44 auth)            Base44 (hosted)                          Worker (Deno, static IP host)
 ┌───────────────────────────┐   read-only   ┌──────────────────────────────┐  signed  ┌────────────────────────────────┐
 │ React UI (13 screens)     │ ────────────▶ │ Entities (owner-read RLS,    │◀────────▶│ workerGateway client (HMAC)    │
 │  • never writes records   │               │  no browser writes)          │  HTTPS   │ TradingEngine ×{paper,prod}    │
 │  • never sees secrets     │  ownerCommand │ Functions:                   │          │  • risk engine (deterministic)  │
 │                           │ ────────────▶ │  ownerCommand (signs intent, │          │  • OMS (idempotent, venue-      │
 └───────────────────────────┘               │   kill switch immediate)     │          │    confirmed, UNKNOWN handling) │
                                             │  kiteLogin / kiteCallback    │          │  • ledger, compounding          │
         Kite postback ──checksum──────────▶ │  kitePostback                │          │  • exits, triggers, reconcile   │
                                             │  aiReviewSignal ──▶ Claude   │          │ Feeds: Kite WS, CoinDCX REST    │
                                             │  revokeCredentials           │          │ Adapters: Kite, CoinDCX (LIVE), │
                                             │  watchdog ⏱5m, dailyReport ⏱ │          │           Paper (PAPER)         │
                                             └──────────────────────────────┘          └────────────────────────────────┘
```

## Principles

1. **One engine everywhere.** `core/` is dependency-free TypeScript. The browser simulation, tests, Base44 functions (via `base44/shared/core`) and the worker all run the same code.
2. **Single writer.** Only the worker changes financial state. Owner actions become signed `Commands`, which the worker executes serially. That gives us strict ledger sequencing, enforced uniqueness (Base44 lacks unique indexes) and one place that talks to venues. Run exactly one worker per app.
3. **Venue is the source of truth.** Orders become OPEN only from a venue acknowledgement. Fills come only from venue trade data. Reconciliation imports missing trades and blocks production orders on any mismatch.
4. **Hard environment separation.** `simulation` runs in the browser on synthetic data. `paper` uses live read-only prices with simulated fills. `production` holds real money. The ledger and OMS refuse cross-environment sources and adapters.
5. **The AI can't touch money or permissions.** `actor: 'ai'` can't submit, approve, change settings or operate the kill switch. Claude only reviews deterministic signals, and `mergeAiReview` can only downgrade.
6. **Everything is idempotent.** Orders (idempotency key + venue client id), fills (venue trade id), ledger (posting key), jobs (run key), daily close (date), compounding (date), deposits (owner reference).

## Order lifecycle

`PROPOSED → (risk) → RISK_REJECTED | APPROVED → [production manual mode: AWAITING_OWNER → owner confirms → risk re-check] → SUBMITTING → OPEN (venue id) → PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED | EXPIRED`. A timeout during submission becomes `UNKNOWN`, which is resolved by venue lookup on the client order id and never re-sent.

## Signal lifecycle (prop desk)

`analyse HTF territory + TTF momentum/V/build-up → candidate (entry = build-up break, stop beyond V/build-up, target = next price-action level) → validate (freshness, completeness, costs, slippage, min size, net R:R) → Final Check (auto + owner items + written journal) → VALIDATED | WATCHLIST | REJECTED → owner arms (APPROVED) → closed candle confirms break (no chasing > 0.5 ATR, risk re-check, qty re-sized) → order → EXECUTED | EXPIRED (invalidated / timed out)`.

## Ledger accounts

`ASSET:CASH:{BANK|KITE|COINDCX}`, `ASSET:HOLDINGS:{venue}:{symbol}` (cost), `ASSET:TDS_RECEIVABLE`, `EXPENSE:FEES:{venue}`, `EXPENSE:TAX_PROVISION`, `INCOME:REALIZED:{venue}`, `LIABILITY:TAX_RESERVE`, `EQUITY:CONTRIBUTED|WITHDRAWN|RETAINED|REINVESTED|PROFIT_RESERVE`. Net equity = cash + marked holdings + TDS receivable − tax reserve.

## Security model

- Base44 app private; `OWNER_EMAIL` + admin role required by every owner function.
- Entities: `read` admin-only, `create/update/delete` false for users. The service role (backend only) bypasses RLS, so functions do their own owner checks.
- Secrets live only in Base44 secrets and the worker env: `KITE_API_KEY`, `KITE_API_SECRET`, `COINDCX_API_KEY`, `COINDCX_API_SECRET`, `ANTHROPIC_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `COMMAND_SIGNING_SECRET`, `WORKER_GATEWAY_SECRET`, `OWNER_EMAIL`.
- The Kite access token is AES-GCM encrypted (with AAD) at rest, decrypted only in worker memory, hidden from the browser by field-level security, and never logged. Broker passwords and TOTP are never stored or automated.
- Webhooks: Kite postback checksum. Worker gateway is HMAC + timestamp + nonce. Owner commands are HMAC-signed.
- Revocation: `revokeCredentials` activates the kill switch, invalidates the Kite session at Kite, erases stored ciphertext and marks connections REVOKED.
