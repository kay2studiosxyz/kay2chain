"""Keyless public market pump for the Bitbot scalp desk.

Primary: Bitget public WebSocket (no API key). Fallback: Bitget REST plus
free Binance USDT-M bookTicker and Bybit linear tickers. Never authenticates.
Never places orders.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import ssl
import struct
import threading
import time
from collections import deque
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

BITGET_WS = os.environ.get("BITBOT_BITGET_WS", "wss://ws.bitget.com/v2/ws/public")
BINANCE_REST = "https://fapi.binance.com/fapi/v1/ticker/bookTicker"
BYBIT_REST = "https://api.bybit.com/v5/market/tickers"
WATCH = ("SOLUSDT", "HYPEUSDT", "BTCUSDT", "ETHUSDT")
BINANCE_SYMS = frozenset({"SOLUSDT", "BTCUSDT", "ETHUSDT"})
BYBIT_SYMS = frozenset({"HYPEUSDT", "SOLUSDT", "BTCUSDT", "ETHUSDT"})
FRESH_SECONDS = 2.5
TRADE_CAP = 80
PING_EVERY = 25.0

_lock = threading.Lock()
_tickers: dict[str, dict[str, Any]] = {}
_books: dict[str, dict[str, Any]] = {}
_trades: dict[str, deque[dict[str, Any]]] = {}
_state: dict[str, Any] = {
    "running": False,
    "ws": "down",
    "last_ws": 0.0,
    "last_rest": 0.0,
    "error": None,
}
_started = threading.Event()


def reset_for_tests() -> None:
    with _lock:
        _tickers.clear()
        _books.clear()
        _trades.clear()
        _state.update({"running": False, "ws": "down", "last_ws": 0.0, "last_rest": 0.0, "error": None})


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result != result or result in (float("inf"), float("-inf")):
        return None
    return result


def _now() -> float:
    return time.monotonic()


def status() -> dict[str, Any]:
    with _lock:
        age = None
        if _state["last_ws"]:
            age = round(_now() - float(_state["last_ws"]), 3)
        return {
            "running": bool(_state["running"]),
            "ws": _state["ws"],
            "ws_age_s": age,
            "symbols": sorted(_tickers),
            "error": _state["error"],
        }


def ticker(symbol: str, max_age: float = FRESH_SECONDS) -> dict[str, Any] | None:
    with _lock:
        row = _tickers.get(symbol)
        if not row:
            return None
        if _now() - float(row.get("recv_at") or 0) > max_age:
            return None
        return dict(row)


def book(symbol: str, max_age: float = FRESH_SECONDS) -> dict[str, Any] | None:
    with _lock:
        row = _books.get(symbol)
        if not row:
            return None
        if _now() - float(row.get("recv_at") or 0) > max_age:
            return None
        return {"asks": list(row.get("asks") or []), "bids": list(row.get("bids") or []), "ts": row.get("ts"), "source": row.get("source")}


def trades(symbol: str, limit: int = 40) -> list[dict[str, Any]]:
    with _lock:
        q = _trades.get(symbol)
        if not q:
            return []
        return list(q)[: max(1, min(TRADE_CAP, limit))]


def ingest_message(raw: Any) -> str | None:
    """Apply one public Bitget WS payload. Returns channel or None."""
    if isinstance(raw, str):
        if raw in {"pong", "ping"}:
            return raw
        text = raw.strip()
        if text in {"pong", "ping"}:
            return text
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            return None
    elif isinstance(raw, dict):
        msg = raw
    else:
        return None
    if not isinstance(msg, dict):
        return None
    if msg.get("event") in {"subscribe", "error"}:
        return str(msg.get("event"))
    arg = msg.get("arg") if isinstance(msg.get("arg"), dict) else {}
    channel = str(arg.get("channel") or arg.get("topic") or "")
    inst = str(arg.get("instId") or arg.get("symbol") or "").upper()
    rows = msg.get("data") if isinstance(msg.get("data"), list) else []
    if not inst or not rows:
        return channel or None
    if channel == "ticker":
        _apply_ticker(inst, rows[0] if isinstance(rows[0], dict) else {}, "bitget-ws")
        return "ticker"
    if channel in {"books15", "books5", "books1", "books"}:
        _apply_book(inst, rows[0] if isinstance(rows[0], dict) else {}, "bitget-ws")
        return "book"
    if channel == "trade":
        for row in rows:
            if isinstance(row, dict):
                _apply_trade(inst, row, "bitget-ws")
        return "trade"
    return channel or None


def ingest_binance_book(symbol: str, row: dict[str, Any]) -> None:
    bid = _num(row.get("bidPrice"))
    ask = _num(row.get("askPrice"))
    last = bid if bid is None or ask is None else (bid + ask) / 2.0
    _apply_ticker(
        symbol,
        {
            "lastPr": last,
            "bidPr": bid,
            "askPr": ask,
            "bidSz": row.get("bidQty"),
            "askSz": row.get("askQty"),
        },
        "binance-rest",
        mark=None,
    )


def ingest_bybit_ticker(symbol: str, row: dict[str, Any]) -> None:
    _apply_ticker(
        symbol,
        {
            "lastPr": row.get("lastPrice"),
            "markPr": row.get("markPrice"),
            "bidPr": row.get("bid1Price"),
            "askPr": row.get("ask1Price"),
            "bidSz": row.get("bid1Size"),
            "askSz": row.get("ask1Size"),
            "high24h": row.get("highPrice24h"),
            "low24h": row.get("lowPrice24h"),
            "fundingRate": row.get("fundingRate"),
            "openInterest": row.get("openInterest"),
            "turnover24h": row.get("turnover24h"),
        },
        "bybit-rest",
    )


def _apply_ticker(symbol: str, row: dict[str, Any], source: str, mark: Any = "") -> None:
    last = _num(row.get("lastPr") or row.get("lastPrice") or row.get("last"))
    mark_px = _num(row.get("markPr") or row.get("markPrice") or row.get("indexPr") or row.get("indexPrice"))
    if mark is None:
        mark_px = mark_px or last
    elif mark != "":
        mark_px = _num(mark)
    bid = _num(row.get("bidPr") or row.get("bid1Price") or row.get("bestBid"))
    ask = _num(row.get("askPr") or row.get("ask1Price") or row.get("bestAsk"))
    if last is None and bid is not None and ask is not None:
        last = (bid + ask) / 2.0
    if last is None and mark_px is None:
        return
    open24 = _num(row.get("open24h") or row.get("openPrice24h"))
    change = _num(row.get("change24h") or row.get("price24hPcnt"))
    if change is not None and abs(change) <= 2:
        change = change * 100.0
    if change is None and open24 and last is not None and abs(open24) > 1e-12:
        change = ((last - open24) / open24) * 100.0
    payload = {
        "symbol": symbol,
        "last": last,
        "mark": mark_px or last,
        "bid": bid,
        "ask": ask,
        "bid_size": _num(row.get("bidSz") or row.get("bid1Size")),
        "ask_size": _num(row.get("askSz") or row.get("ask1Size")),
        "high24h": _num(row.get("high24h") or row.get("highPrice24h")),
        "low24h": _num(row.get("low24h") or row.get("lowPrice24h")),
        "open24h": open24,
        "change24h": change,
        "base_volume": _num(row.get("baseVolume") or row.get("volume24h")),
        "quote_volume": _num(row.get("quoteVolume") or row.get("turnover24h")),
        "funding": _num(row.get("fundingRate") or row.get("funding")),
        "open_interest": _num(row.get("openInterest") or row.get("holding")),
        "source": source,
        "recv_at": _now(),
        "ts": _num(row.get("ts")) or int(time.time() * 1000),
    }
    with _lock:
        prev = _tickers.get(symbol) or {}
        if source != "bitget-ws":
            # Don't clobber a live Bitget tape with a slower venue.
            if prev.get("source") == "bitget-ws" and _now() - float(prev.get("recv_at") or 0) < FRESH_SECONDS:
                return
            for key in ("high24h", "low24h", "open24h", "change24h", "funding", "open_interest", "quote_volume"):
                if payload.get(key) is None:
                    payload[key] = prev.get(key)
        _tickers[symbol] = payload
        if source.startswith("bitget"):
            _state["last_ws"] = payload["recv_at"]
            _state["ws"] = "up"
        else:
            _state["last_rest"] = payload["recv_at"]


def _apply_book(symbol: str, row: dict[str, Any], source: str) -> None:
    asks = row.get("asks") or row.get("a") or []
    bids = row.get("bids") or row.get("b") or []
    if not isinstance(asks, list) or not isinstance(bids, list):
        return
    ts = _num(row.get("ts"))
    with _lock:
        _books[symbol] = {"asks": asks, "bids": bids, "ts": ts, "source": source, "recv_at": _now()}
        if source.startswith("bitget"):
            _state["last_ws"] = _now()
            _state["ws"] = "up"


def _apply_trade(symbol: str, row: dict[str, Any], source: str) -> None:
    side = str(row.get("side") or "").strip().lower()
    if side not in {"buy", "sell"}:
        return
    price = _num(row.get("price") or row.get("px"))
    qty = _num(row.get("size") or row.get("sz") or row.get("qty"))
    raw_t = row.get("ts") or row.get("ts_ms")
    try:
        ts_ms = int(str(raw_t).strip())
    except (TypeError, ValueError):
        ts_ms = int(time.time() * 1000)
    if ts_ms < 10_000_000_000:
        ts_ms *= 1000
    if price is None or qty is None or price <= 0 or qty <= 0:
        return
    item = {
        "id": str(row.get("tradeId") or row.get("execId") or f"{symbol}-{ts_ms}-{side}")[:80],
        "symbol": symbol,
        "category": "USDT-FUTURES",
        "side": side,
        "price": price,
        "qty": qty,
        "ts_ms": ts_ms,
        "time": ts_ms // 1000,
        "source": source,
    }
    with _lock:
        q = _trades.setdefault(symbol, deque(maxlen=TRADE_CAP))
        if q and q[0].get("id") == item["id"]:
            return
        q.appendleft(item)
        if source.startswith("bitget"):
            _state["last_ws"] = _now()
            _state["ws"] = "up"


def _http_json(url: str, timeout: float = 3.0) -> Any:
    req = Request(url, headers={"User-Agent": "bitbot-desk/2.6", "Accept": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def poll_free_rest() -> None:
    """Backup last/bid/ask from free public REST when Bitget WS is quiet."""
    try:
        for sym in BINANCE_SYMS:
            try:
                row = _http_json(f"{BINANCE_REST}?symbol={sym}")
                if isinstance(row, dict):
                    ingest_binance_book(sym, row)
            except (URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
                continue
        for sym in WATCH:
            if sym not in BYBIT_SYMS:
                continue
            try:
                payload = _http_json(f"{BYBIT_REST}?category=linear&symbol={sym}")
                rows = ((payload or {}).get("result") or {}).get("list") or []
                if rows and isinstance(rows[0], dict):
                    ingest_bybit_ticker(sym, rows[0])
            except (URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError, AttributeError):
                continue
        with _lock:
            _state["last_rest"] = _now()
            _state["error"] = None
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _state["error"] = str(exc)[:160]


def _ws_key() -> str:
    raw = os.urandom(16)
    return base64.b64encode(raw).decode("ascii")


def _mask(payload: bytes) -> bytes:
    key = os.urandom(4)
    return key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def _send_frame(sock: Any, payload: bytes, opcode: int = 1) -> None:
    header = bytearray()
    n = len(payload)
    header.append(0x80 | opcode)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", n))
    sock.sendall(bytes(header) + _mask(payload))


def _recv_exact(sock: Any, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed")
        buf.extend(chunk)
    return bytes(buf)


def _recv_frame(sock: Any) -> tuple[int, bytes]:
    hdr = _recv_exact(sock, 2)
    opcode = hdr[0] & 0x0F
    masked = bool(hdr[1] & 0x80)
    length = hdr[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    mask = _recv_exact(sock, 4) if masked else b""
    data = _recv_exact(sock, length)
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def _connect_ws(url: str) -> Any:
    parsed = urlparse(url)
    host = parsed.hostname or "ws.bitget.com"
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    raw = __import__("socket").create_connection((host, port), timeout=8)
    sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if parsed.scheme == "wss" else raw
    sock.settimeout(12)
    key = _ws_key()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "User-Agent: bitbot-desk/2.6\r\n"
        "\r\n"
    )
    sock.sendall(req.encode("ascii"))
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("no WS handshake")
        header += chunk
        if len(header) > 8192:
            raise ConnectionError("handshake too large")
    status = header.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        raise ConnectionError(status.decode("ascii", "replace")[:120])
    expect = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
    if expect.encode("ascii") not in header:
        raise ConnectionError("bad WS accept")
    leftover = header.split(b"\r\n\r\n", 1)[1]
    if leftover:
        # Rare; Bitget doesn't send payload with the handshake.
        pass
    return sock


def _subscribe_args() -> list[dict[str, str]]:
    args: list[dict[str, str]] = []
    for sym in WATCH:
        for channel in ("ticker", "books15", "trade"):
            args.append({"instType": "USDT-FUTURES", "channel": channel, "instId": sym})
    return args


def _ws_loop() -> None:
    delay = 1.0
    while _state["running"]:
        sock = None
        try:
            sock = _connect_ws(BITGET_WS)
            _send_frame(sock, json.dumps({"op": "subscribe", "args": _subscribe_args()}).encode("utf-8"))
            with _lock:
                _state["ws"] = "up"
                _state["error"] = None
            last_ping = _now()
            delay = 1.0
            while _state["running"]:
                if _now() - last_ping >= PING_EVERY:
                    _send_frame(sock, b"ping")
                    last_ping = _now()
                try:
                    opcode, data = _recv_frame(sock)
                except TimeoutError:
                    continue
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    _send_frame(sock, data, opcode=0xA)
                    continue
                if opcode == 0xA:
                    continue
                if opcode != 0x1:
                    continue
                ingest_message(data.decode("utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001
            with _lock:
                _state["ws"] = "down"
                _state["error"] = str(exc)[:160]
            time.sleep(delay)
            delay = min(20.0, delay * 1.7 + random.random())
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


def _rest_loop() -> None:
    while _state["running"]:
        quiet = True
        with _lock:
            last = float(_state["last_ws"] or 0)
            quiet = (_now() - last) > 1.2 or _state["ws"] != "up"
        if quiet:
            poll_free_rest()
        time.sleep(0.45 if quiet else 2.0)


def start(watch: tuple[str, ...] | None = None) -> None:
    """Idempotent background start. Safe to call from warm_cache."""
    del watch
    with _lock:
        if _state["running"]:
            return
        _state["running"] = True
    threading.Thread(target=_ws_loop, name="bitbot-public-ws", daemon=True).start()
    threading.Thread(target=_rest_loop, name="bitbot-public-rest", daemon=True).start()
    _started.set()
