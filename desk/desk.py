#!/usr/bin/env python3
"""PROP DESK AGENT — risk engine, capital ledger, trade journal, learning loop.

Har order (PAPER ya LIVE) se pehle `check` chalana MANDATORY hai.
Ye file sirf bookkeeping + risk gate hai. Funds kabhi move nahi karti:
deposit/withdraw sirf record hote hain; asli transfer user khud Kite Console se karta hai.

Usage (repo root se):
  python3 desk/desk.py status
  python3 desk/desk.py ledger deposit 25000 --note "initial"
  python3 desk/desk.py ledger withdraw 5000 --note "profit nikala"
  python3 desk/desk.py check --symbol HDFCBANK --side LONG --entry 1650 --sl 1640 --target 1675 \
        --sector BANK --setup "V + build-up" --ref "3.5 / M7" [--cash 24606]
  python3 desk/desk.py trade open  (same args as check) [--confidence 7] [--invalidation "..."] [--order-id X]
  python3 desk/desk.py trade close T20261118-1 --price 1675 --reason "target"
  python3 desk/desk.py stats [--date 2026-11-18 | --all]
  python3 desk/desk.py review [--date 2026-11-18]
  python3 desk/desk.py lesson add "text" [--proposed]
  python3 desk/desk.py kill on|off --reason "..."
  python3 desk/desk.py api-error [--reset]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
ROOT = Path(__file__).resolve().parent
JOURNAL = ROOT / "journal"
CONFIG = ROOT / "config.json"
LEDGER = JOURNAL / "ledger.jsonl"
TRADES = JOURNAL / "trades.json"
STATE = JOURNAL / "state.json"
LESSONS = JOURNAL / "lessons.md"
REVIEWS = JOURNAL / "reviews"


# ---------------------------------------------------------------- storage
def now() -> datetime:
    return datetime.now(IST)


def today() -> str:
    return now().strftime("%Y-%m-%d")


def load_config() -> dict:
    return json.loads(CONFIG.read_text())


def _read_json(path: Path, default):
    if not path.exists():
        return default
    txt = path.read_text().strip()
    return json.loads(txt) if txt else default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


def load_trades() -> list[dict]:
    return _read_json(TRADES, [])


def save_trades(trades: list[dict]) -> None:
    _write_json(TRADES, trades)


def load_state() -> dict:
    return _read_json(STATE, {"kill_switch": False, "kill_reason": "", "kill_date": "", "api_errors": {}})


def save_state(state: dict) -> None:
    _write_json(STATE, state)


def load_ledger() -> list[dict]:
    if not LEDGER.exists():
        return []
    return [json.loads(l) for l in LEDGER.read_text().splitlines() if l.strip()]


# ---------------------------------------------------------------- capital
def ledger_net(entries: list[dict]) -> float:
    total = 0.0
    for e in entries:
        total += e["amount"] if e["type"] == "deposit" else -e["amount"]
    return round(total, 2)


def realised_pnl(trades: list[dict], mode: str | None = None, date: str | None = None) -> float:
    return round(sum(t["pnl"] for t in trades
                     if t["status"] == "CLOSED"
                     and (mode is None or t["mode"] == mode)
                     and (date is None or t["closed_at"][:10] == date)), 2)


def capital(cfg: dict, trades: list[dict], ledger: list[dict]) -> float:
    """Sizing capital = ledger (deposits − withdrawals) + realised P&L of the current mode."""
    return round(ledger_net(ledger) + realised_pnl(trades, cfg["mode"]), 2)


# ---------------------------------------------------------------- risk math
def rr(side: str, entry: float, sl: float, target: float) -> float:
    if side == "LONG":
        return (target - entry) / (entry - sl)
    return (entry - target) / (sl - entry)


def position_size(risk_budget: float, entry: float, sl: float) -> int:
    per_share = abs(entry - sl)
    return int(math.floor(risk_budget / per_share)) if per_share > 0 else 0


@dataclass
class Check:
    name: str
    ok: bool
    note: str = ""


@dataclass
class Verdict:
    passed: bool
    checks: list[Check] = field(default_factory=list)
    qty: int = 0
    risk_rs: float = 0.0
    rr: float = 0.0
    capital: float = 0.0
    risk_budget: float = 0.0

    def as_dict(self) -> dict:
        return {
            "passed": self.passed, "qty": self.qty, "risk_rs": self.risk_rs, "rr": self.rr,
            "capital": self.capital, "risk_budget": self.risk_budget,
            "checks": [c.__dict__ for c in self.checks],
        }


def _hhmm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def pre_trade_check(a: dict, cfg: dict, trades: list[dict], ledger: list[dict], state: dict,
                    at: datetime | None = None) -> Verdict:
    """All NON-NEGOTIABLE risk rules. Any fail → NO TRADE."""
    at = at or now()
    d = at.strftime("%Y-%m-%d")
    side, entry, sl, target = a["side"].upper(), float(a["entry"]), float(a["sl"]), float(a["target"])
    cap = capital(cfg, trades, ledger)
    mode = cfg["mode"]
    checks: list[Check] = []

    def add(name, ok, note=""):
        checks.append(Check(name, bool(ok), note))

    day_trades = [t for t in trades if t["opened_at"][:10] == d and t["mode"] == mode]
    open_trades = [t for t in trades if t["status"] == "OPEN" and t["mode"] == mode]
    day_loss = -min(0.0, realised_pnl(trades, mode, d))
    open_risk_today = sum(t["risk_rs"] for t in day_trades)

    add("kill switch OFF", not state.get("kill_switch"), state.get("kill_reason", ""))
    add("capital set (>0)", cap > 0, f"capital ₹{cap:,.2f}")
    add("setup + rulebook ref given", a.get("setup") and a.get("ref"), "rulebook se bahar ka trade banned")
    add("F&O allowed?", cfg["fno_enabled"] or a.get("exchange", "NSE") in ("NSE", "BSE"),
        "F&O sirf user enable kare")

    geo = (sl < entry < target) if side == "LONG" else (target < entry < sl)
    add("SL/target geometry valid", geo, f"{side}: SL {sl} | entry {entry} | target {target}")
    r = round(rr(side, entry, sl, target), 2) if geo else 0.0
    add(f"R:R ≥ 1:{cfg['min_rr']:g}", r >= cfg["min_rr"], f"R:R 1:{r}")

    per_trade = cap * cfg["risk_per_trade_pct"] / 100
    rulebook_left = cap * cfg["rulebook_daily_risk_cap_pct"] / 100 - open_risk_today
    loss_left = cap * cfg["max_daily_loss_pct"] / 100 - day_loss
    budget = max(0.0, min(per_trade, rulebook_left, loss_left))
    qty = position_size(budget, entry, sl) if geo else 0

    # margin / cash cap
    cash = a.get("cash")
    lev = cfg["mis_leverage"] if a.get("product", "MIS") == "MIS" else 1
    if cash is not None and entry > 0:
        qty = min(qty, int(float(cash) * lev // entry))
        add("margin sufficient", qty >= 1, f"cash ₹{float(cash):,.0f} × {lev}x")
    risk_rs = round(qty * abs(entry - sl), 2)

    add("qty ≥ 1 after sizing", qty >= 1, f"budget ₹{budget:,.2f} ÷ {abs(entry - sl):.2f}/sh")
    add("risk ≤ 1% per trade", risk_rs <= per_trade + 1e-6, f"₹{risk_rs:,.2f} ≤ ₹{per_trade:,.2f}")
    add("rulebook daily risk ≤ 1% (sum)", open_risk_today + risk_rs <= cap * cfg["rulebook_daily_risk_cap_pct"] / 100 + 1e-6,
        f"aaj committed ₹{open_risk_today:,.2f} + ₹{risk_rs:,.2f}")
    add("daily loss limit room", day_loss + risk_rs <= cap * cfg["max_daily_loss_pct"] / 100 + 1e-6,
        f"aaj loss ₹{day_loss:,.2f}")
    add(f"open positions < {cfg['max_open_positions']}", len(open_trades) < cfg["max_open_positions"], f"{len(open_trades)} open")
    add(f"trades today < {cfg['max_trades_per_day']}", len(day_trades) < cfg["max_trades_per_day"], f"{len(day_trades)} done")
    sec = a.get("sector", "")
    sec_n = sum(1 for t in day_trades if t.get("sector") == sec)
    add(f"sector trades < {cfg['max_trades_per_sector']}", sec_n < cfg["max_trades_per_sector"], f"{sec}: {sec_n}")
    streak = consecutive_losses(trades, mode)
    add(f"consecutive losses < {cfg['max_consecutive_losses']}", streak < cfg["max_consecutive_losses"], f"streak {streak}")
    errs = state.get("api_errors", {}).get(d, 0)
    add(f"API errors < {cfg['max_api_errors']}", errs < cfg["max_api_errors"], f"{errs} today")

    lo, hi = cfg["price_band"]
    add("price band ₹100–4000 (or exception)", lo <= entry <= hi or a.get("exception"),
        "exception ho to --exception 'reason'")

    t = at.time()
    open_t = (9, 15)
    cut = _hhmm(cfg["no_new_entry_after"])
    add("market hours / entry window", (t.hour, t.minute) >= open_t and (t.hour, t.minute) < cut,
        f"entries 09:15–{cfg['no_new_entry_after']} IST")
    add("weekday", at.weekday() < 5, at.strftime("%A"))

    if mode == "LIVE" and cfg["approval"] == "ON":
        add("user YES for this exact trade", a.get("approved"), "APPROVAL=ON → user ka YES chahiye")

    v = Verdict(all(c.ok for c in checks), checks, qty, risk_rs, r, cap, round(budget, 2))
    return v


def consecutive_losses(trades: list[dict], mode: str) -> int:
    closed = sorted((t for t in trades if t["status"] == "CLOSED" and t["mode"] == mode), key=lambda t: t["closed_at"])
    n = 0
    for t in reversed(closed):
        if t["pnl"] < 0:
            n += 1
        else:
            break
    return n


# ---------------------------------------------------------------- stats
def stats(trades: list[dict], mode: str, date: str | None = None) -> dict:
    closed = sorted((t for t in trades if t["status"] == "CLOSED" and t["mode"] == mode
                     and (date is None or t["closed_at"][:10] == date)), key=lambda t: t["closed_at"])
    wins = [t for t in closed if t["pnl"] > 0]
    losses = [t for t in closed if t["pnl"] < 0]
    eq, peak, mdd = 0.0, 0.0, 0.0
    for t in closed:
        eq += t["pnl"]
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    n = len(closed)
    gross_win = sum(t["pnl"] for t in wins)
    gross_loss = -sum(t["pnl"] for t in losses)
    return {
        "mode": mode, "date": date or "ALL", "trades": n, "wins": len(wins), "losses": len(losses),
        "win_rate_pct": round(100 * len(wins) / n, 1) if n else 0.0,
        "net_pnl": round(eq, 2),
        "avg_r": round(sum(t["r_multiple"] for t in closed) / n, 2) if n else 0.0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss else None,
        "max_drawdown": round(mdd, 2),
        "rules_followed_pct": round(100 * sum(1 for t in closed if t.get("rule_followed") is not False) / n, 1) if n else 0.0,
    }


# ---------------------------------------------------------------- commands
def _print_verdict(v: Verdict, a: dict) -> None:
    print(f"\n{'✅ PASS' if v.passed else '⛔ NO TRADE'}  {a['symbol']} {a['side'].upper()}  "
          f"entry {a['entry']} | SL {a['sl']} | target {a['target']}")
    print(f"capital ₹{v.capital:,.2f} | risk budget ₹{v.risk_budget:,.2f} | qty {v.qty} | risk ₹{v.risk_rs:,.2f} | R:R 1:{v.rr}")
    if v.qty:
        rev = round(v.qty * abs(float(a['entry']) - float(a['sl'])), 2)
        print(f"reverse check: {v.qty} × {abs(float(a['entry']) - float(a['sl'])):.2f} = ₹{rev:,.2f}")
    for c in v.checks:
        print(f"  {'✓' if c.ok else '✗'} {c.name:<38} {c.note}")


def _trade_args(ns) -> dict:
    return {k: getattr(ns, k) for k in ("symbol", "side", "entry", "sl", "target", "sector", "setup", "ref",
                                         "cash", "product", "exchange", "exception", "approved")}


def cmd_check(ns) -> int:
    a = _trade_args(ns)
    v = pre_trade_check(a, load_config(), load_trades(), load_ledger(), load_state())
    if ns.json:
        print(json.dumps(v.as_dict(), ensure_ascii=False, indent=2))
    else:
        _print_verdict(v, a)
    return 0 if v.passed else 1


def cmd_trade_open(ns) -> int:
    cfg, trades, state = load_config(), load_trades(), load_state()
    a = _trade_args(ns)
    v = pre_trade_check(a, cfg, trades, load_ledger(), state)
    _print_verdict(v, a)
    if not v.passed:
        print("\nTrade NOT logged. Doubt mein no trade.")
        return 1
    qty = ns.qty or v.qty
    if qty > v.qty:
        print(f"⛔ qty {qty} > allowed {v.qty}. Not logged.")
        return 1
    d = now()
    tid = f"T{d.strftime('%Y%m%d')}-{sum(1 for t in trades if t['id'].startswith('T' + d.strftime('%Y%m%d'))) + 1}"
    trades.append({
        "id": tid, "mode": cfg["mode"], "status": "OPEN", "symbol": a["symbol"].upper(), "side": a["side"].upper(),
        "sector": a.get("sector", ""), "setup": a["setup"], "ref": a["ref"], "product": a.get("product", "MIS"),
        "entry": float(a["entry"]), "sl": float(a["sl"]), "target": float(a["target"]), "qty": qty,
        "risk_rs": round(qty * abs(float(a["entry"]) - float(a["sl"])), 2), "rr_planned": v.rr,
        "confidence": ns.confidence, "invalidation": ns.invalidation or "", "order_id": ns.order_id or "",
        "sl_order_id": ns.sl_order_id or "", "opened_at": d.isoformat(timespec="seconds"),
        "log": [f"{d:%H:%M:%S} OPEN {qty} @ {a['entry']} SL {a['sl']} TGT {a['target']}"],
    })
    save_trades(trades)
    print(f"\n📒 Logged {tid} ({cfg['mode']}).")
    return 0


def cmd_trade_close(ns) -> int:
    cfg, trades, state = load_config(), load_trades(), load_state()
    t = next((t for t in trades if t["id"] == ns.id), None)
    if not t or t["status"] != "OPEN":
        print("Open trade nahi mila.")
        return 1
    exit_p = float(ns.price)
    sign = 1 if t["side"] == "LONG" else -1
    pnl = round(sign * (exit_p - t["entry"]) * t["qty"], 2)
    per_r = abs(t["entry"] - t["sl"]) * t["qty"]
    d = now()
    t.update(status="CLOSED", exit=exit_p, exit_reason=ns.reason, pnl=pnl,
             r_multiple=round(pnl / per_r, 2) if per_r else 0.0,
             closed_at=d.isoformat(timespec="seconds"),
             rule_followed=None if ns.rule_followed is None else ns.rule_followed == "yes")
    t["log"].append(f"{d:%H:%M:%S} CLOSE @ {exit_p} ({ns.reason}) P&L ₹{pnl}")
    save_trades(trades)
    print(f"{t['id']} closed @ {exit_p}: P&L ₹{pnl} ({t['r_multiple']}R)")

    # automatic kill-switch triggers
    cap = capital(cfg, trades, load_ledger())
    day_loss = -min(0.0, realised_pnl(trades, cfg["mode"], d.strftime("%Y-%m-%d")))
    reasons = []
    if day_loss >= cap * cfg["max_daily_loss_pct"] / 100:
        reasons.append(f"daily loss ₹{day_loss:,.2f} ≥ {cfg['max_daily_loss_pct']}%")
    if consecutive_losses(trades, cfg["mode"]) >= cfg["max_consecutive_losses"]:
        reasons.append(f"{cfg['max_consecutive_losses']} consecutive losses")
    if reasons:
        state.update(kill_switch=True, kill_reason="; ".join(reasons), kill_date=d.strftime("%Y-%m-%d"))
        save_state(state)
        print(f"🚨 KILL SWITCH ON: {state['kill_reason']}. Naye orders band. User ko alert karo.")
    return 0


def cmd_ledger(ns) -> int:
    entries = load_ledger()
    if ns.action == "show":
        for e in entries:
            print(f"{e['ts']}  {e['type']:<8} ₹{e['amount']:>12,.2f}  {e.get('note', '')}")
        print(f"net ₹{ledger_net(entries):,.2f}")
        return 0
    amt = float(ns.amount)
    if amt <= 0:
        print("Amount positive hona chahiye.")
        return 1
    if ns.action == "withdraw":
        cfg, trades = load_config(), load_trades()
        if any(t["status"] == "OPEN" for t in trades):
            print("⛔ Open positions hain — pehle close karo, phir withdrawal record karo.")
            return 1
        cap = capital(cfg, trades, entries)
        if amt > cap:
            print(f"⛔ Withdrawal ₹{amt:,.2f} > capital ₹{cap:,.2f}.")
            return 1
    e = {"ts": now().isoformat(timespec="seconds"), "type": ns.action, "amount": amt, "note": ns.note or ""}
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as f:
        f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"Recorded {ns.action} ₹{amt:,.2f}. Net ledger ₹{ledger_net(load_ledger()):,.2f}")
    print("Note: ye sirf record hai. Asli paisa Kite Console (Funds) se user khud add/withdraw karta hai.")
    return 0


def cmd_status(ns) -> int:
    cfg, trades, ledger, state = load_config(), load_trades(), load_ledger(), load_state()
    cap = capital(cfg, trades, ledger)
    d = today()
    print(f"MODE {cfg['mode']} | APPROVAL {cfg['approval']} | F&O {'ON' if cfg['fno_enabled'] else 'OFF'}")
    print(f"Capital ₹{cap:,.2f} (ledger ₹{ledger_net(ledger):,.2f})")
    print(f"Per-trade risk ₹{cap * cfg['risk_per_trade_pct'] / 100:,.2f} | daily loss limit ₹{cap * cfg['max_daily_loss_pct'] / 100:,.2f} "
          f"| rulebook daily risk cap ₹{cap * cfg['rulebook_daily_risk_cap_pct'] / 100:,.2f}")
    print(f"Kill switch: {'ON — ' + state['kill_reason'] if state.get('kill_switch') else 'OFF'}")
    open_t = [t for t in trades if t["status"] == "OPEN"]
    print(f"Open: {len(open_t)} | Today: {sum(1 for t in trades if t['opened_at'][:10] == d)} trades | "
          f"Today P&L ₹{realised_pnl(trades, cfg['mode'], d):,.2f}")
    for t in open_t:
        print(f"  {t['id']} {t['symbol']} {t['side']} {t['qty']} @ {t['entry']} SL {t['sl']} TGT {t['target']} [{t['product']}]")
    return 0


def cmd_stats(ns) -> int:
    cfg = load_config()
    s = stats(load_trades(), cfg["mode"], None if ns.all else (ns.date or today()))
    print(json.dumps(s, ensure_ascii=False, indent=2))
    return 0


def cmd_review(ns) -> int:
    cfg, trades = load_config(), load_trades()
    d = ns.date or today()
    s = stats(trades, cfg["mode"], d)
    life = stats(trades, cfg["mode"])
    day = [t for t in trades if t["opened_at"][:10] == d and t["mode"] == cfg["mode"]]
    path = REVIEWS / f"{d}.md"
    if path.exists() and not ns.force:
        print(f"{path} already exists (use --force to regenerate).")
        return 1
    rows = "\n".join(
        f"| {t['id']} | {t['symbol']} | {t['side']} | {t['setup']} ({t['ref']}) | {t['entry']} | {t['sl']} | {t['target']} | "
        f"{t['qty']} | {t.get('exit', '-')} | {t.get('pnl', '-')} | {t.get('r_multiple', '-')} | {t.get('exit_reason', 'OPEN')} |"
        for t in day) or "| — | koi trade nahi | | | | | | | | | | |"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"""# POST-MARKET REVIEW — {d} ({cfg['mode']})

## Numbers
| Trades | Wins | Losses | Win rate | Net P&L | Avg R | Max DD | Rules followed |
|---|---|---|---|---|---|---|---|
| {s['trades']} | {s['wins']} | {s['losses']} | {s['win_rate_pct']}% | ₹{s['net_pnl']} | {s['avg_r']} | ₹{s['max_drawdown']} | {s['rules_followed_pct']}% |

Lifetime ({cfg['mode']}): {life['trades']} trades, win rate {life['win_rate_pct']}%, avg R {life['avg_r']}, net ₹{life['net_pnl']}, PF {life['profit_factor']}, max DD ₹{life['max_drawdown']}

## Trades
| ID | Symbol | Side | Setup (ref) | Entry | SL | Target | Qty | Exit | P&L | R | Exit reason |
|---|---|---|---|---|---|---|---|---|---|---|---|
{rows}

## Har trade: plan vs execution
<!-- Har trade ke liye: kya plan tha, kya hua, kaunsa rule follow/break hua (rulebook ref), SAHI kyu / GALAT kyu -->

## Market ne aaj kya kiya (plan vs reality)
<!-- Pre-market scenario sahi tha ya galat? Kis level/rule ne decide kiya? -->

## Missed / skipped trades
<!-- Jo setup chhoda — sahi chhoda ya galat? Kyu? -->

## Psychology notes
<!-- Dar, FOMO, revenge urge, impatience — evidence ke saath -->

## Lessons (journal)
<!-- `python3 desk/desk.py lesson add "..."` se lessons.md mein bhi daalo -->

## PROPOSED rules (user approval pending)
<!-- Core rulebook khud se kabhi mat badlo. Naya rule sirf yahan 'PROPOSED' tag ke saath. -->
""")
    print(f"Review skeleton: {path}")
    return 0


def cmd_lesson(ns) -> int:
    LESSONS.parent.mkdir(parents=True, exist_ok=True)
    if not LESSONS.exists():
        LESSONS.write_text("# Desk Lessons Journal\n\nHar entry dated hai. `[PROPOSED]` = naya rule, user approval pending.\n\n")
    tag = "[PROPOSED] " if ns.proposed else ""
    with LESSONS.open("a") as f:
        f.write(f"- {today()} — {tag}{ns.text}\n")
    print("Lesson saved.")
    return 0


def cmd_kill(ns) -> int:
    state = load_state()
    if ns.action == "on":
        state.update(kill_switch=True, kill_reason=ns.reason or "manual", kill_date=today())
    else:
        if not ns.reason:
            print("Kill switch OFF karne ke liye --reason chahiye (sirf user ke kehne par).")
            return 1
        state.update(kill_switch=False, kill_reason=f"cleared: {ns.reason}")
    save_state(state)
    print(f"Kill switch {'ON' if state['kill_switch'] else 'OFF'} — {state['kill_reason']}")
    return 0


def cmd_api_error(ns) -> int:
    state, d = load_state(), today()
    errs = state.setdefault("api_errors", {})
    errs[d] = 0 if ns.reset else errs.get(d, 0) + 1
    if errs[d] >= load_config()["max_api_errors"]:
        state.update(kill_switch=True, kill_reason=f"Kite API/session error ×{errs[d]}", kill_date=d)
    save_state(state)
    print(f"API errors today: {errs[d]}{' — KILL SWITCH ON' if state.get('kill_switch') else ''}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="PROP DESK AGENT engine")
    sub = p.add_subparsers(dest="cmd", required=True)

    def trade_args(sp):
        sp.add_argument("--symbol", required=True)
        sp.add_argument("--side", required=True, choices=["LONG", "SHORT", "long", "short"])
        sp.add_argument("--entry", required=True, type=float)
        sp.add_argument("--sl", required=True, type=float)
        sp.add_argument("--target", required=True, type=float)
        sp.add_argument("--sector", default="")
        sp.add_argument("--setup", default="")
        sp.add_argument("--ref", default="")
        sp.add_argument("--cash", type=float)
        sp.add_argument("--product", default="MIS", choices=["MIS", "CNC"])
        sp.add_argument("--exchange", default="NSE")
        sp.add_argument("--exception", default="")
        sp.add_argument("--approved", action="store_true")

    c = sub.add_parser("check"); trade_args(c); c.add_argument("--json", action="store_true"); c.set_defaults(fn=cmd_check)

    t = sub.add_parser("trade"); tsub = t.add_subparsers(dest="action", required=True)
    to = tsub.add_parser("open"); trade_args(to)
    to.add_argument("--qty", type=int); to.add_argument("--confidence", type=int)
    to.add_argument("--invalidation"); to.add_argument("--order-id"); to.add_argument("--sl-order-id")
    to.set_defaults(fn=cmd_trade_open)
    tc = tsub.add_parser("close"); tc.add_argument("id"); tc.add_argument("--price", required=True, type=float)
    tc.add_argument("--reason", required=True); tc.add_argument("--rule-followed", choices=["yes", "no"])
    tc.set_defaults(fn=cmd_trade_close)

    l = sub.add_parser("ledger"); l.add_argument("action", choices=["deposit", "withdraw", "show"])
    l.add_argument("amount", nargs="?", default="0"); l.add_argument("--note"); l.set_defaults(fn=cmd_ledger)

    sub.add_parser("status").set_defaults(fn=cmd_status)
    s = sub.add_parser("stats"); s.add_argument("--date"); s.add_argument("--all", action="store_true"); s.set_defaults(fn=cmd_stats)
    r = sub.add_parser("review"); r.add_argument("--date"); r.add_argument("--force", action="store_true"); r.set_defaults(fn=cmd_review)
    le = sub.add_parser("lesson"); le.add_argument("op", choices=["add"]); le.add_argument("text")
    le.add_argument("--proposed", action="store_true"); le.set_defaults(fn=cmd_lesson)
    k = sub.add_parser("kill"); k.add_argument("action", choices=["on", "off"]); k.add_argument("--reason"); k.set_defaults(fn=cmd_kill)
    ae = sub.add_parser("api-error"); ae.add_argument("--reset", action="store_true"); ae.set_defaults(fn=cmd_api_error)

    ns = p.parse_args(argv)
    return ns.fn(ns)


if __name__ == "__main__":
    sys.exit(main())
