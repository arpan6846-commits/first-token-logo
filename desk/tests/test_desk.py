import json
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import desk  # noqa: E402

CFG = json.loads((Path(__file__).resolve().parents[1] / "config.json").read_text())
LEDGER = [{"ts": "x", "type": "deposit", "amount": 25000.0}]
STATE = {"kill_switch": False, "api_errors": {}}
AT = datetime(2026, 11, 18, 10, 30, tzinfo=desk.IST)  # Wednesday


def args(**kw):
    a = dict(symbol="ABC", side="LONG", entry=500.0, sl=495.0, target=512.0, sector="BANK",
             setup="V + build-up", ref="3.5", cash=None, product="MIS", exchange="NSE", exception="", approved=False)
    a.update(kw)
    return a


def closed(pnl, n, sector="BANK"):
    return {"id": f"T{n}", "mode": "PAPER", "status": "CLOSED", "sector": sector, "pnl": pnl, "r_multiple": pnl / 250,
            "risk_rs": 250.0, "opened_at": f"2026-11-18T09:3{n}:00", "closed_at": f"2026-11-18T09:4{n}:00"}


class T(unittest.TestCase):
    def check(self, a=None, trades=(), state=STATE, cfg=CFG, at=AT):
        return desk.pre_trade_check(a or args(), cfg, list(trades), LEDGER, state, at)

    def test_sizing_and_pass(self):
        v = self.check()
        self.assertTrue(v.passed, [c for c in v.checks if not c.ok])
        self.assertEqual(v.qty, 50)          # ₹250 ÷ 5
        self.assertEqual(v.risk_rs, 250.0)
        self.assertEqual(v.rr, 2.4)

    def test_low_rr_rejected(self):
        self.assertFalse(self.check(args(target=505)).passed)

    def test_bad_geometry(self):
        self.assertFalse(self.check(args(side="SHORT")).passed)

    def test_kill_switch(self):
        self.assertFalse(self.check(state={"kill_switch": True, "kill_reason": "x", "api_errors": {}}).passed)

    def test_rulebook_daily_cap_shrinks_budget(self):
        t = [{"id": "T1", "mode": "PAPER", "status": "OPEN", "sector": "IT", "risk_rs": 200.0,
              "opened_at": "2026-11-18T09:40:00"}]
        v = self.check(trades=t)
        self.assertEqual(v.qty, 10)          # only ₹50 of 1% cap left

    def test_consecutive_losses(self):
        t = [closed(-100, 1, "IT"), closed(-100, 2, "AUTO"), closed(-100, 3, "METAL")]
        self.assertFalse(self.check(trades=t).passed)

    def test_after_cutoff(self):
        self.assertFalse(self.check(at=datetime(2026, 11, 18, 14, 50, tzinfo=desk.IST)).passed)

    def test_fno_blocked(self):
        self.assertFalse(self.check(args(exchange="NFO")).passed)

    def test_live_needs_approval(self):
        cfg = dict(CFG, mode="LIVE")
        self.assertFalse(self.check(cfg=cfg).passed)
        self.assertTrue(self.check(args(approved=True), cfg=cfg).passed)

    def test_margin_cap(self):
        v = self.check(args(cash=1000.0))   # 1000×5/500 = 10 shares
        self.assertEqual(v.qty, 10)

    def test_stats(self):
        t = [closed(500, 1), closed(-250, 2), closed(-250, 3)]
        s = desk.stats(t, "PAPER")
        self.assertEqual(s["wins"], 1)
        self.assertEqual(s["net_pnl"], 0)
        self.assertEqual(s["max_drawdown"], 500)


if __name__ == "__main__":
    unittest.main()
