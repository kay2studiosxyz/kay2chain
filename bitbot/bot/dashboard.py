"""Bitbot trading desk: live UTA watch + market data + dry-run trade ticket.

Live UTA equity/positions via bot.live_desk (perps-bot .env + GET only).
Trade place stays locked unless BITBOT_LIVE_OK is unlocked; place never
calls Bitget while locked. Paper observatory APIs remain but are not primary UI.
"""
import calendar as month_calendar
from collections import defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import islice
import json
import math
from pathlib import Path
import re
import threading
import time
from urllib.parse import parse_qs, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")
SYMBOL = re.compile(r"[A-Z0-9]{2,32}\Z")
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_LOG_BYTES = 2 * 1024 * 1024
REPORT_FRESH_SECONDS = 150
ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
          "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/styles.css": ("styles.css", "text/css; charset=utf-8"),
          "/calendar.css": ("calendar.css", "text/css; charset=utf-8"),
          "/premium.css": ("premium.css", "text/css; charset=utf-8"),
          "/bitbot-art.jpg": ("bitbot-art.jpg", "image/jpeg"),
          "/experience.js": ("experience.js", "text/javascript; charset=utf-8"),
          "/live.js": ("live.js", "text/javascript; charset=utf-8"),
          "/lightweight-charts.js": ("lightweight-charts.js", "text/javascript; charset=utf-8"),
          "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
          "/icon-192.png": ("icon-192.png", "image/png"),
          "/icon-512.png": ("icon-512.png", "image/png"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/service-worker.js": ("service-worker.js", "text/javascript; charset=utf-8"),
          "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
          "/favicon.svg": ("favicon.svg", "image/svg+xml")}
RISK_KEYS = ("budget_gbp", "min_leverage", "leverage", "alt_leverage_cap",
             "new_listing_leverage_cap", "risk_per_trade_pct", "daily_loss_pct",
             "lifetime_loss_pct", "max_trades_per_day", "max_consecutive_losses",
             "max_margin_pct", "min_net_profit_gbp", "max_hold_seconds", "reward_risk",
             "max_spread_bps", "min_depth_usdt", "cooldown_seconds", "require_news",
             "scalp_max_trades_per_day", "scalp_risk_per_trade_pct", "scalp_daily_loss_pct",
             "scalp_review_seconds", "scalp_reward_risk", "scalp_candidate_seconds")


class DashboardError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def obj(value):
    return value if isinstance(value, dict) else {}


def array(value):
    return value if isinstance(value, list) else []


def number(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def text(value, limit=700):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value)
    value = re.sub(r"(?i)(bearer\s+|(?:api[_-]?key|token|secret|password|passphrase)\s*[:=]\s*)\S+", "[redacted]", value)
    value = re.sub(r"(?<![\w:])/(?:home|tmp|etc|root|var|Users)/[^\s,;]+", "[local path]", value)
    return value[:limit]


def symbol(value):
    return value if isinstance(value, str) and SYMBOL.fullmatch(value) else ""


def stamp(value):
    result = number(value)
    if result is None and isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                return None
            result = dt.timestamp()
        except (ValueError, OverflowError):
            return None
    if result is None or result <= 0 or result > 32503680000:
        return None
    return result


def utc(value):
    value = stamp(value)
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def age(now, value):
    value = stamp(value)
    return round(max(0, now - value), 1) if value is not None and value <= now + 5 else None


def safe_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            return None
        if any(ord(char) < 33 for char in value):
            return None
        # Source links need no query credentials or fragments.
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except ValueError:
        return None


def sources(values):
    return list(dict.fromkeys(url for value in array(values)[:12] if (url := safe_url(value))))


class DashboardStore:
    def __init__(self, data_dir, assets_dir, clock=time.time):
        self.data_dir = Path(data_dir).resolve()
        self.assets_dir = Path(assets_dir).resolve()
        self.clock = clock

    @staticmethod
    def _inside(root, path):
        try:
            resolved = path.resolve()
            resolved.relative_to(root)
        except (ValueError, OSError, RuntimeError):
            raise DashboardError(404, "Resource not found") from None
        return resolved

    def _session_dir(self, session_id):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            raise DashboardError(404, "Paper session not found")
        directory = self._inside(self.data_dir, self.data_dir / session_id)
        if not directory.is_dir():
            raise DashboardError(404, "Paper session not found")
        return directory

    def _json(self, directory, name, optional=False):
        path = self._inside(self.data_dir, directory / name)
        try:
            with path.open("rb") as handle:
                content = handle.read(MAX_JSON_BYTES + 1)
            if len(content) > MAX_JSON_BYTES:
                raise ValueError("oversize")
            return json.loads(content, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite")))
        except FileNotFoundError:
            if optional:
                return None
            raise DashboardError(503, "Paper session data is unavailable") from None
        except (OSError, ValueError, UnicodeError):
            raise DashboardError(503, "Paper session data is unavailable or invalid") from None

    def _log(self, directory, name):
        path = self._inside(self.data_dir, directory / name)
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                length = handle.tell()
                handle.seek(max(0, length - MAX_LOG_BYTES))
                content = handle.read(MAX_LOG_BYTES)
            lines = content.splitlines()
            if length > MAX_LOG_BYTES:
                lines = lines[1:]
            rows = []
            for line in lines[-4000:]:
                try:
                    row = json.loads(line)
                    if isinstance(row, dict):
                        rows.append(row)
                except (ValueError, UnicodeError):
                    # Writers append one JSON line. An unfinished last line is normal.
                    continue
            return rows, "available"
        except FileNotFoundError:
            return [], "not_available"
        except OSError:
            return [], "unavailable"

    def _session(self, session_id, now, report=None):
        directory = self._session_dir(session_id)
        session = self._json(directory, "session.json")
        if not isinstance(session, dict) or session.get("mode") != "PAPER_ONLY":
            raise DashboardError(404, "Paper session not found")
        persistent = session.get("persistent") is True
        start, end = stamp(session.get("started_at")), stamp(session.get("scheduled_end_at"))
        if start is None or "smoke" in session_id.lower():
            raise DashboardError(404, "Paper session not found")
        if not persistent and (end is None or end - start < 3600):
            raise DashboardError(404, "Paper session not found")
        if report is None:
            report = self._json(directory, "review.json", optional=True)
        if report is not None and not isinstance(report, dict):
            raise DashboardError(503, "Paper report is invalid")
        report = obj(report)
        updated = stamp(report.get("updated_at"))
        if report and (updated is None or report.get("status") not in
                       ("STARTING", "RUNNING", "COMPLETED", "STOPPED_EARLY", "FAILED")):
            raise DashboardError(503, "Paper report metadata is invalid")
        report_age = age(now, updated)
        live_publication = obj(report.get('last_health')).get('publication_interval_seconds') == 1
        stale = report_age is None or report_age > (8 if live_publication else REPORT_FRESH_SECONDS)
        recorded_status = report.get("status", "STARTING")
        if recorded_status not in ("STARTING", "RUNNING", "COMPLETED", "STOPPED_EARLY", "FAILED"):
            recorded_status = "UNKNOWN"
        status = recorded_status
        if status in ("STARTING", "RUNNING"):
            if not persistent and end is not None and now > end + 90:
                status = "AWAITING_FINAL_REPORT"
            elif stale:
                status = "STALE"
        elapsed = max(0, now - start)
        if persistent:
            session_kind = "Persistent paper"
            duration_hours = elapsed / 3600
            progress_pct = 100.0 if status in ("STARTING", "RUNNING") and not stale else 0
            remaining_seconds = None
        else:
            session_kind='Extended paper' if session.get('schedule_changes') else f'{(end-start)/3600:.1f}h paper'
            duration_hours = (end - start) / 3600
            progress_pct = round(min(100, max(0, (now - start) / (end - start) * 100)), 2)
            remaining_seconds = max(0, round(end - now))
        label = f"{datetime.fromtimestamp(start, ZoneInfo('Europe/London')):%d %b · %H:%M} · {session_kind}"
        info = dict(id=session_id, label=label, status=status, recorded_status=recorded_status,
                    started_at=utc(start), scheduled_end_at=utc(end), updated_at=utc(updated),
                    age_seconds=report_age, stale=stale, duration_hours=duration_hours,
                    progress_pct=progress_pct, remaining_seconds=remaining_seconds,
                    elapsed_seconds=max(0, round(elapsed)), persistent=persistent, simulated=True)
        return directory, session, report, info

    def sessions(self):
        now = self.clock()
        found = []
        try:
            candidates = list(islice(self.data_dir.iterdir(), 2000))
        except OSError:
            raise DashboardError(503, "Paper sessions are unavailable") from None
        for candidate in candidates:
            if not SESSION_ID.fullmatch(candidate.name):
                continue
            try:
                _, _, _, info = self._session(candidate.name, now)
                found.append(info)
            except DashboardError as exc:
                if exc.status != 503:
                    continue
                try:
                    # Keep a damaged report visible instead of silently selecting
                    # an older, apparently healthy experiment.
                    _, _, _, info = self._session(candidate.name, now, report={})
                    info["status"] = "UNAVAILABLE"
                    found.append(info)
                except DashboardError:
                    continue
        found.sort(key=lambda item: item["started_at"], reverse=True)
        found = found[:40]
        return {"sessions": found, "default_session": found[0]["id"] if found else None}

    def dashboard(self, session_id=None, include_calendar=True):
        now = self.clock()
        if not session_id:
            session_id = self.sessions()["default_session"]
            if not session_id:
                raise DashboardError(404, "No paper sessions are available")
        directory, session, report, info = self._session(session_id, now)
        config = obj(session.get("config"))
        health = obj(report.get("last_health"))
        report_time = stamp(report.get("updated_at"))
        events, events_status = self._log(directory, "events.jsonl")
        brain_events, brain_events_status = self._log(directory, "brain/brain-events.jsonl")
        # Keep the metrics, position and chart on one saved report boundary.
        events = [row for row in events if (stamp(row.get("time")) or math.inf) <= (report_time or 0)]
        metrics, trades = self._validated_trades(report, report_time)
        trades.sort(key=lambda row: row["at"] or "")
        equity = []
        if metrics["initial_usdt"] is not None:
            net = 0
            equity.append(dict(at=info["started_at"], value_usdt=metrics["initial_usdt"], net_usdt=0))
            for row in trades:
                net += row["net_usdt"]
                equity.append(dict(at=row["at"], value_usdt=metrics["initial_usdt"]+net, net_usdt=net))
            if info["updated_at"]:
                equity.append(dict(at=info["updated_at"], value_usdt=metrics["initial_usdt"]+net, net_usdt=net))
        statuses = self._health(health, session, info, now)
        decisions = self._decisions(brain_events, statuses["brain"], info, now)
        # The source snapshot starts the verdict's lifetime, not the later GPT
        # response. Saved status flags must not extend an expired decision.
        if statuses["brain"]["status"] == "fresh" and not any(row["fresh"] for row in decisions):
            statuses["brain"]["status"] = "stale"
        if any(row["fresh"] for row in decisions) and statuses["brain"]["enabled"]:
            statuses["brain"]["status"] = "fresh"
            statuses["brain"]["error"] = ""
        latest_review_event = next((row for row in reversed(brain_events)
                                   if row.get("kind") in ("review", "review_error")), {})
        if latest_review_event.get("kind") == "review_error" and statuses["brain"]["enabled"]:
            statuses["brain"]["status"] = "unavailable"
            statuses["brain"]["error"] = "Model review unavailable (" + text(latest_review_event.get("error_type"), 60) + ")"
        if decisions:
            statuses["brain"]["decision_observed_at"] = decisions[0]["observed_at"]
            statuses["brain"]["decision_age_seconds"] = decisions[0]["age_seconds"]
        budget_status = "available"
        try:
            budget = self._json(directory, "brain/brain-budget.json", optional=True)
            if budget is None:
                budget, budget_status = {}, "not_available"
            elif (not isinstance(budget, dict) or number(budget.get("calls")) is None or
                  number(budget.get("max_calls")) is None):
                raise DashboardError(503, "Invalid budget data")
            if budget:
                statuses["brain"]["calls"] = number(budget.get("calls"))
                statuses["brain"]["max_calls"] = number(budget.get("max_calls"))
        except DashboardError:
            budget_status = "unavailable"
        lessons_status = "available"
        try:
            raw_lessons = self._json(directory, "brain/brain-lessons.json", optional=True)
            if raw_lessons is None:
                raw_lessons, lessons_status = [], "not_available"
            elif not isinstance(raw_lessons, list):
                raise DashboardError(503, "Invalid lesson data")
        except DashboardError:
            raw_lessons, lessons_status = [], "unavailable"
        lessons = [dict(text=text(row.get("text"), 1000), status="hypothesis", at=utc(row.get("observed_at")),
                        trade_ids=[text(item, 80) for item in array(row.get("trade_ids"))[:20]])
                   for row in raw_lessons[-20:] if isinstance(row, dict) and text(row.get("text"))]
        risk = {key: (config[key] if isinstance(config[key], bool) else number(config[key]))
                for key in RISK_KEYS if key in config}
        result = dict(generated_at=utc(now), mode="PAPER_ONLY", simulation=True, session=info,
                      metrics=metrics, equity=equity, equity_basis="Realized simulated equity; open positions excluded",
                      markets=self._markets(health, events, info, now), position=self._position(report),
                      health=statuses, decisions=decisions, trades=trades,
                      performance_evidence=self._performance_evidence(report),
                      activity=self._activity(events, brain_events, report_time), lessons=lessons,
                      risk_limits=risk,
                      skipped_setups=[dict(reason=text(reason), count=number(count)) for reason, count in
                                      sorted(obj(report.get("skipped_setups")).items(), key=lambda item: number(item[1]) or 0, reverse=True)[:10]],
                      conclusion=text(report.get("conclusion"), 1200), halt=text(report.get("halt")),
                      limitations=[text(item) for item in array(report.get("limitations"))[:8]],
                      source_status=dict(report="available" if report else "not_available", events=events_status,
                                         brain_events=brain_events_status, lessons=lessons_status, brain_budget=budget_status))
        if include_calendar:
            result["calendar"] = self._calendar(now)
        return result

    @staticmethod
    def _performance_evidence(report):
        raw = obj(report.get("performance_evidence"))
        if not raw:
            return None
        numeric = ("target_closed_trades_per_day", "target_net_usdt_per_day",
                   "minimum_observation_hours", "observed_hours",
                   "observed_closed_trades_per_day", "observed_net_usdt_per_day",
                   "closed_longs", "closed_shorts")
        values = {key: number(raw.get(key)) for key in numeric}
        if any(value is None for value in values.values()) or any(
                values[key] < 0 for key in numeric if key != "observed_net_usdt_per_day"):
            raise DashboardError(503, "Paper performance evidence is invalid")
        checks = obj(raw.get("checks"))
        expected = ("both_directions_closed", "profitable_after_modeled_costs",
                    "trade_pace_target_met", "net_profit_pace_target_met",
                    "minimum_observation_met")
        if any(not isinstance(checks.get(key), bool) for key in expected):
            raise DashboardError(503, "Paper performance evidence is invalid")
        status = text(raw.get("status"), 20)
        if status not in ("PASS", "NOT_PROVEN"):
            raise DashboardError(503, "Paper performance evidence is invalid")
        return {"status": status, **values,
                "checks": {key: checks[key] for key in expected},
                "scorecard_only": raw.get("goal_is_a_scorecard_not_a_trade_quota") is True}

    def _calendar(self, now):
        """Aggregate validated closed paper trades by Europe/London calendar day."""
        london = ZoneInfo("Europe/London")
        days = defaultdict(lambda: dict(net_usdt=0.0, estimated_costs_usdt=0.0,
                                        trades=0, wins=0, losses=0, flat=0,
                                        sessions=set()))
        month_keys = {datetime.fromtimestamp(now, london).strftime("%Y-%m")}
        source_status = "available"
        session_count = 0
        for session_info in self.sessions()["sessions"]:
            started = stamp(session_info.get("started_at"))
            if started is not None:
                month_keys.add(datetime.fromtimestamp(started, london).strftime("%Y-%m"))
            try:
                _, _, report, info = self._session(session_info["id"], now)
                _, session_trades = self._validated_trades(report, stamp(info.get("updated_at")))
            except DashboardError:
                source_status = "incomplete"
                continue
            if not report:
                source_status = "incomplete"
            session_count += 1
            for trade in session_trades:
                closed_at = stamp(trade.get("at"))
                net = number(trade.get("net_usdt"))
                if closed_at is None or net is None:
                    source_status = "incomplete"
                    continue
                day_key = datetime.fromtimestamp(closed_at, london).strftime("%Y-%m-%d")
                month_keys.add(day_key[:7])
                day = days[day_key]
                day["net_usdt"] += net
                costs = number(trade.get("costs_usdt"))
                if costs is not None:
                    day["estimated_costs_usdt"] += costs
                else:
                    source_status = "incomplete"
                day["trades"] += 1
                day["wins" if net > 0 else "losses" if net < 0 else "flat"] += 1
                day["sessions"].add(session_info["id"])

        months = []
        for month_key in sorted(month_keys, reverse=True)[:24]:
            try:
                year, month = (int(part) for part in month_key.split("-"))
                days_in_month = month_calendar.monthrange(year, month)[1]
            except (ValueError, TypeError):
                continue
            active_days = []
            for day_number in range(1, days_in_month + 1):
                day_key = f"{month_key}-{day_number:02d}"
                if day_key not in days:
                    continue
                item = days[day_key]
                active_days.append(dict(date=day_key, net_usdt=round(item["net_usdt"], 10),
                                        estimated_costs_usdt=round(item["estimated_costs_usdt"], 10),
                                        trades=item["trades"], wins=item["wins"], losses=item["losses"],
                                        flat=item["flat"], sessions=len(item["sessions"])))
            profitable = [item for item in active_days if item["net_usdt"] > 0]
            losing = [item for item in active_days if item["net_usdt"] < 0]
            months.append(dict(month=month_key,
                               label=datetime(year, month, 1, tzinfo=london).strftime("%B %Y"),
                               net_usdt=round(sum(item["net_usdt"] for item in active_days), 10),
                               estimated_costs_usdt=round(sum(item["estimated_costs_usdt"] for item in active_days), 10),
                               trades=sum(item["trades"] for item in active_days),
                               wins=sum(item["wins"] for item in active_days),
                               losses=sum(item["losses"] for item in active_days),
                               flat=sum(item["flat"] for item in active_days),
                               trading_days=len(active_days), profitable_days=len(profitable),
                               losing_days=len(losing),
                               best_day=max(active_days, key=lambda item: item["net_usdt"])["date"] if active_days else None,
                               best_day_usdt=max((item["net_usdt"] for item in active_days), default=None),
                               worst_day=min(active_days, key=lambda item: item["net_usdt"])["date"] if active_days else None,
                               worst_day_usdt=min((item["net_usdt"] for item in active_days), default=None),
                               days=active_days))
        return dict(timezone="Europe/London", currency="USDT", scope="All recorded paper sessions",
                    source_status=source_status, sessions=session_count, months=months)

    def _validated_trades(self, report, report_time):
        closed = array(report.get("closed_trade_details"))
        if report and (not isinstance(report.get("closed_trade_details"), list) or
                       (report.get("open_or_pending_trade") is not None and
                        not isinstance(report.get("open_or_pending_trade"), dict))):
            raise DashboardError(503, "Paper report positions or history are invalid")
        if len(closed) > 500:
            raise DashboardError(503, "Paper report exceeds the supported trade history")
        metrics = self._metrics(report)
        trades = [self._trade(row) for row in closed if isinstance(row, dict)]
        if report and (len(trades) != metrics["closed_trades"] or
                       any(row["net_usdt"] is None or row["at"] is None or
                           stamp(row["at"]) > report_time for row in trades)):
            raise DashboardError(503, "Paper report trade history is inconsistent")
        if trades and not math.isclose(sum(row["net_usdt"] for row in trades), metrics["net_usdt"], abs_tol=1e-6):
            raise DashboardError(503, "Paper report totals are inconsistent")
        if report and not trades and metrics["net_usdt"] != 0:
            raise DashboardError(503, "Paper report totals are inconsistent")
        trades.sort(key=lambda row: row["at"] or "")
        return metrics, trades

    @staticmethod
    def _metrics(report):
        fields = dict(initial_usdt="initial_usdt", net_usdt="net_usdt", estimated_costs_usdt="estimated_costs_on_closed_trades_usdt",
                      max_drawdown_usdt="max_realized_drawdown_usdt", entries="entries", closed_trades="closed_trades",
                      wins="wins", losses="losses", win_rate="win_rate", gross_losses_usdt="gross_losses_usdt")
        metrics = {key: number(report.get(source)) for key, source in fields.items()}
        if report:
            required = [key for key in fields if key != "win_rate"]
            if any(metrics[key] is None for key in required):
                raise DashboardError(503, "Paper report metrics are invalid")
            if any(metrics[key] < 0 for key in required if key != "net_usdt"):
                raise DashboardError(503, "Paper report metrics are invalid")
            for key in ("entries", "closed_trades", "wins", "losses"):
                if not metrics[key].is_integer():
                    raise DashboardError(503, "Paper report counts are invalid")
                metrics[key] = int(metrics[key])
            if metrics["wins"] + metrics["losses"] > metrics["closed_trades"]:
                raise DashboardError(503, "Paper report counts are inconsistent")
            if metrics["closed_trades"]:
                if metrics["win_rate"] is None or not math.isclose(
                        metrics["win_rate"], metrics["wins"] / metrics["closed_trades"], abs_tol=1e-6):
                    raise DashboardError(503, "Paper report win rate is inconsistent")
            elif metrics["win_rate"] is not None:
                raise DashboardError(503, "Paper report has a win rate without closed trades")
        initial, net = metrics["initial_usdt"], metrics["net_usdt"]
        # A zero initial balance denotes an experiment which has not initialized yet.
        if initial == 0:
            metrics["initial_usdt"] = initial = None
        metrics["equity_usdt"] = initial + net if initial is not None and net is not None else None
        metrics["net_pct"] = net / initial * 100 if initial and net is not None else None
        return metrics

    @staticmethod
    def _trade(row):
        plan = obj(row.get("plan"))
        notional, margin, costs, net = (number(plan.get("notional")), number(plan.get("margin")),
                                        number(plan.get("cost_bps")), number(row.get("net")))
        return dict(at=utc(row.get("time")), symbol=symbol(plan.get("symbol")), side=text(plan.get("direction"), 12),
                    entry=number(plan.get("entry")), exit=number(row.get("exit")), qty=number(plan.get("size")),
                    leverage=number(plan.get("leverage")), notional=notional, margin=margin, net_usdt=net,
                    roi_pct=net/margin*100 if net is not None and margin is not None and margin > 0 else None,
                    profit_multiple=net/margin if net is not None and margin is not None and margin > 0 else None,
                    costs_usdt=notional*costs/10000 if notional is not None and costs is not None else None,
                    reason=text(row.get("note")), simulated=True)

    @staticmethod
    def _position(report):
        raw = report.get("open_or_pending_trade")
        if not isinstance(raw, dict):
            return None
        plan = obj(raw.get("plan"))
        return dict(status=text(raw.get("status"), 40), symbol=symbol(plan.get("symbol")),
                    side=text(plan.get("direction"), 12), entry=number(plan.get("entry")),
                    stop=number(plan.get("stop")), take_profit=number(plan.get("target")),
                    qty=number(plan.get("size")), leverage=number(plan.get("leverage")),
                    notional=number(plan.get("notional")), margin=number(plan.get("margin")),
                    expected_loss=number(plan.get("expected_loss")), expected_win=number(plan.get("expected_win")),
                    created_at=utc(raw.get("placed_at")), filled_at=utc(raw.get("filled_at")), simulated=True)

    @staticmethod
    def _health(health, session, info, now):
        at = stamp(health.get("at"))
        health_age = age(now, at)
        current_report = health_age is not None and health_age <= REPORT_FRESH_SECONDS and not info["stale"]
        running = info["recorded_status"] == "RUNNING" and info["status"] == "RUNNING"
        feed, news, brain = obj(health.get("feed")), obj(health.get("news")), obj(health.get("brain"))
        news_age, brain_age = age(now, news.get("last_success")), age(now, brain.get("last_success"))
        config = obj(session.get("config"))
        news_ttl = number(config.get("news_stale_seconds")) or 3900
        brain_ttl = number(brain.get("verdict_ttl_seconds")) or 120
        feed_status = "recorded" if current_report and running and feed.get("connected") is True else "stale"
        if not feed:
            feed_status = "unavailable"
        elif current_report and running and not feed.get("connected"):
            feed_status = "disconnected"
        news_ready = (running and current_report and news.get("ready") is True and
                      news_age is not None and news_age <= news_ttl)
        brain_fresh = running and current_report and brain_age is not None and brain_age <= brain_ttl
        news_status = "sampled" if news_ready else ("stale" if news.get("configured") else "unavailable")
        brain_status = "fresh" if brain_fresh else "stale"
        if session.get("brain_enabled") is not True:
            brain_status = "disabled"
        elif brain.get("budget_exhausted"):
            brain_status = "budget_exhausted"
        elif not brain:
            brain_status = "unavailable"
        elif current_report and running and brain.get("reviewing"):
            brain_status = "reviewing"
        if brain.get("error") and not brain_fresh:
            brain_status = "unavailable"
        return dict(
            feed=dict(status=feed_status, recorded_connected=feed.get("connected") is True,
                      observed_at=utc(at), age_seconds=health_age, messages=number(feed.get("messages")),
                      symbols=[symbol(item) for item in array(feed.get("symbols"))[:16] if symbol(item)],
                      topics=[text(item, 40) for item in array(feed.get("topics"))[:8]],
                      error=text(feed.get("error")), detail="Public market stream; dashboard updates automatically. X and GPT retain their own review schedules."),
            news=dict(status=news_status, ready=news_ready, configured=news.get("configured") is True,
                      last_success=utc(news.get("last_success")), age_seconds=news_age,
                      calls_today=number(news.get("calls_today")), daily_call_cap=number(news.get("daily_call_cap")),
                      posts_returned_today=number(news.get("posts_returned_today")),
                      trusted_authors=number(news.get("trusted_authors")),
                      poll_interval_seconds=number(news.get("poll_interval_seconds")),
                      quiet_hours=text(news.get("quiet_hours"), 40), timezone=text(news.get("timezone"), 80),
                      error=text(news.get("error"))),
            brain=dict(status=brain_status, model=text(brain.get("model"), 60), enabled=session.get("brain_enabled") is True,
                       last_success=utc(brain.get("last_success")), age_seconds=brain_age,
                       calls=number(brain.get("calls")), max_calls=number(brain.get("max_calls")),
                       verdict_ttl_seconds=brain_ttl, heartbeat_seconds=number(brain.get("heartbeat_seconds")),
                       lessons=number(brain.get("lessons")), learning_status="hypotheses_only",
                       error=text(brain.get("error"))))

    @staticmethod
    def _markets(health, events, info, now):
        watched = set(array(obj(health.get("feed")).get("symbols")))
        latest = {}
        for event in events:
            name = symbol(event.get("symbol"))
            if event.get("kind") == "verdict" and name:
                latest[name] = event
        markets = []
        for name, row in list(obj(health.get("verdicts")).items())[:16]:
            if not symbol(name) or not isinstance(row, dict):
                continue
            previous = latest.get(name, {})
            # Health can retain removed symbols indefinitely. Never renew their timestamp.
            at = previous.get("time")
            if name in watched:
                at = health.get("at")
            elapsed = age(now, at)
            item = dict(symbol=name, verdict=text(row.get("verdict"), 24), reason=text(row.get("reason")),
                        watched=name in watched, is_new_listing=row.get("is_new_listing") is True,
                        trade_style=text(row.get("trade_style"), 24),
                        scalp_reason=text(row.get("scalp_reason")),
                        scalp_impulse_active=row.get("scalp_impulse_active") is True,
                        at=utc(at), age_seconds=elapsed,
                        stale=info["stale"] or name not in watched or elapsed is None or elapsed > REPORT_FRESH_SECONDS,
                        hourly_trend=text(row.get("hourly_trend"), 24), five_minute_trend=text(row.get("five_minute_trend"), 24))
            for key in ("price", "spread_bps", "funding_bps", "volume_ratio", "adx", "atr_bps", "bid_depth", "ask_depth",
                        "imbalance", "exchange_max_leverage", "maker_fee_bps", "taker_fee_bps",
                        "scalp_move_bps", "scalp_flow_imbalance", "scalp_book_imbalance",
                        "scalp_acceleration", "scalp_notional_usdt", "scalp_trades"):
                item[key] = number(row.get(key))
            if health.get('publication_interval_seconds') == 1:
                quote = obj(obj(health.get('quotes')).get(name))
                quote_age = age(now, quote.get('at'))
                item['quote_at'] = utc(quote.get('at'))
                item['quote_age_seconds'] = quote_age
                item['stale'] = (info['stale'] or info['status'] != 'RUNNING' or name not in watched
                                 or quote_age is None or quote_age > 5
                                 or obj(health.get('feed')).get('connected') is not True)
                for key in ('price','spread_bps','bid_depth','ask_depth','imbalance'):
                    value = number(quote.get(key))
                    if value is not None:item[key] = value
                item['price_source'] = 'public_websocket' if quote else 'last_strategy_snapshot'
            markets.append(item)
        markets.sort(key=lambda item: (not item["watched"], item["is_new_listing"], item["symbol"]))
        return markets

    @staticmethod
    def _decisions(events, brain_health, info, now):
        snapshot_times = {text(obj(row.get("snapshot")).get("snapshot_id"), 80):
                          stamp(obj(row.get("snapshot")).get("observed_at")) for row in events if row.get("kind") == "snapshot"}
        decisions = []
        latest_review = True
        for event in reversed(events):
            if event.get("kind") == "review_error":
                latest_review = False
            if event.get("kind") != "review":
                continue
            result = obj(event.get("result"))
            observed = snapshot_times.get(text(event.get("snapshot_id"), 80))
            elapsed = age(now, observed)
            fresh = (latest_review and info["status"] == "RUNNING" and not info["stale"] and elapsed is not None and
                     elapsed <= brain_health["verdict_ttl_seconds"])
            for decision in array(result.get("decisions"))[:16]:
                if not isinstance(decision, dict) or not symbol(decision.get("symbol")):
                    continue
                decisions.append(dict(at=utc(event.get("time")), observed_at=utc(observed), age_seconds=elapsed,
                                      symbol=symbol(decision.get("symbol")), action=text(decision.get("action"), 16),
                                      reason=text(decision.get("reason"), 1000), evidence=[text(item) for item in array(decision.get("evidence"))[:8]],
                                      invalidation=text(decision.get("invalidation"), 1000), sources=sources(result.get("sources")), fresh=fresh))
            if len(decisions) >= 24:
                break
            latest_review = False
        return decisions[:24]

    @staticmethod
    def _activity(events, brain_events, report_time):
        rows = []
        for event in events:
            kind = event.get("kind")
            if kind not in ("verdict", "entry", "closed"):
                continue
            plan = obj(event.get("plan"))
            name = symbol(event.get("symbol") or plan.get("symbol"))
            title = "Trade closed" if kind == "closed" else ("Paper entry planned" if kind == "entry" else text(event.get("verdict"), 24))
            rows.append(dict(at=utc(event.get("time")), kind=kind, symbol=name, title=title,
                             detail=text(event.get("note") or event.get("risk_reason") or event.get("reason") or plan.get("reason")),
                             net_usdt=number(event.get("net"))))
        for event in brain_events:
            if event.get("kind") not in ("review", "review_error"):
                continue
            rows.append(dict(at=utc(event.get("time")), kind="brain", symbol="", title="GPT review" if event["kind"] == "review" else "GPT unavailable",
                             detail="Decision evidence recorded" if event["kind"] == "review" else text(event.get("error_type"), 80), net_usdt=None))
        rows.sort(key=lambda item: item["at"] or "", reverse=True)
        return rows[:30]

    def asset(self, url):
        if url not in ASSETS:
            raise DashboardError(404, "Resource not found")
        name, content_type = ASSETS[url]
        path = self._inside(self.assets_dir, self.assets_dir / name)
        try:
            with path.open("rb") as handle:
                content = handle.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise OSError("asset exceeds limit")
            return content, content_type
        except OSError:
            raise DashboardError(503, "Dashboard assets are unavailable") from None


def make_handler(store):
    stream_slots = threading.BoundedSemaphore(16)
    cache_lock = threading.Lock()
    cache = {}

    def stream_snapshot(session_id):
        # Share sanitized work across viewers; memory and per-connection lifetimes are bounded.
        with cache_lock:
            now = time.monotonic()
            cached = cache.get(session_id)
            if cached and now-cached[0] < .8:return cached[1]
            payload = json.dumps(store.dashboard(session_id), allow_nan=False, ensure_ascii=True,
                                 separators=(',',':')).encode()
            if len(cache) >= 40:cache.clear()
            cache[session_id] = (now,payload)
            return payload

    def desk_stream_snapshot():
        # Live UTA portfolio snapshot shared across desk SSE viewers (~1s cadence).
        with cache_lock:
            now = time.monotonic()
            cached = cache.get("__desk__")
            if cached and now - cached[0] < 0.9:
                return cached[1]
            from bot import live_desk
            paper = None
            try:
                paper = (store.sessions().get("sessions") or [None])[0]
            except Exception:
                paper = None
            payload = json.dumps(
                live_desk.desk_summary(paper),
                allow_nan=False,
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode()
            if len(cache) >= 40:
                cache.clear()
            cache["__desk__"] = (now, payload)
            return payload

    class Handler(BaseHTTPRequestHandler):
        server_version = "BitbotDashboard"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def _send(self, status, body, content_type="application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "SAMEORIGIN")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'")
            if status == 405:
                self.send_header("Allow", "GET, HEAD, POST")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status, value):
            self._send(status, json.dumps(value, allow_nan=False, ensure_ascii=True, separators=(",", ":")).encode())

        def _stream(self, session_id):
            payload = stream_snapshot(session_id)  # Validate before sending streaming headers.
            if self.command == 'HEAD':
                self._send(200,b'','text/event-stream');return
            if not stream_slots.acquire(blocking=False):
                self._json(503,{'error':'Live connection busy; retrying shortly'});return
            try:
                self.send_response(200)
                for key,value in {'Content-Type':'text/event-stream; charset=utf-8',
                                  'Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no',
                                  'X-Content-Type-Options':'nosniff','Connection':'close'}.items():
                    self.send_header(key,value)
                self.end_headers()
                deadline=time.monotonic()+60
                self.wfile.write(b'retry: 2000\n\n')
                while time.monotonic()<deadline:
                    self.wfile.write(b'event: dashboard\ndata: '+payload+b'\n\n');self.wfile.flush()
                    time.sleep(1)
                    try:payload=stream_snapshot(session_id)
                    except Exception:
                        self.wfile.write(b'event: unavailable\ndata: {"error":"Live data temporarily unavailable"}\n\n')
                        self.wfile.flush();break
            except (BrokenPipeError,ConnectionResetError,TimeoutError,OSError):pass
            finally:
                self.close_connection=True
                stream_slots.release()

        def _desk_stream(self):
            payload = desk_stream_snapshot()
            if self.command == "HEAD":
                self._send(200, b"", "text/event-stream")
                return
            if not stream_slots.acquire(blocking=False):
                self._json(503, {"error": "Live connection busy; retrying shortly"})
                return
            try:
                self.send_response(200)
                for key, value in {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-store, no-transform",
                    "X-Accel-Buffering": "no",
                    "X-Content-Type-Options": "nosniff",
                    "Connection": "close",
                }.items():
                    self.send_header(key, value)
                self.end_headers()
                deadline = time.monotonic() + 60
                self.wfile.write(b"retry: 1500\n\n")
                self.wfile.write(b"event: hello\ndata: {\"service\":\"bitbot-desk\",\"version\":\"desk-2.2.1\"}\n\n")
                self.wfile.flush()
                while time.monotonic() < deadline:
                    self.wfile.write(b"event: desk\ndata: " + payload + b"\n\n")
                    self.wfile.flush()
                    time.sleep(1)
                    try:
                        payload = desk_stream_snapshot()
                    except Exception:
                        self.wfile.write(
                            b'event: unavailable\ndata: {"error":"Live portfolio temporarily unavailable"}\n\n'
                        )
                        self.wfile.flush()
                        break
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass
            finally:
                self.close_connection = True
                stream_slots.release()

        def do_GET(self):
            try:
                parsed = urlsplit(self.path)
                if parsed.scheme or parsed.netloc:
                    raise DashboardError(400, "Invalid request")
                if parsed.path in ("/api/health", "/api/desk", "/api/account", "/api/positions", "/api/bot"):
                    if parsed.query:
                        raise DashboardError(400, "Invalid query")
                    from bot import live_desk
                    if parsed.path == "/api/health":
                        self._json(200, live_desk.health())
                    elif parsed.path == "/api/account":
                        self._json(200, live_desk.account_payload())
                    elif parsed.path == "/api/positions":
                        self._json(200, live_desk.positions_payload())
                    elif parsed.path == "/api/bot":
                        from bot import desk_bot
                        self._json(200, desk_bot.status())
                    else:
                        paper = None
                        try:
                            paper = (store.sessions().get("sessions") or [None])[0]
                        except Exception:
                            paper = None
                        self._json(200, live_desk.desk_summary(paper))
                elif parsed.path in ("/api/ticker", "/api/candles", "/api/fills"):
                    from bot import live_desk
                    query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=8)
                    if parsed.path == "/api/candles":
                        allowed = {"symbol", "category", "granularity", "limit"}
                    elif parsed.path == "/api/fills":
                        allowed = {"symbol", "category", "limit"}
                    else:
                        allowed = {"symbol", "category"}
                    if set(query) - allowed or any(len(value) != 1 for value in query.values()):
                        raise DashboardError(400, "Invalid query")
                    symbol = (query.get("symbol") or [None])[0]
                    if not symbol:
                        raise DashboardError(400, "symbol required")
                    category = (query.get("category") or ["USDT-FUTURES"])[0]
                    try:
                        if parsed.path == "/api/ticker":
                            payload = live_desk.ticker_payload(symbol, category)
                            self._json(200 if payload.get("ok") else 503, payload)
                        elif parsed.path == "/api/fills":
                            limit_raw = (query.get("limit") or ["80"])[0]
                            try:
                                limit = int(limit_raw)
                            except ValueError as exc:
                                raise DashboardError(400, "Invalid limit") from exc
                            payload = live_desk.fills_payload(symbol, category, limit)
                            self._json(200 if payload.get("ok") else 503, payload)
                        else:
                            granularity = (query.get("granularity") or ["15m"])[0]
                            limit_raw = (query.get("limit") or ["200"])[0]
                            try:
                                limit = int(limit_raw)
                            except ValueError as exc:
                                raise DashboardError(400, "Invalid limit") from exc
                            payload = live_desk.candles_payload(symbol, category, granularity, limit)
                            self._json(200 if payload.get("ok") else 503, payload)
                    except ValueError as exc:
                        raise DashboardError(400, str(exc)) from exc
                elif parsed.path == "/api/desk/stream":
                    if parsed.query:
                        raise DashboardError(400, "Invalid query")
                    self._desk_stream()
                elif parsed.path in ("/api/dashboard", "/api/sessions", "/api/stream"):
                    query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=5)
                    if set(query) - {"session"} or any(len(value) != 1 for value in query.values()):
                        raise DashboardError(400, "Invalid query")
                    if parsed.path == "/api/sessions":
                        self._json(200, store.sessions())
                    elif parsed.path == '/api/stream':
                        self._stream(query.get('session',[None])[0])
                    else:
                        self._json(200, store.dashboard(query.get("session", [None])[0]))
                else:
                    body, content_type = store.asset(parsed.path)
                    self._send(200, body, content_type)
            except DashboardError as exc:
                self._json(exc.status, {"error": exc.message})
            except (ValueError, TypeError, OverflowError):
                self._json(400, {"error": "Invalid request"})
            except Exception:
                self._json(503, {"error": "Dashboard data is temporarily unavailable"})

        do_HEAD = do_GET

        def _read_json_body(self, max_bytes=8192):
            length = self.headers.get("Content-Length")
            if length is None:
                raise DashboardError(400, "Content-Length required")
            try:
                size = int(length)
            except ValueError as exc:
                raise DashboardError(400, "Invalid Content-Length") from exc
            if size < 0 or size > max_bytes:
                raise DashboardError(413, "Body too large")
            raw = self.rfile.read(size) if size else b""
            if not raw:
                return {}
            try:
                value = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise DashboardError(400, "Invalid JSON") from exc
            if not isinstance(value, dict):
                raise DashboardError(400, "JSON object required")
            return value

        def do_POST(self):
            try:
                parsed = urlsplit(self.path)
                if parsed.scheme or parsed.netloc or parsed.query:
                    raise DashboardError(400, "Invalid request")
                if parsed.path not in ("/api/trade/preview", "/api/trade/place", "/api/bot"):
                    raise DashboardError(405, "Method not allowed")
                from bot import live_desk
                body = self._read_json_body()
                if parsed.path == "/api/bot":
                    from bot import desk_bot
                    try:
                        self._json(200, desk_bot.command(body))
                    except ValueError as exc:
                        raise DashboardError(400, str(exc)) from exc
                elif parsed.path == "/api/trade/preview":
                    try:
                        self._json(200, live_desk.trade_preview(body))
                    except ValueError as exc:
                        raise DashboardError(400, str(exc)) from exc
                    except RuntimeError as exc:
                        raise DashboardError(503, str(exc)) from exc
                else:
                    status, payload = live_desk.trade_place(body)
                    self._json(status, payload)
            except DashboardError as exc:
                self._json(exc.status, {"error": exc.message, "ok": False})
            except (ValueError, TypeError, OverflowError):
                self._json(400, {"error": "Invalid request", "ok": False})
            except Exception:
                self._json(503, {"error": "Trade endpoint temporarily unavailable", "ok": False})

        def _reject(self):
            self.close_connection = True
            self._json(405, {"error": "Method not allowed; use GET or POST /api/trade/* or /api/bot"})

        do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = do_CONNECT = _reject

        def log_message(self, format, *args):
            # No request URLs, parameters or local paths enter logs.
            pass

    return Handler


def create_server(data_dir, assets_dir, host="127.0.0.1", port=8871):
    allowed = {"127.0.0.1", "0.0.0.0"}
    if host not in allowed:
        raise ValueError("host must be 127.0.0.1 (default) or 0.0.0.0 for Tailscale/LAN bind")
    try:
        from bot import desk_bot
        desk_bot.configure(Path(data_dir) / "desk-bot.json")
        desk_bot.start_loop()
    except Exception:
        pass
    server = ThreadingHTTPServer((host, port), make_handler(DashboardStore(data_dir, assets_dir)))
    server.daemon_threads = True
    return server
