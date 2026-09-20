"""Desk bot unit tests — paper TP/SL/BE and live signals. No Bitget calls."""
from __future__ import annotations

import math
import time
import unittest

from . import desk_bot


def _candles(move_bps: float, volume_ratio: float = 1.4) -> list[dict]:
    prev = 100.0
    older = prev * (1 - abs(move_bps) * 0.3 / 10000.0)
    last = prev * (1 + move_bps / 10000.0)
    return [
        {"t": 1, "o": older, "h": older, "l": older, "c": older, "v": 10},
        {"t": 2, "o": older, "h": older, "l": older, "c": older, "v": 10},
        {"t": 3, "o": older, "h": prev, "l": older, "c": prev, "v": 10},
        {"t": 4, "o": prev, "h": last, "l": prev, "c": last, "v": 10 * volume_ratio},
    ]


class DeskBotTests(unittest.TestCase):
    def setUp(self):
        desk_bot.reset_for_tests()
        self.marks = {"SOLUSDT": 100.0}
        self.candle_move = 20.0
        self.positions = []
        desk_bot.set_market_hooks(
            ticker=lambda symbol: {"ok": True, "mark": self.marks[symbol], "last": self.marks[symbol]},
            candles=lambda symbol: _candles(self.candle_move),
            positions=lambda: list(self.positions),
        )
        desk_bot.command({"action": "start", "profile": "aggressive"})

    def tearDown(self):
        desk_bot.set_market_hooks(None, None, None)
        desk_bot.reset_for_tests()

    def test_takes_profit_on_fade_from_peak(self):
        now = time.time()
        desk_bot.tick(now)
        self.assertIsNotNone(desk_bot.status()["open"])
        self.marks["SOLUSDT"] = 100.30  # +30 bps, past 26 bps TP
        desk_bot.tick(now + 2)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertGreater(status["metrics"]["net_usdt"], 0)
        self.assertIn("Take-profit", status["closed"][-1]["reason"])

    def test_break_even_protects_green(self):
        now = time.time()
        desk_bot.tick(now)
        self.marks["SOLUSDT"] = 100.18  # arm BE (16 bps)
        desk_bot.tick(now + 1)
        pos = desk_bot.status()["open"]
        self.assertTrue(pos["be_armed"])
        self.marks["SOLUSDT"] = 100.0  # back to entry
        desk_bot.tick(now + 2)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertIn("Break-even", status["closed"][-1]["reason"])
        # Fees still cost a little, but we did not ride a loser.
        self.assertGreater(status["closed"][-1]["net_usdt"], -0.30)

    def test_tight_stop_cuts_loss(self):
        now = time.time()
        desk_bot.tick(now)
        self.marks["SOLUSDT"] = 99.80  # -20 bps vs 18 bps SL
        desk_bot.tick(now + 1)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertLess(status["metrics"]["net_usdt"], 0)
        self.assertIn("Tight stop", status["closed"][-1]["reason"])

    def test_banks_when_peak_fades_before_tp(self):
        now = time.time()
        desk_bot.tick(now)
        self.marks["SOLUSDT"] = 100.22
        desk_bot.tick(now + 1)
        peak_net = desk_bot.status()["open"]["net"]
        self.assertGreater(peak_net, 0)
        self.marks["SOLUSDT"] = 100.16  # still net-green, fade > 35% of peak
        desk_bot.tick(now + 2)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertIn("Peak fading", status["closed"][-1]["reason"])
        self.assertGreater(status["closed"][-1]["net_usdt"], 0)

    def test_live_signal_bank_now_on_fade(self):
        desk_bot.command({"action": "stop"})
        self.positions = [
            {
                "symbol": "SOLUSDT",
                "side": "long",
                "leverage": 6,
                "unrealised_pnl": 1.20,
                "pnl_pct": 8.0,
                "mark": 110,
                "entry": 108,
            }
        ]
        desk_bot.tick(time.time())
        self.positions[0]["unrealised_pnl"] = 0.70
        desk_bot.tick(time.time() + 1)
        signals = desk_bot.status()["live_signals"]
        self.assertEqual(signals[0]["signal"], "BANK_NOW")
        self.assertFalse(signals[0]["executable"])

    def test_live_protect_when_underwater(self):
        desk_bot.command({"action": "stop"})
        self.positions = [
            {
                "symbol": "SOLUSDT",
                "side": "long",
                "leverage": 6,
                "unrealised_pnl": -8.23,
                "pnl_pct": -8.0,
                "mark": 108,
                "entry": 110,
            }
        ]
        desk_bot.tick(time.time())
        self.assertEqual(desk_bot.status()["live_signals"][0]["signal"], "PROTECT")

    def test_high_leverage_aggressive_entry(self):
        now = time.time()
        desk_bot.tick(now)
        pos = desk_bot.status()["open"]
        self.assertEqual(pos["leverage"], 50)
        self.assertGreater(pos["notional"], pos["margin"] * 40)
        self.assertTrue(pos["simulated"])

    def test_does_not_import_trade_place(self):
        import inspect

        source = inspect.getsource(desk_bot)
        self.assertNotIn("live_desk.trade_place", source)
        self.assertNotIn("close_position(", source)

    def test_fees_make_tiny_green_negative_until_be(self):
        # Round-trip 12 bps on notional must be covered before net is green.
        net = desk_bot._net_after_fees("long", 100.0, 100.10, 1.0)
        self.assertTrue(math.isfinite(net))
        self.assertLess(desk_bot._net_after_fees("long", 100.0, 100.05, 1.0), 0)


if __name__ == "__main__":
    unittest.main()
