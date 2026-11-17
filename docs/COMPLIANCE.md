# Compliance & things to verify before real money

This is a personal tool for trading the owner's own funds in the owner's own KYC accounts. It is not advice, not a service to others and not a pooled fund. This page lists what **you** must confirm with primary sources. The rules change, and this repository can't verify them for you. Every item also appears as a checkbox in *Settings → Compliance checklist*, and Phase 5 stays locked until all are ticked.

## Broker / exchange

- **SEBI retail algorithmic trading framework.** SEBI has issued a framework for retail algo trading through broker APIs (registration/approval of algos via the broker, order tagging with an algo/strategy id, order-rate thresholds, static IP requirements for API order placement). Ask Zerodha how it applies to *your* personal API usage, and whether your orders need an exchange-approved algo id. Don't enable production until you have a written answer.
- **Static IP.** If your broker requires a whitelisted static IP for order APIs, run the worker on a host with that IP. Base44 functions don't place orders; only the worker does.
- **Kite Connect terms and pricing.** Confirm the current plan (personal use, market data and historical data entitlements), rate limits and the daily login requirement. Don't automate login or TOTP.
- **CoinDCX API.** Create the key with spot trading only and **withdrawals disabled**, IP-bound if offered. Confirm the current fee schedule and the ticker/candles/markets endpoints marked `[VERIFY]` in `core/adapters/coindcx.ts`.
- **Product types.** The app only sends CNC (delivery) and crypto spot. MIS, NRML, MTF, margin, futures, options and short selling are all blocked by the risk engine and by the adapters.

## Tax (verify with a tax adviser)

Defaults in `StrategySettings.taxRates`, used only for the *tax reserve estimate*:
- Crypto (VDA): 30% + 4% cess = 31.2% on gains, **no set-off of losses**, 1% TDS on sale consideration (tracked as a receivable).
- Equity sold the same day as bought (speculative): slab rate, default 31.2% placeholder.
- Equity delivery short-term capital gains: default 20.8% (20% + cess) placeholder.

## Fees (verify against current charge sheets)

`core/fees.ts`: delivery STT 0.1% each side, NSE transaction charge ~0.00297%, SEBI ₹10/crore, stamp 0.015% on buy, GST 18% on brokerage + exchange + SEBI, DP charge ~₹15.93 per scrip per sell day, zero delivery brokerage. CoinDCX: 0.5% fee + 18% GST, 1% TDS on sells. Broker-reported charges override these where the API provides them.

## Data & privacy

Financial records are visible only to the owner (admin RLS). Secrets live only in backend secrets. The app is private and `noindex`.
