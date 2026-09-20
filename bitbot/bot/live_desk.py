"""Bitget UTA live desk for the Bitbot trading dashboard.

Read-only market + account by default. LIVE order placement stays locked
unless BITBOT_LIVE_OK is explicitly unlocked (env or unlock file).
Never exposes API keys. Global STOP ALL TRADING applies while locked.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import threading
import time
import types
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DESK_VERSION = "desk-2.2.1"
DESK_MODE = "PAPER_WATCH"
CACHE_TTL_SECONDS = 3.0
TICKER_TTL_SECONDS = 1.5
CANDLES_TTL_SECONDS = 8.0
FILLS_TTL_SECONDS = 5.0
FILLS_LIMIT_DEFAULT = 80
FILLS_LIMIT_MAX = 200
CATEGORIES = ("USDT-FUTURES", "USDC-FUTURES")
ALLOWED_CATEGORIES = frozenset(
    {"USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES", "SPOT"}
)
ALLOWED_GRANULARITY = frozenset(
    {"1m", "3m", "5m", "15m", "30m", "1H", "4H", "6H", "12H", "1D"}
)
GRANULARITY_ALIASES = {
    "1h": "1H",
    "4h": "4H",
    "6h": "6H",
    "12h": "12H",
    "1d": "1D",
    "1D": "1D",
    "1H": "1H",
    "4H": "4H",
}
BITGET_REST = "https://api.bitget.com"
PERPS_ROOT = Path("/home/kay2/bitget-perps-bot")
PERPS_ENV = PERPS_ROOT / ".env"
PERPS_BITGET = PERPS_ROOT / "bot" / "bitget.py"
REBUILD_ROOT = Path("/home/kay2/bitbot-rebuild")
REBUILD_ENV = REBUILD_ROOT / ".env"
LIVE_UNLOCK_FILE = REBUILD_ROOT / "data" / "LIVE_OK"

_lock = threading.Lock()
_cache: dict[str, Any] = {"expires": 0.0, "payload": None, "error": None}
_fetching = threading.Event()
_pnl_lock = threading.Lock()
_pnl_history: deque[dict[str, Any]] = deque(maxlen=240)


def _record_pnl(account: dict[str, Any] | None) -> None:
    if not isinstance(account, dict):
        return
    equity = account.get("equity")
    upnl = account.get("unrealised_pnl")
    if equity is None and upnl is None:
        return
    now = int(time.time())
    point = {"t": now, "equity": equity, "upnl": upnl}
    with _pnl_lock:
        last = _pnl_history[-1] if _pnl_history else None
        if last and int(last.get("t") or 0) == now:
            last.update(point)
            return
        _pnl_history.append(point)


def pnl_history() -> list[dict[str, Any]]:
    with _pnl_lock:
        return [dict(row) for row in _pnl_history]
_fetch_lock = threading.Lock()
_ticker_cache: dict[str, Any] = {}
_candles_cache: dict[str, Any] = {}
_fills_cache: dict[str, Any] = {}
_client_mod: types.ModuleType | None = None


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _load_env(path: Path) -> dict[str, str]:
    """Minimal .env loader — secrets never logged or exposed via API."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip(chr(39)).strip(chr(34))
        if key:
            out[key] = value
    return out


def live_unlock_status() -> dict[str, Any]:
    """LIVE trading unlock gate. Default locked. STOP ALL TRADING while off."""
    merged = {}
    merged.update(_load_env(PERPS_ENV))
    merged.update(_load_env(REBUILD_ENV))
    env_val = (
        os.environ.get("BITBOT_LIVE_OK")
        or merged.get("BITBOT_LIVE_OK")
        or "0"
    ).strip().lower()
    env_ok = env_val in {"1", "true", "yes", "ok", "live"}
    file_ok = False
    if LIVE_UNLOCK_FILE.is_file():
        try:
            file_ok = LIVE_UNLOCK_FILE.read_text(encoding="utf-8").strip().upper() == "OK"
        except OSError:
            file_ok = False
    unlocked = bool(env_ok or file_ok)
    return {
        "unlocked": unlocked,
        "bitbot_live_ok": env_val if env_val else "0",
        "unlock_file": str(LIVE_UNLOCK_FILE) if file_ok else None,
        "message": (
            "LIVE unlocked — real Bitget orders allowed"
            if unlocked
            else "LIVE locked — Kane LIVE OK required (BITBOT_LIVE_OK). STOP ALL TRADING."
        ),
    }


def is_live_unlocked() -> bool:
    return bool(live_unlock_status().get("unlocked"))


def _load_perps_bitget() -> types.ModuleType:
    """Load perps-bot BitgetClient by file path to avoid clashing with rebuild bot/."""
    global _client_mod
    if _client_mod is not None:
        return _client_mod
    if not PERPS_BITGET.is_file():
        raise RuntimeError("Perps Bitget client not found on NUC")
    spec = importlib.util.spec_from_file_location("bitget_perps_uta_client", PERPS_BITGET)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load perps Bitget client")
    mod = importlib.util.module_from_spec(spec)
    import sys

    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    _client_mod = mod
    return mod


def _position_size(row: dict[str, Any]) -> float:
    for key in ("total", "size", "available"):
        n = _num(row.get(key))
        if n is not None and abs(n) > 0:
            return abs(n)
    return 0.0


def _enrich_position(pos: dict[str, Any]) -> dict[str, Any]:
    """Add desk-friendly fields: pnl %, distance to liq, margin."""
    out = dict(pos)
    entry = _num(out.get("entry"))
    mark = _num(out.get("mark"))
    size = _num(out.get("size")) or 0.0
    upnl = _num(out.get("unrealised_pnl"))
    liq = _num(out.get("liq"))
    leverage = _num(out.get("leverage")) or 1.0
    margin = _num(out.get("position_balance"))
    if margin is None and entry and size and leverage:
        margin = abs(entry * size) / max(leverage, 1e-9)
    out["margin"] = margin
    notional = None
    if mark is not None and size:
        notional = abs(mark * size)
    elif entry is not None and size:
        notional = abs(entry * size)
    out["notional"] = notional

    pnl_pct = _num(out.get("profit_rate"))
    if pnl_pct is not None and abs(pnl_pct) <= 5:
        # Bitget profitRate is often a fraction (-0.17 = -17%)
        pnl_pct = pnl_pct * 100.0
    if pnl_pct is None and upnl is not None and margin and abs(margin) > 1e-9:
        pnl_pct = (upnl / abs(margin)) * 100.0
    if pnl_pct is None and upnl is not None and entry and size and abs(entry * size) > 1e-9:
        pnl_pct = (upnl / abs(entry * size)) * 100.0
    out["pnl_pct"] = pnl_pct

    dist_liq_pct = None
    dist_liq_abs = None
    if mark is not None and liq is not None and abs(mark) > 1e-9:
        dist_liq_abs = mark - liq
        dist_liq_pct = (abs(dist_liq_abs) / abs(mark)) * 100.0
    out["distance_to_liq"] = dist_liq_abs
    out["distance_to_liq_pct"] = dist_liq_pct
    return out


def _normalize_position(row: dict[str, Any], category: str) -> dict[str, Any] | None:
    size = _position_size(row)
    if size <= 0:
        return None
    side = row.get("posSide") or row.get("holdSide") or row.get("side") or "unknown"
    entry = _num(row.get("avgPrice") or row.get("averageOpenPrice") or row.get("openPriceAvg"))
    raw = {
        "symbol": str(row.get("symbol") or ""),
        "category": str(row.get("category") or category),
        "side": str(side).lower(),
        "size": size,
        "leverage": _num(row.get("leverage")),
        "entry": entry,
        "mark": _num(row.get("markPrice")),
        "unrealised_pnl": _num(row.get("unrealisedPnl") or row.get("unrealizedPnl")),
        "liq": _num(row.get("liquidationPrice")),
        "break_even": _num(row.get("breakEvenPrice")),
        "margin_mode": (str(row.get("marginMode") or "").lower() or None),
        "margin_coin": row.get("marginCoin"),
        "position_balance": _num(
            row.get("positionBalance") or row.get("positionMargin") or row.get("im")
        ),
        "profit_rate": _num(row.get("profitRate")),
        "updated_at": row.get("updatedTime"),
    }
    return _enrich_position(raw)


def _sanitize_account(raw: dict[str, Any]) -> dict[str, Any]:
    assets = []
    for item in raw.get("assets") or []:
        if not isinstance(item, dict):
            continue
        coin = str(item.get("coin") or "")
        if not coin:
            continue
        assets.append(
            {
                "coin": coin,
                "equity": _num(item.get("equity")),
                "usd_value": _num(item.get("usdValue")),
                "available": _num(item.get("available")),
                "balance": _num(item.get("balance")),
            }
        )
    return {
        "equity": _num(raw.get("accountEquity") or raw.get("effEquity") or raw.get("usdtEquity")),
        "usdt_equity": _num(raw.get("usdtEquity")),
        "eff_equity": _num(raw.get("effEquity")),
        "unrealised_pnl": _num(raw.get("unrealisedPnl") or raw.get("unrealizedPnl")),
        "usdt_unrealised_pnl": _num(raw.get("usdtUnrealisedPnl")),
        "mmr": _num(raw.get("mmr")),
        "imr": _num(raw.get("imr")),
        "margin_ratio": _num(raw.get("mgnRatio")),
        "position_margin_ratio": _num(raw.get("positionMgnRatio")),
        "position_value": _num(raw.get("positionValue")),
        "leverage": _num(raw.get("leverage")),
        "assets": assets,
    }


async def _fetch_live() -> dict[str, Any]:
    env = _load_env(PERPS_ENV)
    key = env.get("BITGET_API_KEY") or os.environ.get("BITGET_API_KEY")
    secret = env.get("BITGET_API_SECRET") or os.environ.get("BITGET_API_SECRET")
    passphrase = env.get("BITGET_API_PASSPHRASE") or os.environ.get("BITGET_API_PASSPHRASE")
    if not key or not secret or not passphrase:
        raise RuntimeError("Bitget credentials unavailable for live desk reads")

    mod = _load_perps_bitget()
    client = mod.BitgetClient(
        api_key=key,
        api_secret=secret,
        passphrase=passphrase,
        product_type="USDT-FUTURES",
        margin_coin="USDT",
    )
    try:
        await client.sync_clock()
        account_raw = await client.account()
        if not isinstance(account_raw, dict):
            account_raw = {}
        positions: list[dict[str, Any]] = []
        category_errors: list[dict[str, str]] = []
        for category in CATEGORIES:
            try:
                data = await client._request(
                    "GET",
                    "/api/v3/position/current-position",
                    params={"category": category},
                )
                rows = (data or {}).get("list") or []
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    normalized = _normalize_position(row, category)
                    if normalized:
                        positions.append(normalized)
            except Exception as exc:  # noqa: BLE001
                category_errors.append({"category": category, "error": str(exc)[:200]})
        return {
            "ok": True,
            "account": _sanitize_account(account_raw),
            "positions": positions,
            "category_errors": category_errors,
            "fetched_at": _utcnow(),
        }
    finally:
        await client.close()


def _run_fetch() -> dict[str, Any]:
    return asyncio.run(_fetch_live())



def get_snapshot(force: bool = False) -> dict[str, Any]:
    """Cached live snapshot. Never raises — returns structured error on failure.

    Single-flight: concurrent callers wait for one Bitget fetch instead of
    stacking parallel asyncio.run calls (which hung the desk on cold load).
    """
    now = time.monotonic()
    with _lock:
        if not force and _cache["payload"] is not None and now < _cache["expires"]:
            return dict(_cache["payload"])
        previous = _cache["payload"]

    # If another thread is already fetching, wait briefly then return cache/stale.
    with _fetch_lock:
        leader = not _fetching.is_set()
        if leader:
            _fetching.set()

    if not leader:
        _fetching.wait(timeout=8.0)
        with _lock:
            if _cache["payload"] is not None:
                return dict(_cache["payload"])
            if _cache["error"] is not None:
                return dict(_cache["error"])
        return {
            "ok": False,
            "mode": DESK_MODE,
            "version": DESK_VERSION,
            "ts": _utcnow(),
            "live": None,
            "error": "Live snapshot still loading",
            "stale": False,
        }

    try:
        fresh = _run_fetch()
        payload = {
            "ok": True,
            "mode": DESK_MODE,
            "version": DESK_VERSION,
            "ts": _utcnow(),
            "live": fresh,
            "error": None,
            "stale": False,
        }
        with _lock:
            _cache["payload"] = payload
            _cache["expires"] = time.monotonic() + CACHE_TTL_SECONDS
            _cache["error"] = None
        live_acct = (fresh or {}).get("account") if isinstance(fresh, dict) else None
        _record_pnl(live_acct if isinstance(live_acct, dict) else None)
        return dict(payload)
    except Exception as exc:  # noqa: BLE001
        err_msg = str(exc)[:300]
        with _lock:
            _cache["error"] = {"ok": False, "error": err_msg, "ts": _utcnow()}
            if previous is not None:
                stale = dict(previous)
                stale["stale"] = True
                stale["error"] = err_msg
                stale["ts"] = _utcnow()
                _cache["expires"] = time.monotonic() + min(5.0, CACHE_TTL_SECONDS)
                _cache["payload"] = stale
                return dict(stale)
            failed = {
                "ok": False,
                "mode": DESK_MODE,
                "version": DESK_VERSION,
                "ts": _utcnow(),
                "live": None,
                "error": err_msg,
                "stale": False,
            }
            _cache["payload"] = failed
            _cache["expires"] = time.monotonic() + 5.0
            return dict(failed)
    finally:
        _fetching.clear()



def health() -> dict[str, Any]:
    lock = live_unlock_status()
    return {
        "ok": True,
        "service": "bitbot-dashboard",
        "mode": DESK_MODE,
        "version": DESK_VERSION,
        "ts": _utcnow(),
        "live_trading": bool(lock.get("unlocked")),
        "live_lock": lock.get("message"),
    }


def account_payload() -> dict[str, Any]:
    snap = get_snapshot()
    if not snap.get("ok") or not snap.get("live"):
        return {
            "ok": False,
            "mode": DESK_MODE,
            "error": snap.get("error") or "Live account unavailable",
            "ts": snap.get("ts") or _utcnow(),
            "stale": bool(snap.get("stale")),
        }
    live = snap["live"]
    return {
        "ok": True,
        "mode": DESK_MODE,
        "ts": snap.get("ts") or live.get("fetched_at"),
        "stale": bool(snap.get("stale")),
        "account": live.get("account"),
        "category_errors": live.get("category_errors") or [],
        "pnl_history": pnl_history(),
    }


def positions_payload() -> dict[str, Any]:
    snap = get_snapshot()
    if not snap.get("ok") or not snap.get("live"):
        return {
            "ok": False,
            "mode": DESK_MODE,
            "error": snap.get("error") or "Live positions unavailable",
            "ts": snap.get("ts") or _utcnow(),
            "stale": bool(snap.get("stale")),
            "positions": [],
            "count": 0,
        }
    live = snap["live"]
    positions = [_enrich_position(p) for p in (live.get("positions") or [])]
    return {
        "ok": True,
        "mode": DESK_MODE,
        "ts": snap.get("ts") or live.get("fetched_at"),
        "stale": bool(snap.get("stale")),
        "positions": positions,
        "count": len(positions),
        "category_errors": live.get("category_errors") or [],
    }


def desk_summary(paper_session: dict[str, Any] | None = None) -> dict[str, Any]:
    snap = get_snapshot()
    alerts: list[str] = []
    account = None
    positions: list[dict[str, Any]] = []
    if snap.get("ok") and snap.get("live"):
        live = snap["live"]
        account = live.get("account") or {}
        positions = [_enrich_position(p) for p in (live.get("positions") or [])]
        for err in live.get("category_errors") or []:
            alerts.append(f"category {err.get('category')}: {err.get('error')}")
    elif snap.get("error"):
        alerts.append(str(snap["error"]))
    if snap.get("stale"):
        alerts.append("Showing cached live data after a refresh failure")

    equity = (account or {}).get("equity") if account else None
    upnl = (account or {}).get("unrealised_pnl") if account else None
    if upnl is None and positions:
        parts = [p.get("unrealised_pnl") for p in positions if p.get("unrealised_pnl") is not None]
        if parts:
            upnl = sum(parts)

    paper = None
    if isinstance(paper_session, dict) and paper_session:
        paper = {
            "id": paper_session.get("id"),
            "label": paper_session.get("label"),
            "status": paper_session.get("status"),
            "stale": paper_session.get("stale"),
        }

    if account:
        _record_pnl(account)

    lock = live_unlock_status()
    bot = None
    try:
        from . import desk_bot

        bot = desk_bot.status()
    except Exception:
        bot = None
    return {
        "ok": bool(snap.get("ok")),
        "mode": DESK_MODE,
        "version": DESK_VERSION,
        "ts": snap.get("ts") or _utcnow(),
        "stale": bool(snap.get("stale")),
        "equity": equity,
        "unrealised_pnl": upnl,
        "open_positions_count": len(positions),
        "positions": positions,
        "account": account,
        "paper_session": paper,
        "bot": bot,
        "live_trading": bool(lock.get("unlocked")),
        "live_lock": lock.get("message"),
        "alerts": alerts or None,
        "error": None if snap.get("ok") else snap.get("error"),
        "pnl_history": pnl_history(),
    }


def _normalize_symbol(symbol: str) -> str:
    sym = (symbol or "").strip().upper().replace("/", "").replace("-", "").replace("_", "")
    if not sym or len(sym) > 32 or not sym.isalnum():
        raise ValueError("Invalid symbol")
    return sym


def _normalize_category(category: str | None) -> str:
    cat = (category or "USDT-FUTURES").strip().upper()
    if cat not in ALLOWED_CATEGORIES:
        raise ValueError("Invalid category")
    return cat


def _normalize_granularity(granularity: str | None) -> str:
    raw = (granularity or "15m").strip()
    mapped = GRANULARITY_ALIASES.get(raw, GRANULARITY_ALIASES.get(raw.lower(), raw))
    if mapped not in ALLOWED_GRANULARITY:
        raise ValueError("Invalid granularity")
    return mapped


def _public_get(path: str, params: dict[str, Any]) -> Any:
    url = f"{BITGET_REST}{path}?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": "bitbot-desk/2.0", "Accept": "application/json"})
    try:
        with urlopen(req, timeout=6) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        raise RuntimeError(f"Bitget HTTP {exc.code}") from exc
    except URLError as exc:
        raise RuntimeError(f"Bitget unreachable: {exc.reason}") from exc
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Bitget returned non-JSON") from exc
    if str(payload.get("code")) != "00000":
        raise RuntimeError(str(payload.get("msg") or "Bitget error")[:200])
    return payload.get("data")


def _classify_fill_side(row: dict[str, Any]) -> str | None:
    """Map Bitget fill fields to buy/sell for chart bubbles."""
    side = str(row.get("side") or "").strip().lower()
    if side in {"buy", "b", "bid", "long"}:
        return "buy"
    if side in {"sell", "s", "ask", "short"}:
        return "sell"
    trade_side = str(row.get("tradeSide") or "").strip().lower()
    if trade_side.startswith("buy"):
        return "buy"
    if trade_side.startswith("sell"):
        return "sell"
    pos = str(row.get("posSide") or "").strip().lower()
    # Heuristic: opening long ≈ buy bubble; opening short ≈ sell bubble.
    if pos == "long" and "open" in trade_side:
        return "buy"
    if pos == "short" and "open" in trade_side:
        return "sell"
    if pos == "long" and "close" in trade_side:
        return "sell"
    if pos == "short" and "close" in trade_side:
        return "buy"
    return None


def _normalize_fill(row: dict[str, Any], symbol: str, category: str) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    side = _classify_fill_side(row)
    if side is None:
        return None
    price = _num(row.get("price") or row.get("execPrice"))
    qty = _num(row.get("baseVolume") or row.get("execQty") or row.get("size"))
    raw_t = row.get("cTime") or row.get("createdTime") or row.get("updatedTime") or row.get("ts")
    try:
        ts_ms = int(str(raw_t).strip())
    except (TypeError, ValueError):
        return None
    # Bitget sometimes returns seconds; normalise to ms.
    if ts_ms < 10_000_000_000:
        ts_ms *= 1000
    if price is None or qty is None or qty <= 0:
        return None
    return {
        "id": str(row.get("tradeId") or row.get("fillId") or row.get("orderId") or f"{symbol}-{ts_ms}-{side}")[:80],
        "symbol": symbol,
        "category": category,
        "side": side,
        "price": price,
        "qty": qty,
        "ts_ms": ts_ms,
        "time": ts_ms // 1000,
        "pos_side": str(row.get("posSide") or "")[:16] or None,
        "source": "bitget",
    }


async def _fetch_fills(symbol: str, category: str, limit: int) -> list[dict[str, Any]]:
    env = _load_env(PERPS_ENV)
    key = env.get("BITGET_API_KEY") or os.environ.get("BITGET_API_KEY")
    secret = env.get("BITGET_API_SECRET") or os.environ.get("BITGET_API_SECRET")
    passphrase = env.get("BITGET_API_PASSPHRASE") or os.environ.get("BITGET_API_PASSPHRASE")
    if not key or not secret or not passphrase:
        raise RuntimeError("Bitget credentials unavailable for fills")

    mod = _load_perps_bitget()
    client = mod.BitgetClient(
        api_key=key,
        api_secret=secret,
        passphrase=passphrase,
        product_type=category if category.endswith("FUTURES") else "USDT-FUTURES",
        margin_coin="USDT",
    )
    try:
        await client.sync_clock()
        if hasattr(client, "fills"):
            rows = await client.fills(symbol, limit=limit)
        else:
            data = await client._request(
                "GET",
                "/api/v3/trade/fills",
                params={"category": category, "symbol": symbol, "limit": limit},
            )
            rows = (data or {}).get("list") or []
    finally:
        await client.close()

    out: list[dict[str, Any]] = []
    for row in rows or []:
        normalized = _normalize_fill(row, symbol, category)
        if normalized:
            out.append(normalized)
    out.sort(key=lambda item: item["ts_ms"])
    return out


def fills_payload(
    symbol: str,
    category: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Recent Bitget fills for chart buy/sell bubbles."""
    sym = _normalize_symbol(symbol)
    cat = _normalize_category(category)
    lim = FILLS_LIMIT_DEFAULT if limit is None else int(limit)
    lim = max(1, min(FILLS_LIMIT_MAX, lim))
    cache_key = f"{cat}:{sym}:{lim}"
    now = time.monotonic()
    with _lock:
        hit = _fills_cache.get(cache_key)
        if hit and now < hit["expires"]:
            return dict(hit["payload"])

    try:
        fills = asyncio.run(_fetch_fills(sym, cat, lim))
        payload = {
            "ok": True,
            "mode": DESK_MODE,
            "version": DESK_VERSION,
            "ts": _utcnow(),
            "symbol": sym,
            "category": cat,
            "fills": fills,
            "count": len(fills),
            "stale": False,
        }
        with _lock:
            _fills_cache[cache_key] = {
                "expires": time.monotonic() + FILLS_TTL_SECONDS,
                "payload": payload,
            }
            if len(_fills_cache) > 48:
                for k in list(_fills_cache.keys())[:12]:
                    _fills_cache.pop(k, None)
        return payload
    except Exception as exc:  # noqa: BLE001
        with _lock:
            hit = _fills_cache.get(cache_key)
            if hit:
                stale = dict(hit["payload"])
                stale["stale"] = True
                stale["error"] = str(exc)[:200]
                stale["ts"] = _utcnow()
                return stale
        return {
            "ok": False,
            "mode": DESK_MODE,
            "version": DESK_VERSION,
            "ts": _utcnow(),
            "symbol": sym,
            "category": cat,
            "fills": [],
            "count": 0,
            "error": str(exc)[:200],
        }


def ticker_payload(symbol: str, category: str | None = None) -> dict[str, Any]:
    sym = _normalize_symbol(symbol)
    cat = _normalize_category(category)
    cache_key = f"{cat}:{sym}"
    now = time.monotonic()
    with _lock:
        hit = _ticker_cache.get(cache_key)
        if hit and now < hit["expires"]:
            return dict(hit["payload"])

    try:
        data = _public_get(
            "/api/v3/market/tickers",
            {"category": cat, "symbol": sym},
        )
        rows = data if isinstance(data, list) else []
        if not rows:
            raise RuntimeError(f"No ticker for {sym}")
        row = rows[0] if isinstance(rows[0], dict) else {}
        last = _num(row.get("lastPrice") or row.get("lastPr"))
        mark = _num(row.get("markPrice") or row.get("indexPrice") or last)
        payload = {
            "ok": True,
            "mode": DESK_MODE,
            "ts": _utcnow(),
            "symbol": sym,
            "category": cat,
            "last": last,
            "mark": mark,
            "bid": _num(row.get("bid1Price") or row.get("bidPr")),
            "ask": _num(row.get("ask1Price") or row.get("askPr")),
            "high24h": _num(row.get("highPrice24h")),
            "low24h": _num(row.get("lowPrice24h")),
            "open24h": _num(row.get("openPrice24h")),
            "change24h": None,
            "base_volume": _num(row.get("baseVolume") or row.get("volume24h")),
            "quote_volume": _num(row.get("quoteVolume") or row.get("turnover24h")),
            "stale": False,
        }
        if payload["open24h"] and payload["last"] is not None and abs(payload["open24h"]) > 1e-12:
            payload["change24h"] = ((payload["last"] - payload["open24h"]) / payload["open24h"]) * 100.0
        with _lock:
            _ticker_cache[cache_key] = {
                "expires": time.monotonic() + TICKER_TTL_SECONDS,
                "payload": payload,
            }
            if len(_ticker_cache) > 64:
                # Drop oldest-ish entries
                for k in list(_ticker_cache.keys())[:16]:
                    _ticker_cache.pop(k, None)
        return payload
    except Exception as exc:  # noqa: BLE001
        with _lock:
            hit = _ticker_cache.get(cache_key)
            if hit:
                stale = dict(hit["payload"])
                stale["stale"] = True
                stale["error"] = str(exc)[:200]
                stale["ts"] = _utcnow()
                return stale
        return {
            "ok": False,
            "mode": DESK_MODE,
            "ts": _utcnow(),
            "symbol": sym,
            "category": cat,
            "error": str(exc)[:200],
        }


def candles_payload(
    symbol: str,
    category: str | None = None,
    granularity: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    sym = _normalize_symbol(symbol)
    cat = _normalize_category(category)
    gran = _normalize_granularity(granularity)
    lim = int(limit or 200)
    if lim < 1 or lim > 1000:
        raise ValueError("limit must be 1..1000")
    cache_key = f"{cat}:{sym}:{gran}:{lim}"
    now = time.monotonic()
    with _lock:
        hit = _candles_cache.get(cache_key)
        if hit and now < hit["expires"]:
            return dict(hit["payload"])

    try:
        data = _public_get(
            "/api/v3/market/candles",
            {
                "category": cat,
                "symbol": sym,
                "interval": gran,
                "limit": lim,
            },
        )
        rows = data if isinstance(data, list) else []
        candles: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 5:
                continue
            ts = _num(row[0])
            o, h, l, c = _num(row[1]), _num(row[2]), _num(row[3]), _num(row[4])
            vol = _num(row[5]) if len(row) > 5 else None
            if ts is None or None in (o, h, l, c):
                continue
            candles.append(
                {
                    "t": int(ts),
                    "o": o,
                    "h": h,
                    "l": l,
                    "c": c,
                    "v": vol,
                }
            )
        # Bitget returns oldest-first; keep that order for charts.
        payload = {
            "ok": True,
            "mode": DESK_MODE,
            "ts": _utcnow(),
            "symbol": sym,
            "category": cat,
            "granularity": gran,
            "limit": lim,
            "count": len(candles),
            "candles": candles,
            "stale": False,
        }
        with _lock:
            _candles_cache[cache_key] = {
                "expires": time.monotonic() + CANDLES_TTL_SECONDS,
                "payload": payload,
            }
            if len(_candles_cache) > 48:
                for k in list(_candles_cache.keys())[:12]:
                    _candles_cache.pop(k, None)
        return payload
    except Exception as exc:  # noqa: BLE001
        with _lock:
            hit = _candles_cache.get(cache_key)
            if hit:
                stale = dict(hit["payload"])
                stale["stale"] = True
                stale["error"] = str(exc)[:200]
                stale["ts"] = _utcnow()
                return stale
        return {
            "ok": False,
            "mode": DESK_MODE,
            "ts": _utcnow(),
            "symbol": sym,
            "category": cat,
            "granularity": gran,
            "error": str(exc)[:200],
            "candles": [],
            "count": 0,
        }


def trade_preview(body: dict[str, Any] | None) -> dict[str, Any]:
    """Validate a trade ticket and estimate fill sizing. Never places an order."""
    if not isinstance(body, dict):
        raise ValueError("JSON body required")
    sym = _normalize_symbol(str(body.get("symbol") or ""))
    cat = _normalize_category(str(body.get("category") or "USDT-FUTURES"))
    side_raw = str(body.get("side") or "").strip().lower()
    if side_raw in {"long", "buy", "open_long"}:
        side = "long"
        order_side = "buy"
    elif side_raw in {"short", "sell", "open_short"}:
        side = "short"
        order_side = "sell"
    else:
        raise ValueError("side must be long or short")
    order_type = str(body.get("order_type") or body.get("type") or "market").strip().lower()
    if order_type not in {"market", "limit"}:
        raise ValueError("order_type must be market or limit")
    leverage = _num(body.get("leverage")) or 1.0
    if cat == "SPOT":
        raise ValueError("Futures only")
    if leverage < 1 or leverage > 150:
        raise ValueError("leverage out of range (1–150×). Below 10× is safe.")
    size_coins = _num(body.get("size") or body.get("qty") or body.get("size_coins"))
    notional = _num(body.get("notional") or body.get("usdt") or body.get("size_usdt"))
    limit_price = _num(body.get("price") or body.get("limit_price"))
    if order_type == "limit" and (limit_price is None or limit_price <= 0):
        raise ValueError("limit orders require price")
    tp = _num(body.get("tp") or body.get("take_profit"))
    sl = _num(body.get("sl") or body.get("stop_loss"))
    margin_mode = str(body.get("margin_mode") or "crossed").strip().lower() or "crossed"

    ticker = ticker_payload(sym, cat)
    mark = _num(ticker.get("mark")) or _num(ticker.get("last"))
    if mark is None or mark <= 0:
        raise RuntimeError("Unable to fetch mark price for preview")
    ref = limit_price if order_type == "limit" and limit_price else mark

    if size_coins is None and notional is not None:
        size_coins = abs(notional) / ref
    if size_coins is None or size_coins <= 0:
        raise ValueError("Provide size (coins) or notional (USDT)")
    if notional is None:
        notional = abs(size_coins * ref)

    margin_est = abs(notional) / max(leverage, 1e-9)
    # Rough isolated-style liq estimate (crossed is account-level; shown as hint only)
    maint = 0.005
    if side == "long":
        liq_est = ref * (1 - (1 / leverage) + maint)
    else:
        liq_est = ref * (1 + (1 / leverage) - maint)

    return {
        "ok": True,
        "mode": DESK_MODE,
        "ts": _utcnow(),
        "simulated": True,
        "live_trading": is_live_unlocked(),
        "preview": {
            "symbol": sym,
            "category": cat,
            "side": side,
            "order_side": order_side,
            "order_type": order_type,
            "size": round(size_coins, 8),
            "notional": round(abs(notional), 4),
            "leverage": leverage,
            "margin_mode": margin_mode,
            "margin_estimate": round(margin_est, 4),
            "ref_price": ref,
            "mark": mark,
            "limit_price": limit_price,
            "liq_estimate": round(liq_est, 6) if liq_est else None,
            "tp": tp,
            "sl": sl,
            "note": "Dry-run only. No Bitget order was sent.",
        },
    }


def trade_place(body: dict[str, Any] | None) -> tuple[int, dict[str, Any]]:
    """Refuse live placement while locked. Never calls Bitget place/close."""
    lock = live_unlock_status()
    if not lock.get("unlocked"):
        return 403, {
            "ok": False,
            "mode": DESK_MODE,
            "ts": _utcnow(),
            "error": "LIVE locked — needs Kane LIVE OK (BITBOT_LIVE_OK=1 or data/LIVE_OK). STOP ALL TRADING.",
            "live_trading": False,
            "live_lock": lock.get("message"),
            "code": "LIVE_LOCKED",
        }
    # Unlocked path still not wired — refuse rather than place accidentally.
    return 501, {
        "ok": False,
        "mode": DESK_MODE,
        "ts": _utcnow(),
        "error": "LIVE unlock present but place/close is not wired on this desk build. No order sent.",
        "live_trading": True,
        "code": "NOT_IMPLEMENTED",
    }


def warm_cache() -> None:
    """Background warm so the first browser hit is not a cold Bitget round-trip."""
    try:
        get_snapshot(force=True)
    except Exception:
        pass
