"""In-app Bitbot AI scalper.

Paper-simulated high-leverage scalps plus live UTA take-profit *signals*.
Never places or closes Bitget orders. LIVE lock is irrelevant here because
this module cannot call trade_place / close_position.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

BOT_VERSION = "bot-1.2.0"
MARKET = "USDT-FUTURES"
SYMBOLS = ("SOLUSDT", "HYPEUSDT", "BTCUSDT", "ETHUSDT")
TAKER_BPS = 6.0
ROUND_TRIP_BPS = TAKER_BPS * 2
STARTING_EQUITY = 100.0
MAX_EVENTS = 80
MAX_CLOSED = 80
TICK_MIN_SECONDS = 0.45
LOOP_SECONDS = 1.0
MAX_LEVERAGE = 150
SAFE_LEVERAGE_MAX = 9
MIN_RISK_LEVERAGE = 10
PROFILE_ALIASES = {"balanced": "risk"}

PROFILES: dict[str, dict[str, float | int | bool]] = {
    "safe": {
        "safe": True,
        "leverage_min": 5,
        "leverage_max": 9,
        "margin_pct": 0.05,
        "tp_bps": 40,
        "sl_bps": 28,
        "be_bps": 20,
        "giveback": 0.40,
        "max_hold": 180,
        "impulse_bps": 14,
        "overextend_bps": 48,
        "cooldown": 20,
        "max_consec_loss": 4,
        "volume_ratio": 1.10,
        "min_score": 0.55,
    },
    "risk": {
        "safe": False,
        "leverage_min": 10,
        "leverage_max": 75,
        "margin_pct": 0.03,
        "tp_bps": 28,
        "sl_bps": 16,
        "be_bps": 16,
        "giveback": 0.35,
        "max_hold": 90,
        "impulse_bps": 12,
        "overextend_bps": 40,
        "cooldown": 14,
        "max_consec_loss": 4,
        "volume_ratio": 1.10,
        "min_score": 0.55,
    },
    "aggressive": {
        "safe": False,
        "leverage_min": 50,
        "leverage_max": 150,
        "margin_pct": 0.02,
        "tp_bps": 24,
        "sl_bps": 12,
        "be_bps": 16,
        "giveback": 0.30,
        "max_hold": 55,
        "impulse_bps": 12,
        "overextend_bps": 36,
        "cooldown": 10,
        "max_consec_loss": 4,
        "volume_ratio": 1.08,
        "min_score": 0.60,
    },
}

_lock = threading.RLock()
_state: dict[str, Any] = {}
_persist_path: Path | None = None
_loop_started = threading.Event()
_ticker_fn: Callable[[str], dict[str, Any]] | None = None
_candles_fn: Callable[..., list[dict[str, Any]]] | None = None
_positions_fn: Callable[[], list[dict[str, Any]]] | None = None


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


def _profile_name(name: str | None) -> str:
    raw = (name or "aggressive").strip().lower()
    raw = PROFILE_ALIASES.get(raw, raw)
    return raw if raw in PROFILES else "aggressive"


def _cfg(state: dict[str, Any] | None = None) -> dict[str, float | int | bool]:
    return PROFILES[_profile_name((state or _state).get("profile"))]


def _leverage_for(score: float) -> int:
    """Safe stays below 10×. Risk/aggressive never go below 10×, never above 150×."""
    cfg = _cfg()
    lo = int(cfg["leverage_min"])
    hi = int(cfg["leverage_max"])
    floor = float(cfg.get("min_score") or 0.55)
    span = max(1e-9, 1.0 - floor)
    t = min(1.0, max(0.0, (float(score) - floor) / span))
    lev = int(round(lo + (hi - lo) * t))
    if cfg.get("safe"):
        return max(1, min(SAFE_LEVERAGE_MAX, lev))
    return max(MIN_RISK_LEVERAGE, min(MAX_LEVERAGE, lev))


def _empty_state() -> dict[str, Any]:
    return {
        "version": BOT_VERSION,
        "running": True,
        "halt": None,
        "profile": "aggressive",
        "paper_equity": STARTING_EQUITY,
        "initial_equity": STARTING_EQUITY,
        "open": None,
        "closed": [],
        "events": [],
        "live_signals": [],
        "live_watch": {},
        "scan": [],
        "started_at": _utcnow(),
        "last_tick": None,
        "consecutive_losses": 0,
        "cooldown_until": 0.0,
        "entries": 0,
        "wins": 0,
        "losses": 0,
        "_last_tick_at": 0.0,
    }


def configure(path: str | Path | None = None) -> None:
    """Set persist file and load prior paper book if present."""
    global _persist_path
    with _lock:
        _persist_path = Path(path) if path else None
        _load_locked()


def reset_for_tests() -> None:
    """Wipe in-memory book. Used by unit tests only."""
    global _persist_path
    with _lock:
        _persist_path = None
        _state.clear()
        _state.update(_empty_state())
        _state["running"] = False


def _load_locked() -> None:
    fresh = _empty_state()
    if _persist_path and _persist_path.is_file():
        try:
            raw = json.loads(_persist_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for key in (
                    "running",
                    "halt",
                    "profile",
                    "paper_equity",
                    "initial_equity",
                    "open",
                    "closed",
                    "events",
                    "started_at",
                    "consecutive_losses",
                    "cooldown_until",
                    "entries",
                    "wins",
                    "losses",
                    "live_watch",
                ):
                    if key in raw:
                        fresh[key] = raw[key]
                fresh["profile"] = _profile_name(fresh.get("profile"))
                if not isinstance(fresh.get("closed"), list):
                    fresh["closed"] = []
                if not isinstance(fresh.get("events"), list):
                    fresh["events"] = []
                if not isinstance(fresh.get("live_watch"), dict):
                    fresh["live_watch"] = {}
        except (OSError, ValueError, TypeError):
            pass
    _state.clear()
    _state.update(fresh)


def _persist_locked() -> None:
    if not _persist_path:
        return
    try:
        _persist_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {k: v for k, v in _state.items() if not str(k).startswith("_")}
        tmp = _persist_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")
        tmp.replace(_persist_path)
    except OSError:
        pass


def _event(kind: str, detail: str, extra: dict[str, Any] | None = None) -> None:
    row = {"t": _utcnow(), "kind": kind, "detail": detail}
    if extra:
        row.update(extra)
    events = _state.setdefault("events", [])
    events.append(row)
    if len(events) > MAX_EVENTS:
        del events[: len(events) - MAX_EVENTS]


def _live_desk():
    from . import live_desk

    return live_desk


def _ticker(symbol: str) -> dict[str, Any]:
    if _ticker_fn is not None:
        return _ticker_fn(symbol)
    return _live_desk().ticker_payload(symbol, MARKET)


def _candles(symbol: str, granularity: str = "1m", limit: int = 12) -> list[dict[str, Any]]:
    if _candles_fn is not None:
        try:
            return _candles_fn(symbol, granularity, limit)
        except TypeError:
            return _candles_fn(symbol)
    payload = _live_desk().candles_payload(symbol, MARKET, granularity, limit)
    return list(payload.get("candles") or [])


def _live_positions() -> list[dict[str, Any]]:
    if _positions_fn is not None:
        return list(_positions_fn())
    snap = _live_desk().get_snapshot()
    live = snap.get("live") if isinstance(snap, dict) else None
    if not isinstance(live, dict):
        return []
    return [p for p in (live.get("positions") or []) if isinstance(p, dict)]


def _mark_price(symbol: str) -> float | None:
    tick = _ticker(symbol)
    mark = _num(tick.get("mark")) or _num(tick.get("last"))
    return mark if mark and mark > 0 else None


def _pnl(side: str, entry: float, mark: float, size: float) -> float:
    sign = 1.0 if side == "long" else -1.0
    return size * (mark - entry) * sign


def _net_after_fees(side: str, entry: float, exit_px: float, size: float) -> float:
    return _pnl(side, entry, exit_px, size) - abs(entry * size) * ROUND_TRIP_BPS / 10000.0


def _mark_open_locked(now: float) -> None:
    pos = _state.get("open")
    if not isinstance(pos, dict):
        return
    mark = _num(pos.get("mark"))
    symbol = str(pos.get("symbol") or "")
    # Caller should have refreshed mark already; keep last if missing.
    if mark is None or mark <= 0:
        return
    entry = float(pos["entry"])
    size = float(pos["size"])
    side = str(pos["side"])
    upnl = _pnl(side, entry, mark, size)
    net = _net_after_fees(side, entry, mark, size)
    margin = float(pos["margin"])
    pos["mark"] = mark
    pos["upnl"] = round(upnl, 6)
    pos["net"] = round(net, 6)
    pos["pnl_pct"] = round((upnl / margin) * 100.0, 3) if margin else None
    pos["held_seconds"] = round(max(0.0, now - float(pos["opened_at"])), 2)
    peak = _num(pos.get("peak_upnl")) or upnl
    if upnl > peak:
        pos["peak_upnl"] = upnl
        pos["peak_mark"] = mark
    else:
        pos["peak_upnl"] = peak
    peak_net = _num(pos.get("peak_net"))
    if peak_net is None or net > peak_net:
        pos["peak_net"] = net


def _close_locked(now: float, mark: float, reason: str) -> dict[str, Any]:
    pos = _state["open"]
    assert isinstance(pos, dict)
    side = str(pos["side"])
    entry = float(pos["entry"])
    size = float(pos["size"])
    net = _net_after_fees(side, entry, mark, size)
    fill = {
        "id": pos.get("id"),
        "symbol": pos.get("symbol"),
        "side": side,
        "leverage": pos.get("leverage"),
        "entry": entry,
        "exit": mark,
        "size": size,
        "margin": pos.get("margin"),
        "notional": pos.get("notional"),
        "net_usdt": round(net, 6),
        "held_seconds": round(max(0.0, now - float(pos["opened_at"])), 2),
        "reason": reason,
        "simulated": True,
        "closed_at": _utcnow(),
    }
    _state["open"] = None
    _state["paper_equity"] = round(float(_state["paper_equity"]) + net, 6)
    closed = _state.setdefault("closed", [])
    closed.append(fill)
    if len(closed) > MAX_CLOSED:
        del closed[: len(closed) - MAX_CLOSED]
    if net > 0:
        _state["wins"] = int(_state.get("wins") or 0) + 1
        _state["consecutive_losses"] = 0
    elif net < 0:
        _state["losses"] = int(_state.get("losses") or 0) + 1
        _state["consecutive_losses"] = int(_state.get("consecutive_losses") or 0) + 1
    cfg = _cfg()
    _state["cooldown_until"] = now + float(cfg["cooldown"])
    if int(_state["consecutive_losses"]) >= int(cfg["max_consec_loss"]):
        _state["halt"] = (
            f"Paper halt: {cfg['max_consec_loss']} consecutive losses. "
            "Start again when ready."
        )
        _state["running"] = False
        _event("halt", _state["halt"])
    _event("close", reason, {"symbol": fill["symbol"], "net_usdt": fill["net_usdt"]})
    return fill


def _maybe_exit_locked(now: float, mark: float) -> dict[str, Any] | None:
    pos = _state.get("open")
    if not isinstance(pos, dict):
        return None
    side = str(pos["side"])
    entry = float(pos["entry"])
    sign = 1.0 if side == "long" else -1.0
    move_bps = ((mark - entry) / entry) * 10000.0 * sign
    net = _net_after_fees(side, entry, mark, float(pos["size"]))
    peak = _num(pos.get("peak_net"))
    if peak is None:
        peak = net
    held = now - float(pos["opened_at"])
    sl = float(pos["sl"])
    tp = float(pos["tp"])
    be_armed = bool(pos.get("be_armed"))

    if not be_armed and move_bps >= float(_cfg()["be_bps"]) and net > 0:
        pos["be_armed"] = True
        pos["sl"] = entry
        sl = entry
        _event("trail", f"{pos['symbol']} stop pulled to break-even")

    hit_sl = (mark - sl) * sign <= 0
    hit_tp = (mark - tp) * sign >= 0
    giveback = peak > 0 and net > 0 and (peak - net) >= peak * float(_cfg()["giveback"])
    max_hold = held >= float(pos.get("max_hold") or _cfg()["max_hold"])
    reverse = str(pos.get("reverse_reason") or "")

    if hit_tp:
        return _close_locked(now, mark, "Take-profit hit — banked before fade")
    if be_armed and hit_sl:
        return _close_locked(now, mark, "Break-even trail — protected the green")
    if peak > 0 and net <= 0:
        return _close_locked(now, mark, "Gave back the green — flattened before a loss")
    if giveback:
        return _close_locked(now, mark, "Peak fading — took profit before a loss")
    if reverse and held >= 8:
        if net > 0:
            return _close_locked(now, mark, reverse)
        return _close_locked(now, mark, reverse)
    if hit_sl:
        return _close_locked(now, mark, "Tight stop — cut before the loss grew")
    if max_hold and net > 0:
        return _close_locked(now, mark, "Max hold — banked remaining profit")
    if max_hold:
        return _close_locked(now, mark, "Max hold — flattened to avoid a larger loss")
    return None


def _trend_5m(rows: list[dict[str, Any]]) -> tuple[str | None, float]:
    if len(rows) < 3:
        return None, 0.0
    first = _num(rows[0].get("c"))
    last = _num(rows[-1].get("c"))
    if not first or not last:
        return None, 0.0
    move = ((last - first) / first) * 10000.0
    if abs(move) < 1:
        return "flat", move
    return ("up" if move > 0 else "down"), move


def _analyze_symbol(symbol: str) -> dict[str, Any]:
    """Score a USDT-M futures market for a paper entry."""
    cfg = _cfg()
    result: dict[str, Any] = {
        "symbol": symbol,
        "category": MARKET,
        "verdict": "SKIP",
        "side": None,
        "score": 0.0,
        "leverage": None,
        "move_bps": None,
        "trend_5m": None,
        "volume_ratio": None,
        "reason": "Insufficient candles",
    }
    rows1 = _candles(symbol, "1m", 12)
    if len(rows1) < 4:
        return result
    last_c = _num(rows1[-1].get("c"))
    prev_c = _num(rows1[-2].get("c"))
    older_c = _num(rows1[-3].get("c"))
    last_v = _num(rows1[-1].get("v")) or 0.0
    vols = [_num(row.get("v")) or 0.0 for row in rows1[:-1]]
    avg_v = sum(vols) / len(vols) if vols else 0.0
    if not last_c or not prev_c or not older_c:
        result["reason"] = "No 1m close"
        return result
    move_bps = ((last_c - prev_c) / prev_c) * 10000.0
    prior = ((prev_c - older_c) / older_c) * 10000.0
    vol_ratio = (last_v / avg_v) if avg_v else 0.0
    result["move_bps"] = round(move_bps, 2)
    result["volume_ratio"] = round(vol_ratio, 2)

    if abs(move_bps) < float(cfg["impulse_bps"]):
        result["reason"] = f"1m impulse {move_bps:+.1f}bps below {cfg['impulse_bps']}bps floor"
        return result
    if abs(move_bps) > float(cfg["overextend_bps"]):
        result["reason"] = f"1m {move_bps:+.1f}bps overextended — no chase"
        return result
    if prior * move_bps <= 0:
        result["reason"] = "1m bars disagree — wait for a clean impulse"
        return result
    if avg_v > 0 and vol_ratio < float(cfg["volume_ratio"]):
        result["reason"] = f"Volume {vol_ratio:.2f}x too thin"
        return result

    side = "long" if move_bps > 0 else "short"
    score = 0.35
    if vol_ratio >= float(cfg["volume_ratio"]):
        score += 0.20
    if vol_ratio >= float(cfg["volume_ratio"]) + 0.25:
        score += 0.05

    rows5 = _candles(symbol, "5m", 8)
    trend5, _move5 = _trend_5m(rows5)
    result["trend_5m"] = trend5
    want = "up" if side == "long" else "down"
    if trend5 == want:
        score += 0.25
    elif trend5 in {"up", "down"} and trend5 != want:
        result["score"] = round(score, 2)
        result["reason"] = f"5m {trend5} fights 1m {side} — skip"
        return result
    else:
        score += 0.05

    score += 0.10
    tick = _ticker(symbol)
    if _num(tick.get("mark")) or _num(tick.get("last")):
        score += 0.05
    result["score"] = round(min(1.0, score), 2)
    if result["score"] < float(cfg["min_score"]):
        result["reason"] = f"Score {result['score']} below {cfg['min_score']}"
        return result

    lev = _leverage_for(result["score"])
    result.update(
        {
            "verdict": "ENTRY",
            "side": side,
            "leverage": lev,
            "reason": (
                f"{MARKET} {side} · 1m {move_bps:+.1f}bps · "
                f"5m {trend5 or 'n/a'} · {lev}×"
            ),
        }
    )
    return result


def _analyze_markets() -> dict[str, Any] | None:
    scan = [_analyze_symbol(symbol) for symbol in SYMBOLS]
    with _lock:
        _state["scan"] = scan
    entries = [row for row in scan if row.get("verdict") == "ENTRY"]
    if not entries:
        return None
    entries.sort(key=lambda row: float(row.get("score") or 0), reverse=True)
    return entries[0]


def _reversal_reason(symbol: str, side: str) -> str | None:
    rows = _candles(symbol, "1m", 8)
    if len(rows) < 3:
        return None
    last_c = _num(rows[-1].get("c"))
    prev_c = _num(rows[-2].get("c"))
    if not last_c or not prev_c:
        return None
    move = ((last_c - prev_c) / prev_c) * 10000.0
    sign = 1.0 if side == "long" else -1.0
    against = -move * sign
    if against >= float(_cfg()["impulse_bps"]):
        return f"1m reversed {move:+.1f}bps — exit before it ran"
    return None


def _open_locked(now: float, idea: dict[str, Any], mark: float) -> dict[str, Any] | None:
    if _state.get("open"):
        return None
    if now < float(_state.get("cooldown_until") or 0):
        return None
    equity = float(_state.get("paper_equity") or 0)
    if equity < 5:
        _state["halt"] = "Paper book too small to keep scalping"
        _state["running"] = False
        _event("halt", _state["halt"])
        return None
    cfg = _cfg()
    scored = _num(idea.get("leverage"))
    lev = int(scored) if scored else _leverage_for(float(idea.get("score") or 1))
    if cfg.get("safe"):
        lev = max(1, min(SAFE_LEVERAGE_MAX, lev))
    else:
        lev = max(MIN_RISK_LEVERAGE, min(MAX_LEVERAGE, lev))
    margin = max(1.0, min(equity * float(cfg["margin_pct"]), equity * 0.08))
    notional = margin * lev
    size = notional / mark
    side = idea["side"]
    sign = 1.0 if side == "long" else -1.0
    tp = mark * (1 + sign * float(cfg["tp_bps"]) / 10000.0)
    sl = mark * (1 - sign * float(cfg["sl_bps"]) / 10000.0)
    pos = {
        "id": f"p-{int(now * 1000)}",
        "symbol": idea["symbol"],
        "category": MARKET,
        "side": side,
        "leverage": lev,
        "score": idea.get("score"),
        "entry": mark,
        "mark": mark,
        "size": round(size, 8),
        "notional": round(notional, 4),
        "margin": round(margin, 4),
        "tp": tp,
        "sl": sl,
        "be_armed": False,
        "upnl": 0.0,
        "net": -abs(notional) * ROUND_TRIP_BPS / 10000.0,
        "peak_net": -abs(notional) * ROUND_TRIP_BPS / 10000.0,
        "peak_upnl": 0.0,
        "peak_mark": mark,
        "opened_at": now,
        "max_hold": int(cfg["max_hold"]),
        "reason": idea["reason"],
        "simulated": True,
    }
    _state["open"] = pos
    _state["entries"] = int(_state.get("entries") or 0) + 1
    _event("entry", idea["reason"], {"symbol": idea["symbol"], "side": side, "leverage": lev})
    return pos


def _watch_live() -> list[dict[str, Any]]:
    positions = _live_positions()
    with _lock:
        watch = _state.setdefault("live_watch", {})
        if not isinstance(watch, dict):
            watch = {}
            _state["live_watch"] = watch
        signals: list[dict[str, Any]] = []
        seen: set[str] = set()
        for pos in positions:
            symbol = str(pos.get("symbol") or "")
            if not symbol:
                continue
            seen.add(symbol)
            upnl = _num(pos.get("unrealised_pnl")) or 0.0
            pnl_pct = _num(pos.get("pnl_pct"))
            row = watch.get(symbol) if isinstance(watch.get(symbol), dict) else {}
            peak = max(_num(row.get("peak_upnl")) or upnl, upnl)
            giveback = peak - upnl
            if upnl > 0.15 and giveback >= max(0.08, peak * 0.25):
                code, detail = "BANK_NOW", "Profit fading from peak — bank it now"
            elif upnl > 0.40 or (pnl_pct is not None and pnl_pct > 12):
                code, detail = "URGENT_TP", "Sizeable open profit — take it before it reverses"
            elif upnl > 0 and upnl >= peak - 1e-9:
                code, detail = "TRAIL", "New high — trail, ready to bank on the first fade"
            elif upnl < -0.15:
                code, detail = "PROTECT", "Underwater — flatten before the loss grows"
            elif upnl > 0:
                code, detail = "HOLD_GREEN", "In profit — watching for fade"
            else:
                code, detail = "WATCH", "Live book quiet"
            watch[symbol] = {
                "peak_upnl": peak,
                "last_upnl": upnl,
                "signal": code,
                "updated_at": _utcnow(),
            }
            signals.append(
                {
                    "symbol": symbol,
                    "side": pos.get("side"),
                    "leverage": pos.get("leverage"),
                    "upnl": upnl,
                    "pnl_pct": pnl_pct,
                    "peak_upnl": peak,
                    "mark": pos.get("mark"),
                    "entry": pos.get("entry"),
                    "signal": code,
                    "detail": detail,
                    "live": True,
                    "executable": False,
                    "note": "Signal only — Bitget close stays locked on this desk.",
                }
            )
        for stale in [key for key in watch if key not in seen]:
            watch.pop(stale, None)
        _state["live_signals"] = signals
        return list(signals)


def _metrics_locked() -> dict[str, Any]:
    closed = [row for row in _state.get("closed") or [] if isinstance(row, dict)]
    net = float(_state.get("paper_equity") or 0) - float(_state.get("initial_equity") or STARTING_EQUITY)
    wins = int(_state.get("wins") or 0)
    losses = int(_state.get("losses") or 0)
    decided = wins + losses
    return {
        "paper_equity": round(float(_state.get("paper_equity") or 0), 4),
        "initial_equity": round(float(_state.get("initial_equity") or STARTING_EQUITY), 4),
        "net_usdt": round(net, 4),
        "entries": int(_state.get("entries") or 0),
        "closed": len(closed),
        "wins": wins,
        "losses": losses,
        "win_rate": (wins / decided) if decided else None,
        "consecutive_losses": int(_state.get("consecutive_losses") or 0),
        "open_upnl": (_state["open"] or {}).get("upnl") if isinstance(_state.get("open"), dict) else 0,
    }


def status() -> dict[str, Any]:
    with _lock:
        if not _state:
            _state.update(_empty_state())
        events = list(_state.get("events") or [])
        closed = list(_state.get("closed") or [])
        return {
            "ok": True,
            "mode": "PAPER_SCALP",
            "version": BOT_VERSION,
            "ts": _utcnow(),
            "running": bool(_state.get("running")),
            "halt": _state.get("halt"),
            "profile": _profile_name(_state.get("profile")),
            "market": MARKET,
            "live_trading": False,
            "live_execution": False,
            "leverage_policy": {
                "safe_below": MIN_RISK_LEVERAGE,
                "max": MAX_LEVERAGE,
                "profile_min": int(_cfg()["leverage_min"]),
                "profile_max": int(_cfg()["leverage_max"]),
                "note": "Below 10× is safe. Risk/aggressive stay 10–150×. Futures only.",
            },
            "note": (
                "USDT-M futures paper scalper. Scans 1m/5m for entries and exits. "
                "Live UTA signals only — Bitget place/close stays locked."
            ),
            "metrics": _metrics_locked(),
            "open": dict(_state["open"]) if isinstance(_state.get("open"), dict) else None,
            "scan": list(_state.get("scan") or []),
            "live_signals": list(_state.get("live_signals") or []),
            "closed": closed[-12:],
            "events": events[-16:],
        }


def command(body: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("JSON body required")
    action = str(body.get("action") or "").strip().lower()
    if action not in {"start", "stop", "flatten", "profile"}:
        raise ValueError("action must be start, stop, flatten, or profile")
    with _lock:
        if not _state:
            _load_locked()
        if action == "profile" or body.get("profile"):
            _state["profile"] = _profile_name(str(body.get("profile") or _state.get("profile")))
        if action == "start":
            _state["running"] = True
            _state["halt"] = None
            _state["consecutive_losses"] = 0
            _event("start", f"Paper scalper on · {_state['profile']}")
        elif action == "stop":
            _state["running"] = False
            _event("stop", "Paper scalper paused — open paper left marked")
        elif action == "flatten":
            pos = _state.get("open")
            if isinstance(pos, dict):
                mark = _num(pos.get("mark")) or _num(pos.get("entry"))
                if mark:
                    _close_locked(time.time(), mark, "Manual flatten")
            _state["running"] = False
            _event("flatten", "Paper book flattened")
        _persist_locked()
        return status()


def tick(now: float | None = None) -> dict[str, Any]:
    """One scalper cycle: live signals, mark paper, bank/cut, maybe enter."""
    now = time.time() if now is None else now
    with _lock:
        if not _state:
            _load_locked()
        last = float(_state.get("_last_tick_at") or 0)
        if now - last < TICK_MIN_SECONDS:
            return status()
        _state["_last_tick_at"] = now
        _state["last_tick"] = _utcnow()

    try:
        _watch_live()
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _event("warn", f"Live watch skipped: {str(exc)[:160]}")

    open_symbol = None
    with _lock:
        if isinstance(_state.get("open"), dict):
            open_symbol = str(_state["open"].get("symbol") or "")

    mark = None
    if open_symbol:
        try:
            mark = _mark_price(open_symbol)
        except Exception:
            mark = None

    reverse = None
    if open_symbol:
        try:
            side = None
            with _lock:
                if isinstance(_state.get("open"), dict):
                    side = str(_state["open"].get("side") or "")
            if side:
                reverse = _reversal_reason(open_symbol, side)
        except Exception:
            reverse = None

    with _lock:
        if isinstance(_state.get("open"), dict) and mark:
            _state["open"]["mark"] = mark
            if reverse:
                _state["open"]["reverse_reason"] = reverse
            _mark_open_locked(now)
            _maybe_exit_locked(now, mark)
        running = bool(_state.get("running")) and not _state.get("halt")
        already_open = isinstance(_state.get("open"), dict)
        cooldown = now < float(_state.get("cooldown_until") or 0)

    idea = None
    if running:
        try:
            idea = _analyze_markets()
        except Exception as exc:  # noqa: BLE001
            with _lock:
                _event("warn", f"Scan skipped: {str(exc)[:160]}")
            idea = None
    if idea and not already_open and not cooldown:
            try:
                entry_mark = _mark_price(str(idea["symbol"]))
            except Exception:
                entry_mark = None
            if entry_mark:
                with _lock:
                    _open_locked(now, idea, entry_mark)
                    _mark_open_locked(now)

    with _lock:
        _persist_locked()
        return status()


def start_loop() -> None:
    """Background 1s tick. Idempotent. Daemon — dies with the dashboard."""
    if _loop_started.is_set():
        return

    def _run() -> None:
        while True:
            try:
                tick()
            except Exception:
                pass
            time.sleep(LOOP_SECONDS)

    thread = threading.Thread(target=_run, name="bitbot-ai", daemon=True)
    thread.start()
    _loop_started.set()


def set_market_hooks(
    ticker: Callable[[str], dict[str, Any]] | None = None,
    candles: Callable[[str], list[dict[str, Any]]] | None = None,
    positions: Callable[[], list[dict[str, Any]]] | None = None,
) -> None:
    """Inject market sources for tests. Pass None to restore live_desk."""
    global _ticker_fn, _candles_fn, _positions_fn
    _ticker_fn = ticker
    _candles_fn = candles
    _positions_fn = positions
