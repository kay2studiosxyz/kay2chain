# Bitbot · custom Bitget perps desk (desk 2.6)

Production app for **https://bitbot.kay2.dev** runs on the ASUS NUC (`kay2nuc-1` / `100.112.164.103`) under PM2:

- `bitbot-paper` — paper trading runner
- `bitbot-dashboard` — desk UI + API on `127.0.0.1:8871`
- Cloudflare tunnel `agent-desk` → `bitbot.kay2.dev` (Access gated)

This folder mirrors the desk files for the **Bitget-backed perps app**. Venue stays Bitget UTA. The UI is a custom Hyperliquid-style trade desk built around the live book — open longs (SOL, HYPE, anything else on UTA) sit in the symbol switcher with uPnL, chart entry/liq lines, and the ticket. LIVE lock stays on unless Kane unlocks.

## Market + portfolio

| Endpoint | Role |
|----------|------|
| `GET /api/account` | Sanitized Bitget UTA equity / MMR / IMR |
| `GET /api/positions` | Open positions with mark, uPnL, liq distance |
| `GET /api/desk` | Combined summary |
| `GET /api/desk/stream` | **SSE** (~1s) — `event: desk` with the same payload as `/api/desk` |
| `GET /api/ticker` | Public Bitget ticker (last, mark, bid/ask, 24h, funding) |
| `GET /api/candles` | Public Bitget OHLCV |
| `GET /api/orderbook` | Public Bitget depth for the terminal book |
| `GET /api/trades` | Public Bitget tape |
| `GET /api/fills` | Account fills for chart **buy/sell bubbles** |
| `GET/POST /api/bot` | USDT-M futures paper scalper — SOL/HYPE/BTC/ETH 1m/5m, 10–150× (below 10× is safe) |

The desk UI opens `/api/desk/stream` for the UTA book and `/api/market/stream` for last/book/tape. Market data is pumped from Bitget's **public WebSocket** (no key). If that feed goes quiet, free Binance USDT-M bookTicker and Bybit linear tickers fill last/bid/ask. REST polling is the fallback only. LIVE order placement stays locked unless `BITBOT_LIVE_OK` is explicitly unlocked on the NUC. Place still does not call Bitget while locked (403) or even when unlocked on this build (501).

Watchlist markets: **SOLUSDT**, **HYPEUSDT**, **BTCUSDT**, **ETHUSDT**, plus any other open UTA contract.

Phone (≤900px) is a chart-first desk: full-height candles, a floating position chip, and a thumb-zone **Buy / Sell** bar that opens the ticket as a bottom sheet. LIVE stay locked.

## Deployed on NUC

Copy these files onto `/home/kay2/bitbot-rebuild` then:

```bash
pm2 restart bitbot-dashboard
```
