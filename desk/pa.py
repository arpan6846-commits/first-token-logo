#!/usr/bin/env python3
"""Price-action number cruncher for the desk.

Interpretation rulebook ka kaam hai; ye file sirf woh numbers nikalti hai jo rulebook maangta hai
(sab closes/bodies par, wicks ignore — momentum rule):
  - swing pivots (closes)
  - last impulse vs correction retracement %  → 10% healthy · 20% ok · 50% exhausting · >50% no new entry · 100% over
  - range box + edge touches (4 touches = confirmed range)
  - sustained closes beyond a level (1–2 closes = valid break)
  - previous-day high / low (PDH/PDL) from intraday candles

Input: Kite historical JSON ({"data":[...]} ya list), file path ya stdin ('-').
  python3 desk/pa.py candles.json [--level 25501 --side up] [--lookback 30]
"""
from __future__ import annotations

import argparse
import json
import sys


def load(path: str) -> list[dict]:
    raw = json.load(sys.stdin if path == "-" else open(path))
    rows = raw.get("data", raw) if isinstance(raw, dict) else raw
    return [{k: r[k] for k in ("date", "open", "high", "low", "close")} for r in rows]


def pivots(c: list[dict], n: int = 2) -> list[tuple[int, str, float]]:
    """Alternating swing highs/lows on closes. (index, 'H'|'L', close)."""
    out: list[tuple[int, str, float]] = []
    cl = [x["close"] for x in c]
    for i in range(n, len(cl) - n):
        win = cl[i - n:i + n + 1]
        kind = "H" if cl[i] == max(win) else "L" if cl[i] == min(win) else None
        if not kind:
            continue
        if out and out[-1][1] == kind:  # keep the more extreme of same-type neighbours
            if (kind == "H" and cl[i] > out[-1][2]) or (kind == "L" and cl[i] < out[-1][2]):
                out[-1] = (i, kind, cl[i])
            continue
        out.append((i, kind, cl[i]))
    return out


def momentum_label(pct: float) -> str:
    if pct >= 100:
        return "100%+ → initiator ka momentum khatam; failing side ka next move decide karega"
    if pct > 50:
        return ">50% → no new trend entry (60–70%+ = range)"
    if pct >= 35:
        return "~50% → exhausting, size kam"
    if pct >= 15:
        return "~20% → ok"
    return "~10% → very healthy"


def retracement(c: list[dict], n: int = 2) -> dict | None:
    """Last completed impulse (between last two pivots) vs move since, on closes."""
    pv = pivots(c, n)
    if len(pv) < 2:
        return None
    (i0, k0, p0), (i1, k1, p1) = pv[-2], pv[-1]
    last = c[-1]["close"]
    leg = p1 - p0
    pct = abs(p1 - last) / abs(leg) * 100 if leg else 0.0
    direction = "UP" if leg > 0 else "DOWN"
    # did price already go beyond the impulse end (impulse still running)?
    extended = (direction == "UP" and last > p1) or (direction == "DOWN" and last < p1)
    return {
        "impulse": direction, "from": {"date": c[i0]["date"], "close": p0}, "to": {"date": c[i1]["date"], "close": p1},
        "impulse_pts": round(abs(leg), 2), "impulse_bars": i1 - i0, "correction_bars": len(c) - 1 - i1,
        "last_close": last, "retracement_pct": 0.0 if extended else round(pct, 1),
        "read": "impulse still extending" if extended else momentum_label(pct),
    }


def range_box(c: list[dict], lookback: int = 30, tol: float = 0.1) -> dict:
    """High/low of last `lookback` candles and how many separate times each edge was touched (wicks count for touches)."""
    w = c[-lookback:]
    hi, lo = max(x["high"] for x in w), min(x["low"] for x in w)
    band = (hi - lo) * tol

    def touches(edge_hit):
        n, inside = 0, False
        for x in w:
            hit = edge_hit(x)
            if hit and not inside:
                n += 1
            inside = hit
        return n

    th = touches(lambda x: x["high"] >= hi - band)
    tl = touches(lambda x: x["low"] <= lo + band)
    last = w[-1]["close"]
    return {"high": hi, "low": lo, "height": round(hi - lo, 2), "touches_high": th, "touches_low": tl,
            "confirmed_4_touch": th + tl >= 4 and th >= 2 and tl >= 2,
            "position_pct": round((last - lo) / (hi - lo) * 100, 1) if hi > lo else 50.0}


def sustained(c: list[dict], level: float, side: str) -> dict:
    """Consecutive closes (from the latest backwards) beyond level. side: up|down."""
    n = 0
    for x in reversed(c):
        if (side == "up" and x["close"] > level) or (side == "down" and x["close"] < level):
            n += 1
        else:
            break
    return {"level": level, "side": side, "closes_beyond": n, "valid_break": n >= 2,
            "read": "sustained (≥2 closes)" if n >= 2 else "1 close — confirm karo" if n == 1 else "not broken / fake"}


def prev_day(c: list[dict]) -> dict | None:
    days: dict[str, list[dict]] = {}
    for x in c:
        days.setdefault(x["date"][:10], []).append(x)
    keys = sorted(days)
    if len(keys) < 2:
        return None
    p = days[keys[-2]]
    return {"date": keys[-2], "PDH": max(x["high"] for x in p), "PDL": min(x["low"] for x in p),
            "PDC": p[-1]["close"]}


def analyse(c: list[dict], lookback: int = 30, level: float | None = None, side: str = "up") -> dict:
    out = {"bars": len(c), "last": c[-1], "retracement": retracement(c), "range": range_box(c, lookback),
           "prev_day": prev_day(c), "pivots_last6": [(c[i]["date"], k, p) for i, k, p in pivots(c)[-6:]]}
    if level is not None:
        out["sustain"] = sustained(c, level, side)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--lookback", type=int, default=30)
    ap.add_argument("--level", type=float)
    ap.add_argument("--side", choices=["up", "down"], default="up")
    ns = ap.parse_args(argv)
    print(json.dumps(analyse(load(ns.file), ns.lookback, ns.level, ns.side), indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
