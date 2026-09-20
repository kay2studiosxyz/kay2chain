'use strict';
(() => {
  const BASE = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'];
  const POLL_POS_MS = 3000;
  const POLL_TICK_MS = 2000;
  const POLL_CANDLE_MS = 15000;

  const state = {
    view: 'portfolio',
    positions: [],
    account: null,
    symbol: 'SOLUSDT',
    category: 'USDT-FUTURES',
    tf: '15m',
    side: 'long',
    sizeMode: 'usdt',
    liveUnlocked: false,
    chart: null,
    series: null,
    lastCandlesKey: '',
    bars: [],
    fills: [],
    lastMark: null,
    previewTimer: null,
    equityChart: null,
    equitySeries: null,
    equityTicks: [],
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
    if (name === 'overview') name = 'portfolio';
    state.view = name;
    $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
    $$('.view').forEach((p) => {
      const on = p.dataset.panel === name;
      p.hidden = !on;
    });
    const titles = {
      portfolio: ['Portfolio', 'Balances, margin, and open UTA positions.'],
      charts: ['Markets', 'Bitget candles · near-realtime mark.'],
      trade: ['Trade', 'Exchange ticket · available USDT, leverage & size sliders.'],
    };
    const [t, d] = titles[name] || titles.portfolio;
    if ($('#page-title')) $('#page-title').textContent = t;
    if ($('#page-description')) $('#page-description').textContent = d;
    if ($('#crumb')) $('#crumb').textContent = t;
    if (name === 'charts') {
      ensureChart();
      loadCandles(true);
    }
    if (name === 'portfolio') {
      ensureEquityChart();
    }
    if (name === 'trade') {
      paintTradeBalances();
      refreshTradeMark();
      updateSideAction();
    }
  }

  function hashView() {
    let h = (location.hash || '#portfolio').replace('#', '');
    if (h === 'overview') h = 'portfolio';
    return ['portfolio', 'charts', 'trade'].includes(h) ? h : 'portfolio';
  }

  function usdtAsset(acct) {
    return ((acct && acct.assets) || []).find((a) => a.coin === 'USDT') || null;
  }

  function availableUsdt() {
    const usdt = usdtAsset(state.account);
    return usdt && usdt.available != null ? Number(usdt.available) : 0;
  }

  function paintTradeBalances() {
    const acct = state.account;
    const availEl = $('#t-avail-usdt');
    if (!availEl) return;
    if (!acct) {
      availEl.textContent = '—';
      if ($('#t-equity')) $('#t-equity').textContent = '—';
      if ($('#t-balance')) $('#t-balance').textContent = '—';
      if ($('#t-max-notional')) $('#t-max-notional').textContent = '—';
      if ($('#t-max-line')) $('#t-max-line').textContent = '—';
      return;
    }
    const usdt = usdtAsset(acct);
    const avail = usdt && usdt.available != null ? Number(usdt.available) : null;
    const bal = usdt && usdt.balance != null ? Number(usdt.balance) : null;
    const lev = Number(($('#t-leverage') || {}).value) || 5;
    availEl.textContent = avail != null ? fmt(avail) : '—';
    if ($('#t-equity')) $('#t-equity').textContent = acct.equity != null ? `$${fmt(acct.equity)}` : '—';
    if ($('#t-balance')) $('#t-balance').textContent = bal != null ? `$${fmt(bal)}` : '—';
    const maxNotional = avail != null ? avail * lev : null;
    if ($('#t-max-notional')) $('#t-max-notional').textContent = maxNotional != null ? `$${fmt(maxNotional)}` : '—';
    if ($('#t-max-line')) $('#t-max-line').textContent = maxNotional != null ? `$${fmt(maxNotional)}` : '—';
    updateCostStrip();
  }

  const EQ_STORE = 'bitbot.equity.ticks';
  const EQ_MAX = 360;

  function loadEquityTicks() {
    try {
      const raw = sessionStorage.getItem(EQ_STORE);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) state.equityTicks = parsed.filter((p) => p && p.t && p.v != null);
    } catch {
      state.equityTicks = [];
    }
  }

  function saveEquityTicks() {
    try {
      sessionStorage.setItem(EQ_STORE, JSON.stringify(state.equityTicks.slice(-EQ_MAX)));
    } catch { /* ignore quota */ }
  }

  function flash(el, dir) {
    if (!el) return;
    el.classList.remove('tick-up', 'tick-down');
    void el.offsetWidth;
    el.classList.add(dir === 'up' ? 'tick-up' : 'tick-down');
  }

  function ensureEquityChart() {
    const el = $('#pnl-chart');
    if (!el || state.equityChart || typeof LightweightCharts === 'undefined') return;
    loadEquityTicks();
    state.equityChart = LightweightCharts.createChart(el, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8aa094',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
      width: el.clientWidth || 320,
      height: 168,
    });
    state.equitySeries = state.equityChart.addAreaSeries({
      lineColor: '#6dffb0',
      topColor: 'rgba(109, 255, 176, 0.28)',
      bottomColor: 'rgba(109, 255, 176, 0.02)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    if (state.equityTicks.length) {
      state.equitySeries.setData(state.equityTicks.map((p) => ({ time: p.t, value: p.v })));
      state.equityChart.timeScale().fitContent();
    }
    const ro = new ResizeObserver(() => {
      if (!state.equityChart) return;
      state.equityChart.applyOptions({ width: el.clientWidth || 320 });
    });
    ro.observe(el);
  }

  function pushEquityTick(acct) {
    ensureEquityChart();
    const eqEl = $('#pnl-equity');
    const upEl = $('#pnl-upnl');
    if (!acct || acct.equity == null) {
      if (eqEl) eqEl.textContent = '—';
      if (upEl) upEl.textContent = '—';
      return;
    }
    const equity = Number(acct.equity);
    const upnl = acct.unrealised_pnl != null ? Number(acct.unrealised_pnl) : null;
    if (eqEl) {
      const prev = eqEl.dataset.raw;
      eqEl.textContent = `$${fmt(equity)}`;
      eqEl.dataset.raw = String(equity);
      if (prev != null && Number(prev) !== equity) flash(eqEl, equity >= Number(prev) ? 'up' : 'down');
    }
    if (upEl) {
      upEl.textContent = money(upnl);
      upEl.className = `pnl-chip ${pnlClass(upnl)}`;
    }
    const now = Math.floor(Date.now() / 1000);
    const last = state.equityTicks[state.equityTicks.length - 1];
    if (last && last.t === now) last.v = equity;
    else if (!last || last.v !== equity || now - last.t >= 1) state.equityTicks.push({ t: now, v: equity });
    if (state.equityTicks.length > EQ_MAX) state.equityTicks = state.equityTicks.slice(-EQ_MAX);
    saveEquityTicks();
    if (state.equitySeries && state.equityTicks.length) {
      const data = state.equityTicks.map((p) => ({ time: p.t, value: p.v }));
      state.equitySeries.setData(data);
      const start = state.equityTicks[0].v;
      const end = state.equityTicks[state.equityTicks.length - 1].v;
      const up = end >= start;
      state.equitySeries.applyOptions({
        lineColor: up ? '#6dffb0' : '#ff6b7a',
        topColor: up ? 'rgba(109, 255, 176, 0.28)' : 'rgba(255, 107, 122, 0.28)',
        bottomColor: up ? 'rgba(109, 255, 176, 0.02)' : 'rgba(255, 107, 122, 0.02)',
      });
      state.equityChart.timeScale().fitContent();
    }
  }

  function setText(id, value, className) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    el.textContent = value;
    if (className !== undefined) el.className = className;
  }

  function renderAssets(acct) {
    const body = $('#assets-body');
    if (!body) return;
    const assets = (acct && acct.assets) || [];
    if (!assets.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-cell">No assets.</td></tr>';
      return;
    }
    body.innerHTML = assets.map((a) => `<tr>
      <td class="coin"><strong>${a.coin || '—'}</strong></td>
      <td>${a.equity != null ? fmt(a.equity, 4) : '—'}</td>
      <td>${a.available != null ? fmt(a.available, 4) : '—'}</td>
      <td>${a.balance != null ? fmt(a.balance, 4) : '—'}</td>
      <td>${a.usd_value != null ? '$' + fmt(a.usd_value) : '—'}</td>
    </tr>`).join('');
  }

  function renderMargin(acct) {
    if (!acct) {
      ['m-used', 'm-buffer', 'm-imr', 'm-mmr', 'm-eff', 'm-upnl'].forEach((id) => setText(id, '—'));
      const usedBar = $('#m-used-bar');
      const bufBar = $('#m-buffer-bar');
      if (usedBar) usedBar.style.width = '0%';
      if (bufBar) bufBar.style.width = '0%';
      return;
    }
    const imr = acct.imr != null ? Number(acct.imr) : null;
    const mmr = acct.mmr != null ? Number(acct.mmr) : null;
    const usedPct = imr != null ? Math.max(0, Math.min(100, imr * 100)) : 0;
    const bufferPct = mmr != null ? Math.max(0, Math.min(100, (1 - mmr) * 100)) : 0;
    setText('m-used', imr != null ? `${fmt(usedPct, 1)}%` : '—');
    setText('m-buffer', mmr != null ? `${fmt(bufferPct, 1)}%` : '—');
    setText('m-imr', imr != null ? fmt(imr, 4) : '—');
    setText('m-mmr', mmr != null ? fmt(mmr, 4) : '—');
    setText('m-eff', acct.eff_equity != null ? `$${fmt(acct.eff_equity)}` : (acct.equity != null ? `$${fmt(acct.equity)}` : '—'));
    const upEl = $('#m-upnl');
    if (upEl) {
      upEl.textContent = money(acct.unrealised_pnl);
      upEl.className = pnlClass(acct.unrealised_pnl);
    }
    const usedBar = $('#m-used-bar');
    const bufBar = $('#m-buffer-bar');
    if (usedBar) usedBar.style.width = `${usedPct}%`;
    if (bufBar) bufBar.style.width = `${bufferPct}%`;
  }

  function renderAccount(acct) {
    state.account = acct;
    const usdt = usdtAsset(acct);
    const avail = usdt && usdt.available != null ? usdt.available : null;
    const upnl = acct && acct.unrealised_pnl;
    const mmr = acct && acct.mmr != null ? fmt(acct.mmr, 2) : '—';
    const imr = acct && acct.imr != null ? fmt(acct.imr, 2) : '—';

    if (!acct) {
      ['acct-equity', 'top-equity', 'side-equity', 'acct-upnl', 'top-upnl',
       'acct-avail', 'top-avail', 'side-avail', 'acct-mmr', 'top-mmr',
       'acct-posval', 'acct-lev'].forEach((id) => setText(id, '—'));
      renderAssets(null);
      renderMargin(null);
      paintTradeBalances();
      return;
    }

    const eq = acct.equity != null ? `$${fmt(acct.equity)}` : '—';
    const av = avail != null ? `$${fmt(avail)}` : '—';
    const avPlain = avail != null ? fmt(avail) : '—';
    setText('acct-equity', eq);
    setText('top-equity', eq);
    setText('side-equity', eq);
    setText('acct-avail', av);
    setText('top-avail', av);
    setText('side-avail', avPlain);
    setText('acct-mmr', `${mmr} / ${imr}`);
    setText('top-mmr', mmr);
    setText('acct-posval', acct.position_value != null ? `$${fmt(acct.position_value)}` : '—');
    setText('acct-lev', acct.leverage != null ? `${fmt(acct.leverage, 2)}×` : '—');

    ['acct-upnl', 'top-upnl'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = money(upnl);
      el.className = pnlClass(upnl);
    });

    renderAssets(acct);
    renderMargin(acct);
    pushEquityTick(acct);
    paintTradeBalances();
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

  function goChart(sym) {
    state.symbol = sym;
    location.hash = 'charts';
    setView('charts');
    buildSymbolSwitch();
    loadCandles(true);
    loadTicker();
  }

  function goTrade(sym) {
    ensureSymbolOption(sym);
    const sel = $('#t-symbol');
    if (sel) sel.value = sym;
    location.hash = 'trade';
    setView('trade');
  }

  function positionRow(p) {
    const side = (p.side || '').toLowerCase();
    const upnl = p.unrealised_pnl;
    const roe = p.pnl_pct;
    return `<tr class="pos-row ${side}">
      <td class="contract"><strong>${p.symbol || '—'}</strong><span>${p.leverage != null ? fmt(p.leverage, 0) + '×' : ''} ${p.margin_mode || ''}</span></td>
      <td><span class="side-pill ${side}">${side || '—'}</span></td>
      <td>${fmt(p.size, 4)}</td>
      <td>${fmtPx(p.entry)}</td>
      <td class="mark">${fmtPx(p.mark)}</td>
      <td>${fmtPx(p.liq)}</td>
      <td>${p.margin != null ? '$' + fmt(p.margin) : '—'}</td>
      <td class="${pnlClass(upnl)}">${money(upnl)}</td>
      <td class="${pnlClass(roe)}">${fmtPct(roe)}</td>
      <td class="pos-actions">
        <button type="button" class="text-button" data-chart-sym="${p.symbol}">Chart</button>
        <button type="button" class="text-button" data-trade-sym="${p.symbol}">Trade</button>
      </td>
    </tr>`;
  }

  function wirePosActions(root) {
    if (!root) return;
    root.querySelectorAll('[data-chart-sym]').forEach((btn) => {
      btn.addEventListener('click', () => goChart(btn.dataset.chartSym));
    });
    root.querySelectorAll('[data-trade-sym]').forEach((btn) => {
      btn.addEventListener('click', () => goTrade(btn.dataset.tradeSym));
    });
  }

  function renderPositions(list) {
    state.positions = list || [];
    const root = $('#positions-hero');
    const body = $('#positions-body');
    if ($('#nav-pos')) $('#nav-pos').textContent = String(state.positions.length || 0);
    if ($('#pos-count')) $('#pos-count').textContent = `${state.positions.length} open`;
    if (!state.positions.length) {
      if (root) root.innerHTML = '<div class="empty-pos card">No open UTA positions.</div>';
      if (body) body.innerHTML = '<tr><td colspan="10" class="empty-cell">No open positions.</td></tr>';
      syncTradeSymbols();
      return;
    }
    if (body) body.innerHTML = state.positions.map(positionRow).join('');
    if (root) root.innerHTML = state.positions.map(positionCard).join('');
    wirePosActions(body);
    wirePosActions(root);
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

  function snapFillToBar(timeSec, bars) {
    if (!bars.length) return null;
    let best = bars[0].time;
    for (let i = 0; i < bars.length; i += 1) {
      const t = bars[i].time;
      if (t <= timeSec) best = t;
      else break;
    }
    // Prefer nearest bar within one timeframe window
    let nearest = best;
    let bestDist = Math.abs(timeSec - best);
    for (const b of bars) {
      const d = Math.abs(timeSec - b.time);
      if (d < bestDist) {
        bestDist = d;
        nearest = b.time;
      }
    }
    return nearest;
  }

  function buildTradeMarkers(fills, bars) {
    if (!fills.length || !bars.length) return [];
    const markers = [];
    const used = new Map(); // time -> count for slight stacking via text
    for (const fill of fills) {
      const rawT = Number(fill.time || Math.floor(Number(fill.ts_ms) / 1000));
      if (!Number.isFinite(rawT)) continue;
      const t = snapFillToBar(rawT, bars);
      if (t == null) continue;
      const side = String(fill.side || '').toLowerCase();
      const isBuy = side === 'buy';
      const isSell = side === 'sell';
      if (!isBuy && !isSell) continue;
      const n = (used.get(t) || 0) + 1;
      used.set(t, n);
      const px = fill.price != null ? fmtPx(fill.price) : '';
      const qty = fill.qty != null ? fmt(fill.qty, 4) : '';
      const label = isBuy ? 'BUY' : 'SELL';
      const detail = [label, px, qty ? `×${qty}` : ''].filter(Boolean).join(' ');
      markers.push({
        time: t,
        position: isBuy ? 'belowBar' : 'aboveBar',
        color: isBuy ? '#6dffb0' : '#ff6b7a',
        shape: 'circle',
        text: n > 1 ? `${label}·${n}` : label,
        size: 1.2,
        id: fill.id || `${t}-${label}-${n}`,
        _detail: detail,
      });
    }
    markers.sort((a, b) => a.time - b.time || a.position.localeCompare(b.position));
    return markers;
  }

  function paintTradeMarkers() {
    if (!state.series) return;
    const markers = buildTradeMarkers(state.fills, state.bars);
    try {
      state.series.setMarkers(markers);
    } catch (err) {
      console.warn('setMarkers failed', err);
    }
    const legend = $('#chart-bubbles');
    if (legend) {
      const buys = state.fills.filter((f) => f.side === 'buy').length;
      const sells = state.fills.filter((f) => f.side === 'sell').length;
      legend.hidden = !(buys || sells);
      legend.innerHTML = `
        <span class="bubble buy"><i></i> Buy ${buys}</span>
        <span class="bubble sell"><i></i> Sell ${sells}</span>
      `;
    }
  }

  async function loadFills() {
    try {
      const { data } = await api(
        `/api/fills?symbol=${encodeURIComponent(state.symbol)}&category=${encodeURIComponent(state.category)}&limit=100`,
        { timeoutMs: 12000 },
      );
      if (!data || !data.ok) {
        state.fills = [];
        paintTradeMarkers();
        return;
      }
      state.fills = data.fills || [];
      paintTradeMarkers();
    } catch {
      /* keep prior markers */
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
      state.bars = bars;
      state.series.setData(bars);
      if (force || state.lastCandlesKey !== key) {
        state.chart.timeScale().fitContent();
        state.lastCandlesKey = key;
      }
      $('#chart-sym-label').textContent = state.symbol;
      $('#chart-foot').textContent = `${data.count} candles · ${data.granularity} · Bitget ${data.category}`;
      // Buy/sell bubbles from recent Bitget fills (snap to bars)
      paintTradeMarkers();
      loadFills();
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

  function updateSideAction() {
    const btn = $('#btn-simulate');
    if (!btn) return;
    const long = state.side === 'long';
    btn.textContent = long ? 'Buy / Long' : 'Sell / Short';
    btn.classList.toggle('long', long);
    btn.classList.toggle('short', !long);
    const ticket = $('#trade-form');
    if (ticket) ticket.dataset.side = state.side;
  }

  function updateCostStrip() {
    const levEl = $('#t-leverage');
    const lev = Number(levEl && levEl.value) || 1;
    const avail = availableUsdt();
    const sizeEl = $('#t-size');
    const sizeVal = Number(sizeEl && sizeEl.value) || 0;
    let margin = 0;
    if (state.sizeMode === 'usdt') margin = lev > 0 ? sizeVal / lev : 0;
    else {
      const mark = state.lastMark || 0;
      margin = lev > 0 ? (sizeVal * mark) / lev : 0;
    }
    const costEl = $('#t-cost');
    if (costEl) costEl.textContent = margin > 0 ? `$${fmt(margin)}` : '—';
    const mark = state.lastMark;
    const liqEl = $('#t-liq-est');
    if (liqEl && mark && lev > 1) {
      const move = (1 / lev) * 0.85;
      const liq = state.side === 'long' ? mark * (1 - move) : mark * (1 + move);
      liqEl.textContent = fmtPx(liq);
    } else if (liqEl) liqEl.textContent = '—';
    const maxNotional = avail * lev;
    if ($('#t-max-line')) $('#t-max-line').textContent = maxNotional > 0 ? `$${fmt(maxNotional)}` : '—';
    if ($('#t-max-notional')) $('#t-max-notional').textContent = maxNotional > 0 ? `$${fmt(maxNotional)}` : '—';
  }

  function setSizeFromPercent(pct) {
    const avail = availableUsdt();
    const lev = Number($('#t-leverage').value) || 1;
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    $('#t-pct-range').value = String(clamped);
    $('#t-pct-readout').textContent = String(Math.round(clamped));
    if (state.sizeMode === 'usdt') {
      const margin = avail * (clamped / 100);
      const notional = margin * lev;
      $('#t-size').value = notional > 0 ? String(Number(notional.toFixed(4))) : '';
    } else {
      const mark = state.lastMark || 0;
      const margin = avail * (clamped / 100);
      const notional = margin * lev;
      const coins = mark > 0 ? notional / mark : 0;
      $('#t-size').value = coins > 0 ? String(Number(coins.toFixed(6))) : '';
    }
    updateCostStrip();
    queuePreview();
  }

  function syncPercentFromSize() {
    const avail = availableUsdt();
    const lev = Number($('#t-leverage').value) || 1;
    const sizeVal = Number($('#t-size').value) || 0;
    let margin = 0;
    if (state.sizeMode === 'usdt') margin = lev > 0 ? sizeVal / lev : 0;
    else {
      const mark = state.lastMark || 0;
      margin = lev > 0 ? (sizeVal * mark) / lev : 0;
    }
    const pct = avail > 0 ? Math.max(0, Math.min(100, (margin / avail) * 100)) : 0;
    $('#t-pct-range').value = String(Math.round(pct));
    $('#t-pct-readout').textContent = String(Math.round(pct));
    updateCostStrip();
  }

  function queuePreview() {
    if (state.previewTimer) clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(() => {
      const sizeVal = Number($('#t-size').value);
      if (!sizeVal || sizeVal <= 0) return;
      onSimulate({ preventDefault() {} });
    }, 450);
  }

  async function refreshTradeMark() {
    try {
      const sym = ($('#t-symbol') && $('#t-symbol').value) || state.symbol;
      const { data } = await api(`/api/ticker?symbol=${encodeURIComponent(sym)}&category=${encodeURIComponent(state.category)}`);
      if (!data || !data.ok) return;
      state.lastMark = data.mark || data.last;
      if ($('#t-mark')) $('#t-mark').textContent = fmtPx(state.lastMark);
      updateCostStrip();
    } catch { /* ignore */ }
  }

  function wireTrade() {
    $$('.side-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.side = btn.dataset.side;
        $$('.side-btn').forEach((b) => b.classList.toggle('active', b === btn));
        updateSideAction();
        updateCostStrip();
        queuePreview();
      });
    });
    $$('.size-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prev = state.sizeMode;
        state.sizeMode = btn.dataset.sizeMode;
        $$('.size-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
        $('#t-size-label').textContent = state.sizeMode === 'usdt' ? 'Amount (USDT)' : 'Size (coins)';
        if ($('#t-size-suffix')) {
          $('#t-size-suffix').textContent = state.sizeMode === 'usdt'
            ? 'USDT'
            : ($('#t-symbol').value || 'COIN').replace('USDT', '');
        }
        const mark = state.lastMark || 0;
        const val = Number($('#t-size').value) || 0;
        if (val > 0 && mark > 0 && prev !== state.sizeMode) {
          if (state.sizeMode === 'usdt') $('#t-size').value = String(Number((val * mark).toFixed(4)));
          else $('#t-size').value = String(Number((val / mark).toFixed(6)));
        }
        syncPercentFromSize();
        queuePreview();
      });
    });
    $('#t-type').addEventListener('change', () => {
      $('#t-price-wrap').hidden = $('#t-type').value !== 'limit';
      queuePreview();
    });
    const levRange = $('#t-leverage-range');
    const levHidden = $('#t-leverage');
    if (levRange && levHidden) {
      levRange.addEventListener('input', () => {
        levHidden.value = levRange.value;
        if ($('#t-lev-readout')) $('#t-lev-readout').textContent = levRange.value;
        setSizeFromPercent($('#t-pct-range').value);
      });
    }
    if ($('#t-pct-range')) {
      $('#t-pct-range').addEventListener('input', () => setSizeFromPercent($('#t-pct-range').value));
    }
    $$('.pct-chips button').forEach((btn) => {
      btn.addEventListener('click', () => setSizeFromPercent(btn.dataset.pct));
    });
    if ($('#t-size')) {
      $('#t-size').addEventListener('input', () => {
        syncPercentFromSize();
        queuePreview();
      });
    }
    if ($('#t-symbol')) {
      $('#t-symbol').addEventListener('change', () => {
        state.symbol = $('#t-symbol').value;
        if ($('#t-size-suffix')) {
          $('#t-size-suffix').textContent = state.sizeMode === 'usdt'
            ? 'USDT'
            : state.symbol.replace('USDT', '');
        }
        refreshTradeMark();
        queuePreview();
      });
    }
    ['t-tp', 't-sl', 't-price'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', queuePreview);
    });
    $('#trade-form').addEventListener('submit', onSimulate);
    $('#btn-live').addEventListener('click', onLiveClick);
    updateSideAction();
    paintTradeBalances();
    refreshTradeMark();
  }

  function wireArt() {
    const dlg = $('#art-dialog');
    const openBtn = $('#view-art');
    const closeBtn = $('#art-dialog-close');
    if (!dlg || !openBtn) return;
    openBtn.addEventListener('click', () => {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
    if (closeBtn) closeBtn.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) dlg.close();
    });
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
    loadEquityTicks();
    wireArt();
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
