"""Desk bot unit tests — paper TP/SL/BE, scan, leverage. No Bitget calls."""
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
        self.marks = {"SOLUSDT": 100.0, "BTCUSDT": 100.0, "ETHUSDT": 100.0}
        self.candle_move = 20.0
        self.five_move = 20.0
        self.positions = []
        desk_bot.set_market_hooks(
            ticker=lambda symbol: {
                "ok": True,
                "mark": self.marks.get(symbol, 100.0),
                "last": self.marks.get(symbol, 100.0),
            },
            candles=lambda symbol, gran="1m", limit=12: _candles(
                self.five_move if gran == "5m" else self.candle_move
            ),
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
        self.marks["SOLUSDT"] = 100.30
        desk_bot.tick(now + 2)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertGreater(status["metrics"]["net_usdt"], 0)
        self.assertIn("Take-profit", status["closed"][-1]["reason"])

    def test_break_even_protects_green(self):
        now = time.time()
        desk_bot.tick(now)
        self.marks["SOLUSDT"] = 100.18
        desk_bot.tick(now + 1)
        pos = desk_bot.status()["open"]
        self.assertTrue(pos["be_armed"])
        self.marks["SOLUSDT"] = 100.0
        desk_bot.tick(now + 2)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertIn("Break-even", status["closed"][-1]["reason"])
        self.assertGreater(status["closed"][-1]["net_usdt"], -0.40)

    def test_tight_stop_cuts_loss(self):
        now = time.time()
        desk_bot.tick(now)
        self.marks["SOLUSDT"] = 99.80
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
        self.marks["SOLUSDT"] = 100.16
        desk_bot.tick(now + 2)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertIn("Peak fading", status["closed"][-1]["reason"])
        self.assertGreater(status["closed"][-1]["net_usdt"], 0)

    def test_exits_when_1m_reverses(self):
        now = time.time()
        desk_bot.tick(now)
        self.assertIsNotNone(desk_bot.status()["open"])
        self.candle_move = -20.0
        desk_bot.tick(now + 10)
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        self.assertIn("reversed", status["closed"][-1]["reason"])

    def test_skips_when_5m_fights_1m(self):
        self.five_move = -20.0
        desk_bot.tick(time.time())
        status = desk_bot.status()
        self.assertIsNone(status["open"])
        skips = [row for row in status["scan"] if row["verdict"] == "SKIP"]
        self.assertTrue(skips)
        self.assertTrue(any("fights" in (row.get("reason") or "") for row in skips))

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

    def test_aggressive_uses_high_futures_leverage(self):
        now = time.time()
        desk_bot.tick(now)
        pos = desk_bot.status()["open"]
        self.assertGreaterEqual(pos["leverage"], 50)
        self.assertLessEqual(pos["leverage"], 150)
        self.assertGreaterEqual(pos["leverage"], 10)
        self.assertEqual(pos["category"], "USDT-FUTURES")
        self.assertTrue(pos["simulated"])
        policy = desk_bot.status()["leverage_policy"]
        self.assertEqual(policy["max"], 150)
        self.assertEqual(policy["safe_below"], 10)

    def test_safe_profile_stays_below_10x(self):
        desk_bot.command({"action": "start", "profile": "safe"})
        desk_bot.tick(time.time())
        pos = desk_bot.status()["open"]
        self.assertIsNotNone(pos)
        self.assertLess(pos["leverage"], 10)
        self.assertGreaterEqual(pos["leverage"], 1)

    def test_risk_profile_never_below_10x(self):
        desk_bot.command({"action": "start", "profile": "risk"})
        desk_bot.tick(time.time())
        pos = desk_bot.status()["open"]
        self.assertGreaterEqual(pos["leverage"], 10)
        self.assertLessEqual(pos["leverage"], 75)

    def test_balanced_alias_is_risk(self):
        desk_bot.command({"action": "profile", "profile": "balanced"})
        self.assertEqual(desk_bot.status()["profile"], "risk")

    def test_does_not_import_trade_place(self):
        import inspect

        source = inspect.getsource(desk_bot)
        self.assertNotIn("live_desk.trade_place", source)
        self.assertNotIn("close_position(", source)

    def test_fees_make_tiny_green_negative_until_be(self):
        net = desk_bot._net_after_fees("long", 100.0, 100.10, 1.0)
        self.assertTrue(math.isfinite(net))
        self.assertLess(desk_bot._net_after_fees("long", 100.0, 100.05, 1.0), 0)

    def test_leverage_helpers_respect_bands(self):
        desk_bot.command({"action": "profile", "profile": "safe"})
        self.assertLess(desk_bot._leverage_for(1.0), 10)
        desk_bot.command({"action": "profile", "profile": "aggressive"})
        self.assertEqual(desk_bot._leverage_for(1.0), 150)
        self.assertGreaterEqual(desk_bot._leverage_for(0.60), 10)


if __name__ == "__main__":
    unittest.main()
