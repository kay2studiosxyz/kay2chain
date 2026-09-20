# Bitbot · real-time portfolio (desk 2.2)

Production app for **https://bitbot.kay2.dev** runs on the ASUS NUC (`kay2nuc-1` / `100.112.164.103`) under PM2:

- `bitbot-paper` — paper trading runner
- `bitbot-dashboard` — desk UI + API on `127.0.0.1:8871`
- Cloudflare tunnel `agent-desk` → `bitbot.kay2.dev` (Access gated)

This folder mirrors the desk files changed for **live UTA portfolio streaming**. It is not a full deployable checkout of `/home/kay2/bitbot-rebuild`.

## Real-time portfolio

| Endpoint | Role |
|----------|------|
| `GET /api/account` | Sanitized Bitget UTA equity / MMR / IMR |
| `GET /api/positions` | Open positions with mark, uPnL, liq distance |
| `GET /api/desk` | Combined summary |
| `GET /api/desk/stream` | **SSE** (~1s) — `event: desk` with the same payload as `/api/desk` |
| `GET /api/fills` | Recent Bitget fills for chart **buy/sell bubbles** |
| `GET/POST /api/bot` | In-app **paper scalper** + live UTA take-profit signals (never places Bitget orders) |

The desk UI opens `/api/desk/stream` via `EventSource` and falls back to REST polling every 3s if the stream drops. LIVE order placement stays locked unless `BITBOT_LIVE_OK` is explicitly unlocked on the NUC.

## Deployed on NUC (2026-09-20)

- `bot/dashboard.py` — `/api/desk/stream` handler
- `bot/live_desk.py` — version `desk-2.1.1`
- `dashboard/app.js` — stream consumer + poll fallback
- `dashboard/index.html` — “live stream” label
- `docs/DESK_API.md` — contract

Restart after edits on the NUC:

```bash
pm2 restart bitbot-dashboard
```
