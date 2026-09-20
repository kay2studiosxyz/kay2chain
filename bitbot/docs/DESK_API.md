# Bitbot desk API (stable contract)

Base: `http://127.0.0.1:8871` (default). Public: `https://bitbot.kay2.dev` (Cloudflare Access).

Mode default is **PAPER_WATCH**. LIVE order placement stays locked unless
`BITBOT_LIVE_OK` is explicitly unlocked. Responses never include API keys.

## Endpoints

### `GET /api/health`
```json
{ "ok": true, "service": "bitbot-dashboard", "mode": "PAPER_WATCH", "version": "desk-2.0.0", "ts": "…", "live_trading": false, "live_lock": "…" }
```

### `GET /api/desk`
Summary for embeds (includes positions + live lock).

### `GET /api/desk/stream`
Server-sent events for real-time UTA portfolio (equity, unrealised PnL, open positions).

- `event: hello` — once on connect (`service`, `version`)
- `event: desk` — ~1s cadence; same payload shape as `GET /api/desk`
- `event: unavailable` — stream ending after a publisher failure
- Connection lifetime ~60s; client should reconnect (browser `EventSource` does this)
- Bounded concurrent streams (shared with paper `/api/stream`)


### `GET /api/account`
Sanitized UTA equity / MMR / IMR (no keys).

### `GET /api/positions`
Open UTA positions with mark, unrealised PnL, liq, break-even, margin, pnl_pct, distance_to_liq_pct. Cached ~3s.

### `GET /api/ticker?symbol=&category=`
Public Bitget ticker (proxied). `category` default `USDT-FUTURES`.
```json
{ "ok": true, "symbol": "SOLUSDT", "category": "USDT-FUTURES", "last": 108.3, "mark": 108.3, "bid": …, "ask": …, "change24h": -3.0, "stale": false }
```


### `GET /api/fills?symbol=&category=&limit=`
Recent Bitget UTA fills for chart buy/sell bubbles. `limit` default 80 (max 200).
```json
{ "ok": true, "symbol": "SOLUSDT", "fills": [{"side":"buy","price":110.3,"qty":0.1,"time":1789853939,"ts_ms":1789853939666}], "count": 1 }
```

### `GET /api/candles?symbol=&category=&granularity=&limit=`
OHLCV from Bitget public candles. Granularity: `1m` `5m` `15m` `1H` `4H` (aliases `1h`/`4h` accepted).
```json
{ "ok": true, "symbol": "SOLUSDT", "granularity": "15m", "candles": [{"t": 0, "o": 0, "h": 0, "l": 0, "c": 0, "v": 0}], "count": 200 }
```

### `POST /api/trade/preview`
Validate ticket; return sized notional / margin / liq estimate. **Never places an order.**

### `POST /api/trade/place`
**403 while LIVE locked** (`BITBOT_LIVE_OK=0` default). Even when unlocked, this build returns 501 and does not call Bitget place/close.

## LIVE lock
Unlocked only if:
- env `BITBOT_LIVE_OK` in `{1,true,yes,ok,live}` (process env, or `.env` under rebuild / perps-bot), **or**
- file `/home/kay2/bitbot-rebuild/data/LIVE_OK` containing exactly `OK`

Default: locked. STOP ALL TRADING.

## Caching
- Positions/account snapshot ~3s
- Tickers ~1.5s
- Candles ~8s
On Bitget failure, last good snapshot may return with `stale: true`.

## Legacy paper observatory (unchanged, not primary UI)
- `GET /api/dashboard?session=…`
- `GET /api/sessions`
- `GET /api/stream?session=…` (SSE)
