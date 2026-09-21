"""Public Bitget market payloads — orderbook + tape. No live HTTP in tests."""
from __future__ import annotations

import unittest
from unittest.mock import patch

from . import live_desk


class OrderbookTests(unittest.TestCase):
    def test_levels_sort_and_skip_junk(self):
        asks = live_desk._book_levels(
            [[101, 2], ["100.5", "1"], None, {"price": 99, "size": 3}, [0, 1], [-1, 1]],
            reverse=False,
        )
        self.assertEqual([row["price"] for row in asks], [99.0, 100.5, 101.0])
        bids = live_desk._book_levels([[99, 1], [100, 2]], reverse=True)
        self.assertEqual([row["price"] for row in bids], [100.0, 99.0])

    def test_cumulative_notional(self):
        rows = live_desk._with_cumulative(
            [{"price": 10.0, "size": 2.0}, {"price": 11.0, "size": 1.0}]
        )
        self.assertEqual(rows[0]["cum_size"], 2.0)
        self.assertEqual(rows[1]["cum_size"], 3.0)
        self.assertEqual(rows[1]["cum_notional"], 31.0)

    def test_orderbook_payload_from_bitget_shape(self):
        sample = {
            "a": [["108.4", "2"], ["108.5", "5"]],
            "b": [["108.2", "1.5"], ["108.1", "4"]],
            "ts": "1730969017964",
        }
        with patch.object(live_desk, "_public_get", return_value=sample):
            payload = live_desk.orderbook_payload("solusdt", "USDT-FUTURES", 20)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["symbol"], "SOLUSDT")
        self.assertEqual(payload["best_ask"], 108.4)
        self.assertEqual(payload["best_bid"], 108.2)
        self.assertAlmostEqual(payload["spread"], 0.2)
        self.assertEqual(payload["asks"][0]["cum_size"], 2.0)
        self.assertEqual(payload["bids"][0]["price"], 108.2)
        self.assertEqual(payload["book_ts"], 1730969017964)
        self.assertFalse(payload["stale"])

    def test_orderbook_invalid_symbol(self):
        with self.assertRaises(ValueError):
            live_desk.orderbook_payload("../etc")

    def test_orderbook_stale_on_failure(self):
        sample = {"a": [[1, 1]], "b": [[0.9, 1]], "ts": "1"}
        with patch.object(live_desk, "_public_get", return_value=sample):
            live_desk.orderbook_payload("BTCUSDT", limit=5)
        with live_desk._lock:
            for hit in live_desk._orderbook_cache.values():
                hit["expires"] = 0.0
        with patch.object(live_desk, "_public_get", side_effect=RuntimeError("Bitget HTTP 429")):
            stale = live_desk.orderbook_payload("BTCUSDT", limit=5)
        self.assertTrue(stale["stale"])
        self.assertTrue(stale["ok"])
        self.assertIn("429", stale["error"])


class TradesTests(unittest.TestCase):
    def test_public_trade_normalise(self):
        row = live_desk._normalize_public_trade(
            {
                "execId": "9",
                "price": "110.3",
                "size": "0.4",
                "side": "buy",
                "ts": "1627116776464",
            },
            "SOLUSDT",
            "USDT-FUTURES",
        )
        self.assertEqual(row["side"], "buy")
        self.assertEqual(row["price"], 110.3)
        self.assertEqual(row["qty"], 0.4)
        self.assertEqual(row["time"], 1627116776)

    def test_trades_payload_newest_first(self):
        sample = [
            {
                "execId": "1",
                "price": "1",
                "size": "1",
                "side": "sell",
                "ts": "1000",
            },
            {
                "execId": "2",
                "price": "2",
                "size": "2",
                "side": "buy",
                "ts": "2000",
            },
        ]
        with patch.object(live_desk, "_public_get", return_value=sample):
            payload = live_desk.trades_payload("ETHUSDT", limit=40)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["trades"][0]["id"], "2")
        self.assertEqual(payload["trades"][0]["side"], "buy")


if __name__ == "__main__":
    unittest.main()
