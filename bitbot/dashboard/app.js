'use strict';
(() => {
  const BASE = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'];
  const POLL_POS_MS = 3000;
  const POLL_TICK_MS = 2000;
  const POLL_CANDLE_MS = 15000;

  const state = {
    view: 'overview',
    positions: [],
    account: null,
    symbol: 'SOLUSDT',
    category: 'USDT-FUTURES',
    tf: '15m',
    side: 'long',
    sizeMode: 'coins',
    liveUnlocked: false,
    chart: null,
    series: null,
    lastCandlesKey: '',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const icons = {
    grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
    arrows: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 7h10v10M7 17 17 7"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  };

  function paintIcons() {
    $$('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      if (icons[name]) el.innerHTML = icons[name];
    });
  }

  function fmt(n, d = 2) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtPx(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    const x = Math.abs(Number(n));
    const d = x >= 1000 ? 2 : x >= 100 ? 3 : x >= 1 ? 4 : 6;
    return fmt(n, d);
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return `${v >= 0 ? '+' : ''}${fmt(v, 2)}%`;
  }

  function money(n, d = 2) {
    if (n == null || Number.isNaN(Number(n))) return "\u2014";
    const v = Number(n);
    const sign = v < 0 ? "-" : (v > 0 ? "+" : "");
    return `${sign}$${fmt(Math.abs(v), d)}`;
  }

  function pnlClass(n) {
    if (n == null || Number.isNaN(Number(n))) return '';
    return Number(n) >= 0 ? 'up' : 'down';
  }

  function setConn(kind, label) {
    const node = $('#connection');
    if (!node) return;
    node.className = `connection ${kind}`;
    const span = node.querySelector('span');
    if (span) span.textContent = label;
  }

  function showNotice(msg, kind = 'warn') {
    const n = $('#notice');
    if (!n) return;
    if (!msg) {
      n.hidden = true;
      n.textContent = '';
      return;
    }
    n.hidden = false;
    n.className = `notice ${kind}`;
    n.textContent = msg;
  }

  function ukClock() {
    const el = $('#uk-clock');
    if (!el) return;
    el.textContent = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
  }

  async function api(path, opts) {
    const ctrl = new AbortController();
    const ms = (opts && opts.timeoutMs) || 10000;
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const { timeoutMs, ...rest } = opts || {};
      const res = await fetch(path, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
        headers: rest.body ? { 'Content-Type': 'application/json' } : undefined,
        ...rest,
      });
      let data = null;
      const ctype = (res.headers.get('content-type') || '');
      try {
        if (ctype.includes('application/json')) data = await res.json();
        else {
          const text = await res.text();
          data = { ok: false, error: res.redirected || res.status === 302 ? 'Access login required — refresh' : `Non-JSON (${res.status})` };
          if (text && text.length < 120) data.detail = text;
        }
      } catch {
        data = { ok: false, error: 'Bad JSON' };
      }
      return { res, data };
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? 'Timeout' : String(err.message || err);
      return { res: null, data: { ok: false, error: msg } };
    } finally {
      clearTimeout(timer);
    }
  }

  function setView(name) {
    state.view = name;
    $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
    $$('.view').forEach((p) => {
      const on = p.dataset.panel === name;
      p.hidden = !on;
    });
    const titles = {
      overview: ['Overview', 'Open UTA positions, equity, and mark prices.'],
      charts: ['Charts', 'Bitget candles · near-realtime mark.'],
      trade: ['Trade', 'Simulate fills. LIVE stays locked until Kane unlocks.'],
    };
    const [t, d] = titles[name] || titles.overview;
    $('#page-title').textContent = t;
    $('#page-description').textContent = d;
    $('#crumb').textContent = t;
    if (name === 'charts') {
      ensureChart();
      loadCandles(true);
    }
  }

  function hashView() {
    const h = (location.hash || '#overview').replace('#', '');
    return ['overview', 'charts', 'trade'].includes(h) ? h : 'overview';
  }

  function renderAccount(acct) {
    state.account = acct;
    if (!acct) {
      $('#acct-equity').textContent = '—';
      $('#acct-upnl').textContent = '—';
      $('#acct-avail').textContent = '—';
      $('#acct-mmr').textContent = '—';
      return;
    }
    $('#acct-equity').textContent = acct.equity != null ? `$${fmt(acct.equity)}` : '—';
    const upnl = acct.unrealised_pnl;
    const up = $('#acct-upnl');
    up.textContent = money(upnl);
    up.className = pnlClass(upnl);
    const usdt = (acct.assets || []).find((a) => a.coin === 'USDT');
    $('#acct-avail').textContent = usdt && usdt.available != null ? `$${fmt(usdt.available)}` : '—';
    const mmr = acct.mmr != null ? fmt(acct.mmr, 2) : '—';
    const imr = acct.imr != null ? fmt(acct.imr, 2) : '—';
    $('#acct-mmr').textContent = `${mmr} / ${imr}`;
  }

  function positionCard(p) {
    const side = (p.side || '').toLowerCase();
    const upnl = p.unrealised_pnl;
    const pct = p.pnl_pct;
    return `<article class="pos-card ${side}">
      <header>
        <div class="pos-sym">
          <strong>${p.symbol || '—'}</strong>
          <span class="side-pill ${side}">${side || '—'}</span>
          <span class="lev">${p.leverage != null ? `${fmt(p.leverage, 0)}×` : '—'}</span>
        </div>
        <div class="pos-pnl ${pnlClass(upnl)}">
          <strong>${money(upnl)}</strong>
          <span>${fmtPct(pct)}</span>
        </div>
      </header>
      <div class="pos-grid">
        <div><span>Size</span><strong>${fmt(p.size, 4)}</strong></div>
        <div><span>Entry</span><strong>${fmtPx(p.entry)}</strong></div>
        <div><span>Mark</span><strong class="mark">${fmtPx(p.mark)}</strong></div>
        <div><span>Break-even</span><strong>${fmtPx(p.break_even)}</strong></div>
        <div><span>Liq</span><strong>${fmtPx(p.liq)}</strong></div>
        <div><span>To liq</span><strong>${p.distance_to_liq_pct != null ? fmt(p.distance_to_liq_pct, 2) + '%' : '—'}</strong></div>
        <div><span>Margin</span><strong>${p.margin != null ? '$' + fmt(p.margin) : '—'}</strong></div>
        <div><span>Mode</span><strong>${p.margin_mode || '—'}</strong></div>
      </div>
      <footer>
        <button type="button" class="text-button" data-chart-sym="${p.symbol}">Chart ${p.symbol} →</button>
        <button type="button" class="text-button" data-trade-sym="${p.symbol}">Trade ticket →</button>
      </footer>
    </article>`;
  }

  function renderPositions(list) {
    state.positions = list || [];
    const root = $('#positions-hero');
    $('#nav-pos').textContent = String(state.positions.length || 0);
    $('#pos-count').textContent = `${state.positions.length} open`;
    if (!state.positions.length) {
      root.innerHTML = '<div class="empty-pos card">No open UTA positions.</div>';
      return;
    }
    root.innerHTML = state.positions.map(positionCard).join('');
    root.querySelectorAll('[data-chart-sym]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.symbol = btn.dataset.chartSym;
        location.hash = 'charts';
        setView('charts');
        buildSymbolSwitch();
        loadCandles(true);
        loadTicker();
      });
    });
    root.querySelectorAll('[data-trade-sym]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sel = $('#t-symbol');
        ensureSymbolOption(btn.dataset.tradeSym);
        sel.value = btn.dataset.tradeSym;
        location.hash = 'trade';
        setView('trade');
      });
    });
    syncTradeSymbols();
  }

  function ensureSymbolOption(sym) {
    const sel = $('#t-symbol');
    if (![...sel.options].some((o) => o.value === sym)) {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = sym;
      sel.appendChild(opt);
    }
  }

  function syncTradeSymbols() {
    const symbols = new Set(BASE);
    state.positions.forEach((p) => p.symbol && symbols.add(p.symbol));
    const sel = $('#t-symbol');
    const current = sel.value;
    sel.innerHTML = '';
    [...symbols].forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    });
    if (symbols.has(current)) sel.value = current;
    else if (state.positions[0]) sel.value = state.positions[0].symbol;
    buildSymbolSwitch();
  }

  function buildSymbolSwitch() {
    const root = $('#symbol-switch');
    if (!root) return;
    const symbols = new Set(BASE);
    state.positions.forEach((p) => p.symbol && symbols.add(p.symbol));
    if (!symbols.has(state.symbol)) state.symbol = [...symbols][0] || 'SOLUSDT';
    root.innerHTML = [...symbols].map((s) =>
      `<button type="button" role="tab" data-sym="${s}" class="${s === state.symbol ? 'active' : ''}">${s}</button>`
    ).join('');
    root.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.symbol = btn.dataset.sym;
        buildSymbolSwitch();
        loadCandles(true);
        loadTicker();
      });
    });
  }

  function applyLiveLock(unlocked, message) {
    state.liveUnlocked = !!unlocked;
    const badge = $('#mode-badge span');
    const chip = $('#mode-chip');
    const side = $('#sidebar-live');
    const liveBtn = $('#btn-live');
    const lockMsg = $('#ticket-lock');
    if (unlocked) {
      if (badge) badge.textContent = 'LIVE UNLOCKED';
      if (chip) chip.innerHTML = '<i></i> LIVE OK';
      if (side) side.textContent = 'LIVE unlocked';
      liveBtn.disabled = true;
      liveBtn.textContent = 'LIVE · not wired';
      liveBtn.title = 'Unlock present but place is not wired on this build';
      lockMsg.textContent = message || 'LIVE unlock present — place still not wired (safe).';
    } else {
      if (badge) badge.textContent = 'PAPER / WATCH';
      if (chip) chip.innerHTML = '<i></i> PAPER / WATCH';
      if (side) side.textContent = 'LIVE locked';
      liveBtn.disabled = true;
      liveBtn.textContent = 'LIVE · locked';
      liveBtn.title = 'Needs Kane LIVE OK';
      lockMsg.textContent = message || 'LIVE disabled until BITBOT_LIVE_OK. STOP ALL TRADING.';
    }
  }

  function applyDeskPayload(data) {
    if (!data || typeof data !== 'object') return false;
    let ok = false;
    if (data.live_trading != null || data.live_lock) {
      applyLiveLock(Boolean(data.live_trading), data.live_lock || '');
      ok = true;
    }
    if (Array.isArray(data.positions)) {
      renderPositions(data.positions);
      ok = true;
      showNotice('');
    }
    if (data.account) {
      renderAccount(data.account);
      ok = true;
    }
    if (Array.isArray(data.alerts) && data.alerts.length) {
      showNotice(data.alerts[0], data.stale ? 'warn' : 'warn');
    } else if (data.error) {
      showNotice(data.error, 'warn');
    }
    if (data.ts) {
      const d = new Date(data.ts);
      $('#desk-updated').textContent = `Updated ${d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })} UK`;
    }
    if (ok) {
      setConn(data.stale ? 'warn' : 'good', data.stale ? 'Stale' : 'Live');
    } else if (data.error) {
      setConn('warn', 'Offline');
    }
    return ok || Boolean(data.ok);
  }

  let deskSource = null;
  let deskPollTimer = null;
  let deskStreamHealthy = false;

  function stopDeskStream() {
    if (deskSource) {
      deskSource.close();
      deskSource = null;
    }
  }

  function startDeskPoll() {
    if (deskPollTimer) return;
    deskPollTimer = setInterval(() => {
      if (!deskStreamHealthy) refreshDesk();
    }, POLL_POS_MS);
  }

  function startDeskStream() {
    if (!('EventSource' in window)) {
      startDeskPoll();
      refreshDesk();
      return;
    }
    stopDeskStream();
    const url = new URL('api/desk/stream', document.baseURI);
    const current = new EventSource(url);
    deskSource = current;
    setConn('warn', 'Connecting');
    current.addEventListener('hello', () => {
      if (deskSource !== current) return;
      deskStreamHealthy = true;
      setConn('good', 'Live');
    });
    current.addEventListener('desk', (event) => {
      if (deskSource !== current) return;
      try {
        const data = JSON.parse(event.data);
        deskStreamHealthy = true;
        applyDeskPayload(data);
      } catch (err) {
        deskStreamHealthy = false;
        setConn('warn', 'Reconnecting');
      }
    });
    current.addEventListener('unavailable', () => {
      if (deskSource !== current) return;
      deskStreamHealthy = false;
      setConn('warn', 'Reconnecting');
      refreshDesk();
    });
    current.onerror = () => {
      if (deskSource !== current) return;
      deskStreamHealthy = false;
      setConn('warn', 'Reconnecting');
      startDeskPoll();
    };
    startDeskPoll();
    // Immediate REST fill while SSE connects
    refreshDesk();
  }

    async function refreshDesk() {
    try {
      setConn('warn', 'Connecting');
      const results = await Promise.allSettled([
        api('/api/health', { timeoutMs: 6000 }),
        api('/api/positions', { timeoutMs: 12000 }),
        api('/api/account', { timeoutMs: 12000 }),
      ]);
      const health = results[0].status === 'fulfilled' ? results[0].value.data : null;
      const pos = results[1].status === 'fulfilled' ? results[1].value.data : null;
      const acct = results[2].status === 'fulfilled' ? results[2].value.data : null;
      let okAny = false;
      if (health && health.ok) {
        applyLiveLock(health.live_trading, health.live_lock);
        okAny = true;
      }
      if (pos && pos.ok) {
        renderPositions(pos.positions || []);
        okAny = true;
        showNotice('');
      } else if (pos && pos.error) {
        showNotice(pos.error, 'warn');
      }
      if (acct && acct.ok) {
        renderAccount(acct.account);
        okAny = true;
      }
      const ts = (pos && pos.ts) || (acct && acct.ts);
      if (ts) {
        const d = new Date(ts);
        $('#desk-updated').textContent = `Updated ${d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })} UK`;
      }
      if (okAny) {
        setConn(pos && pos.stale ? 'warn' : 'good', pos && pos.stale ? 'Stale' : 'Live');
      } else {
        setConn('warn', 'Offline');
        const err = (pos && pos.error) || (acct && acct.error) || (health && health.error) || 'No data';
        showNotice(err, 'warn');
      }
    } catch (err) {
      setConn('warn', 'Offline');
      showNotice(String(err.message || err), 'warn');
    }
  }

  function ensureChart() {
    const el = $('#tv-chart');
    if (!el || state.chart || typeof LightweightCharts === 'undefined') return;
    state.chart = LightweightCharts.createChart(el, {
      layout: {
        background: { color: '#0f1519' },
        textColor: '#9aafa3',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      width: el.clientWidth,
      height: Math.max(360, Math.min(520, window.innerHeight * 0.55)),
    });
    state.series = state.chart.addCandlestickSeries({
      upColor: '#6dffb0',
      downColor: '#ff6b7a',
      borderUpColor: '#6dffb0',
      borderDownColor: '#ff6b7a',
      wickUpColor: '#6dffb0',
      wickDownColor: '#ff6b7a',
    });
    const ro = new ResizeObserver(() => {
      if (!state.chart) return;
      state.chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);
  }

  async function loadCandles(force) {
    if (state.view !== 'charts' && !force) return;
    ensureChart();
    if (!state.series) return;
    const key = `${state.symbol}|${state.tf}`;
    try {
      const { data } = await api(`/api/candles?symbol=${encodeURIComponent(state.symbol)}&category=${encodeURIComponent(state.category)}&granularity=${encodeURIComponent(state.tf)}&limit=300`);
      if (!data || !data.ok) {
        $('#chart-foot').textContent = (data && data.error) || 'Candles unavailable';
        return;
      }
      const bars = (data.candles || []).map((c) => ({
        time: Math.floor(Number(c.t) / 1000),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })).filter((b) => b.time && b.open != null);
      state.series.setData(bars);
      if (force || state.lastCandlesKey !== key) {
        state.chart.timeScale().fitContent();
        state.lastCandlesKey = key;
      }
      $('#chart-sym-label').textContent = state.symbol;
      $('#chart-foot').textContent = `${data.count} candles · ${data.granularity} · Bitget ${data.category}`;
    } catch (err) {
      $('#chart-foot').textContent = String(err.message || err);
    }
  }

  async function loadTicker() {
    try {
      const { data } = await api(`/api/ticker?symbol=${encodeURIComponent(state.symbol)}&category=${encodeURIComponent(state.category)}`);
      if (!data || !data.ok) return;
      $('#chart-last').textContent = fmtPx(data.mark || data.last);
      const chg = $('#chart-chg');
      chg.textContent = fmtPct(data.change24h);
      chg.className = `chg ${pnlClass(data.change24h)}`;
      if (state.series && (data.mark || data.last) != null) {
        try {
          state.series.applyOptions({
            priceLineVisible: true,
          });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  function ticketBody() {
    const sizeVal = Number($('#t-size').value);
    const body = {
      symbol: $('#t-symbol').value,
      category: $('#t-category').value || 'USDT-FUTURES',
      side: state.side,
      order_type: $('#t-type').value,
      leverage: Number($('#t-leverage').value) || 1,
      margin_mode: 'crossed',
    };
    if ($('#t-type').value === 'limit') {
      body.price = Number($('#t-price').value);
    }
    if (state.sizeMode === 'usdt') body.notional = sizeVal;
    else body.size = sizeVal;
    const tp = $('#t-tp').value;
    const sl = $('#t-sl').value;
    if (tp) body.tp = Number(tp);
    if (sl) body.sl = Number(sl);
    return body;
  }

  function renderPreview(data) {
    const box = $('#trade-preview');
    if (!data || !data.ok || !data.preview) {
      box.className = 'trade-preview error';
      box.textContent = (data && data.error) || 'Preview failed';
      return;
    }
    const p = data.preview;
    box.className = 'trade-preview';
    box.innerHTML = `
      <div class="prev-grid">
        <div><span>Side</span><strong class="${p.side}">${p.side.toUpperCase()}</strong></div>
        <div><span>Type</span><strong>${p.order_type}</strong></div>
        <div><span>Size</span><strong>${fmt(p.size, 6)} ${p.symbol.replace('USDT','')}</strong></div>
        <div><span>Notional</span><strong>$${fmt(p.notional)}</strong></div>
        <div><span>Margin est.</span><strong>$${fmt(p.margin_estimate)}</strong></div>
        <div><span>Ref / mark</span><strong>${fmtPx(p.ref_price)} / ${fmtPx(p.mark)}</strong></div>
        <div><span>Liq est.</span><strong>${fmtPx(p.liq_estimate)}</strong></div>
        <div><span>TP / SL</span><strong>${fmtPx(p.tp)} / ${fmtPx(p.sl)}</strong></div>
      </div>
      <p class="prev-note">${p.note || 'Dry-run only.'}</p>`;
  }

  async function onSimulate(ev) {
    ev.preventDefault();
    const box = $('#trade-preview');
    box.className = 'trade-preview';
    box.textContent = 'Simulating…';
    try {
      const { res, data } = await api('/api/trade/preview', {
        method: 'POST',
        body: JSON.stringify(ticketBody()),
      });
      if (!res.ok && data && data.error) {
        box.className = 'trade-preview error';
        box.textContent = data.error;
        return;
      }
      renderPreview(data);
    } catch (err) {
      box.className = 'trade-preview error';
      box.textContent = String(err.message || err);
    }
  }

  async function onLiveClick() {
    const box = $('#trade-preview');
    box.className = 'trade-preview';
    box.textContent = 'Checking LIVE gate…';
    try {
      const { res, data } = await api('/api/trade/place', {
        method: 'POST',
        body: JSON.stringify(ticketBody()),
      });
      box.className = 'trade-preview error';
      box.textContent = (data && (data.error || data.live_lock)) || `HTTP ${res.status}`;
    } catch (err) {
      box.className = 'trade-preview error';
      box.textContent = String(err.message || err);
    }
  }

  function wireTrade() {
    $$('.side-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.side = btn.dataset.side;
        $$('.side-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
    $$('.size-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sizeMode = btn.dataset.sizeMode;
        $$('.size-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
        $('#t-size-label').textContent = state.sizeMode === 'usdt' ? 'Notional (USDT)' : 'Size (coins)';
      });
    });
    $('#t-type').addEventListener('change', () => {
      $('#t-price-wrap').hidden = $('#t-type').value !== 'limit';
    });
    $('#trade-form').addEventListener('submit', onSimulate);
    $('#btn-live').addEventListener('click', onLiveClick);
  }

  function wireNav() {
    $$('.nav-link').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const v = a.dataset.view;
        location.hash = v;
        setView(v);
      });
    });
    window.addEventListener('hashchange', () => setView(hashView()));
    $('#refresh').addEventListener('click', () => {
      refreshDesk();
      if (state.view === 'charts') {
        loadCandles(true);
        loadTicker();
      }
    });
    $('#tf-switch').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-tf]');
      if (!btn) return;
      state.tf = btn.dataset.tf;
      $$('#tf-switch button').forEach((b) => b.classList.toggle('active', b === btn));
      loadCandles(true);
    });
  }

  function boot() {
    paintIcons();
    wireNav();
    wireTrade();
    buildSymbolSwitch();
    setView(hashView());
    ukClock();
    setInterval(ukClock, 1000);
    startDeskStream();
    window.addEventListener('pagehide', stopDeskStream);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !deskStreamHealthy) startDeskStream();
    });
    setInterval(() => {
      if (state.view === 'charts') loadTicker();
    }, POLL_TICK_MS);
    setInterval(() => {
      if (state.view === 'charts') loadCandles(false);
    }, POLL_CANDLE_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
