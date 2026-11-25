import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pa  # noqa: E402


def bars(closes, day="2026-11-25"):
    out = []
    for i, cl in enumerate(closes):
        out.append({"date": f"{day}T{9 + i // 4:02d}:{(i % 4) * 15:02d}", "open": cl, "high": cl + 1, "low": cl - 1, "close": cl})
    return out


class T(unittest.TestCase):
    def test_retracement_50pct(self):
        # down to 100, impulse up to 200, pull back to 150 → 50%
        c = bars([110, 105, 100, 104, 120, 150, 180, 200, 190, 170, 160, 155, 150])
        r = pa.retracement(c)
        self.assertEqual(r["impulse"], "UP")
        self.assertEqual(r["retracement_pct"], 50.0)
        self.assertIn("exhausting", r["read"])

    def test_sustained(self):
        c = bars([99, 98, 101, 102, 103])
        s = pa.sustained(c, 100, "up")
        self.assertEqual(s["closes_beyond"], 3)
        self.assertTrue(s["valid_break"])
        self.assertFalse(pa.sustained(c, 102.5, "up")["valid_break"])

    def test_range_touches(self):
        c = bars([100, 110, 101, 110, 100, 109, 101])
        r = pa.range_box(c, lookback=7)
        self.assertGreaterEqual(r["touches_high"], 2)
        self.assertGreaterEqual(r["touches_low"], 2)
        self.assertTrue(r["confirmed_4_touch"])

    def test_prev_day(self):
        c = bars([10, 12, 11], "2026-11-23") + bars([13, 14], "2026-11-25")
        p = pa.prev_day(c)
        self.assertEqual(p["PDH"], 13)
        self.assertEqual(p["PDL"], 9)


if __name__ == "__main__":
    unittest.main()
