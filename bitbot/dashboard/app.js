'use strict';
(() => {
  const BASE = ['SOLUSDT', 'HYPEUSDT', 'BTCUSDT', 'ETHUSDT'];
  const POLL_POS_MS = 3000;
  const POLL_TICK_MS = 2000;
  const POLL_CANDLE_MS = 15000;
  const POLL_BOOK_MS = 900;
  const POLL_TAPE_MS = 1500;

  const state = {
    view: 'trade',
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
    posLines: [],
    lastCandlesKey: '',
    bars: [],
    fills: [],
    lastMark: null,
    previewTimer: null,
    equityChart: null,
    equitySeries: null,
    equityTicks: [],
    switcherSig: '',
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
    if (name === 'charts') name = 'trade';
    state.view = name;
    $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
    $$('.view').forEach((p) => {
      const on = p.dataset.panel === name;
      p.hidden = !on;
    });
    const titles = {
      portfolio: ['Portfolio', 'Balances, margin, and live UTA positions.'],
      trade: ['Trade', 'Custom Bitget perps desk · SOL, HYPE, and the rest of the book.'],
    };
    const [t, d] = titles[name] || titles.trade;
    if ($('#page-title') && name === 'portfolio') $('#page-title').textContent = t;
    if ($('#page-description') && name === 'portfolio') $('#page-description').textContent = d;
    if ($('#crumb')) $('#crumb').textContent = t;
    if (name === 'portfolio') {
      ensureEquityChart();
    }
    if (name === 'portfolio' && isPhone()) closeSheet();
    if (name === 'trade') {
      paintTradeBalances();
      refreshTradeMark();
      updateSideAction();
      paintActionBar();
      ensureChart();
      loadCandles(true);
      loadTicker();
      loadOrderbook();
      loadTape();
    }
  }

  function hashView() {
    let h = (location.hash || '#trade').replace('#', '');
    if (h === 'overview') h = 'portfolio';
    if (h === 'charts') h = 'trade';
    return ['portfolio', 'trade'].includes(h) ? h : 'trade';
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

  const EQ_STORE = 'bitbot.pnl.ticks';
  const EQ_MAX = 360;

  function loadEquityTicks() {
    try {
      const raw = localStorage.getItem(EQ_STORE) || sessionStorage.getItem(EQ_STORE);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        state.equityTicks = parsed.filter((p) => p && p.t != null && p.v != null);
      }
    } catch {
      state.equityTicks = [];
    }
  }

  function saveEquityTicks() {
    const payload = JSON.stringify(state.equityTicks.slice(-EQ_MAX));
    try { localStorage.setItem(EQ_STORE, payload); } catch { /* ignore */ }
    try { sessionStorage.setItem(EQ_STORE, payload); } catch { /* ignore */ }
  }

  function flash(el, dir) {
    if (!el) return;
    el.classList.remove('tick-up', 'tick-down');
    void el.offsetWidth;
    el.classList.add(dir === 'up' ? 'tick-up' : 'tick-down');
  }

  function ingestPnlHistory(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const mapped = rows
      .map((row) => ({
        t: Math.floor(Number(row.t || row.time || 0)),
        v: row.upnl != null ? Number(row.upnl) : Number(row.v),
        e: row.equity != null ? Number(row.equity) : null,
      }))
      .filter((p) => Number.isFinite(p.t) && p.t > 0 && Number.isFinite(p.v));
    if (!mapped.length) return;
    const byTime = new Map(state.equityTicks.map((p) => [p.t, p]));
    mapped.forEach((p) => byTime.set(p.t, p));
    state.equityTicks = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-EQ_MAX);
    saveEquityTicks();
    paintPnlSeries();
  }

  function ensureEquityChart() {
    const el = $('#pnl-chart');
    if (!el) return;
    if (typeof LightweightCharts === 'undefined') {
      setTimeout(ensureEquityChart, 200);
      return;
    }
    if (state.equityChart) {
      state.equityChart.applyOptions({ width: el.clientWidth || 320 });
      paintPnlSeries();
      return;
    }
    loadEquityTicks();
    const height = Math.max(180, Math.min(240, Math.round(el.clientWidth * 0.42) || 200));
    state.equityChart = LightweightCharts.createChart(el, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8aa094',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Magnet },
      handleScroll: false,
      handleScale: false,
      width: el.clientWidth || 320,
      height,
    });
    state.equitySeries = state.equityChart.addAreaSeries({
      lineColor: '#6dffb0',
      topColor: 'rgba(109, 255, 176, 0.28)',
      bottomColor: 'rgba(109, 255, 176, 0.02)',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    paintPnlSeries();
    const ro = new ResizeObserver(() => {
      if (!state.equityChart) return;
      state.equityChart.applyOptions({
        width: el.clientWidth || 320,
        height: Math.max(180, Math.min(240, Math.round(el.clientWidth * 0.42) || 200)),
      });
    });
    ro.observe(el);
  }

  function paintPnlSeries() {
    if (!state.equitySeries || !state.equityTicks.length) return;
    const data = state.equityTicks.map((p) => ({ time: p.t, value: p.v }));
    state.equitySeries.setData(data);
    const end = state.equityTicks[state.equityTicks.length - 1].v;
    const up = Number(end) >= 0;
    state.equitySeries.applyOptions({
      lineColor: up ? '#6dffb0' : '#ff6b7a',
      topColor: up ? 'rgba(109, 255, 176, 0.28)' : 'rgba(255, 107, 122, 0.28)',
      bottomColor: up ? 'rgba(109, 255, 176, 0.02)' : 'rgba(255, 107, 122, 0.02)',
    });
    state.equityChart.timeScale().fitContent();
  }

  function paintPnlHero(equity, upnl) {
    const eqEl = $('#pnl-equity');
    const upEl = $('#pnl-upnl');
    const roeEl = $('#pnl-roe');
    if (eqEl) eqEl.textContent = equity != null ? `$${fmt(equity)}` : '—';
    if (upEl) {
      const prev = upEl.dataset.raw;
      upEl.textContent = money(upnl);
      upEl.className = pnlClass(upnl);
      upEl.dataset.raw = upnl == null ? '' : String(upnl);
      if (prev && upnl != null && Number(prev) !== Number(upnl)) {
        flash(upEl, Number(upnl) >= Number(prev) ? 'up' : 'down');
      }
    }
    if (roeEl) {
      if (equity != null && upnl != null) {
        const basis = Number(equity) - Number(upnl);
        roeEl.textContent = Math.abs(basis) > 0.01 ? fmtPct((Number(upnl) / basis) * 100) : '—';
        roeEl.className = pnlClass(upnl);
      } else {
        roeEl.textContent = '—';
      }
    }
  }

  function pushEquityTick(acct) {
    ensureEquityChart();
    if (!acct || (acct.equity == null && acct.unrealised_pnl == null)) {
      paintPnlHero(null, null);
      return;
    }
    const equity = acct.equity != null ? Number(acct.equity) : null;
    const upnl = acct.unrealised_pnl != null ? Number(acct.unrealised_pnl) : 0;
    paintPnlHero(equity, upnl);
    const now = Math.floor(Date.now() / 1000);
    if (!state.equityTicks.length) {
      state.equityTicks.push({ t: now - 90, v: 0, e: equity != null ? equity - upnl : null });
    }
    const last = state.equityTicks[state.equityTicks.length - 1];
    if (last && last.t === now) {
      last.v = upnl;
      last.e = equity;
    } else {
      state.equityTicks.push({ t: now, v: upnl, e: equity });
    }
    if (state.equityTicks.length > EQ_MAX) state.equityTicks = state.equityTicks.slice(-EQ_MAX);
    saveEquityTicks();
    paintPnlSeries();
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

  function pairLabel(sym) {
    return String(sym || '').replace(/USDT$/i, '').replace(/USDC$/i, '') || sym;
  }

  function currentPosition(sym) {
    const want = sym || state.symbol;
    return state.positions.find((p) => p && p.symbol === want) || null;
  }

  function watchlistSymbols() {
    const seen = new Set();
    const ordered = [];
    state.positions.forEach((p) => {
      if (p && p.symbol && !seen.has(p.symbol)) {
        seen.add(p.symbol);
        ordered.push(p.symbol);
      }
    });
    BASE.forEach((s) => {
      if (!seen.has(s)) {
        seen.add(s);
        ordered.push(s);
      }
    });
    if (state.symbol && !seen.has(state.symbol)) ordered.unshift(state.symbol);
    return ordered;
  }

  function positionCard(p) {
    const side = (p.side || '').toLowerCase();
    const upnl = p.unrealised_pnl;
    const pct = p.pnl_pct;
    const on = p.symbol === state.symbol ? ' active' : '';
    return `<article class="pos-card ${side}${on}">
      <header>
        <div class="pos-sym">
          <strong>${pairLabel(p.symbol) || '—'}</strong>
          <span class="quiet-label">${p.symbol || ''}</span>
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
    selectSymbol(sym);
    location.hash = 'trade';
    setView('trade');
    if (isPhone()) closeSheet();
  }

  function goTrade(sym) {
    selectSymbol(sym);
    location.hash = 'trade';
    setView('trade');
    if (isPhone()) openTicket(state.side);
  }

  function positionRow(p) {
    const side = (p.side || '').toLowerCase();
    const upnl = p.unrealised_pnl;
    const roe = p.pnl_pct;
    const on = p.symbol === state.symbol ? ' active' : '';
    return `<tr class="pos-row ${side}${on}" data-chart-sym="${p.symbol || ''}">
      <td class="contract"><strong>${pairLabel(p.symbol) || '—'}</strong><span>${p.symbol || ''} · ${p.leverage != null ? fmt(p.leverage, 0) + '×' : ''} ${p.margin_mode || ''}</span></td>
      <td><span class="side-pill ${side}">${side || '—'}</span></td>
      <td>${fmt(p.size, 4)}</td>
      <td>${fmtPx(p.entry)}</td>
      <td class="mark">${fmtPx(p.mark)}</td>
      <td>${fmtPx(p.liq)}</td>
      <td>${p.distance_to_liq_pct != null ? fmt(p.distance_to_liq_pct, 2) + '%' : '—'}</td>
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
    paintPosCount();
    if (!state.positions.length) {
      if (root) root.innerHTML = '<div class="empty-pos card">No open UTA positions.</div>';
      if (body) body.innerHTML = '<tr><td colspan="11" class="empty-cell">No open positions.</td></tr>';
      syncTradeSymbols();
      paintOpenPosStrip();
      paintPositionLines();
      return;
    }
    if (body) body.innerHTML = state.positions.map(positionRow).join('');
    if (root) root.innerHTML = state.positions.map(positionCard).join('');
    wirePosActions(body);
    wirePosActions(root);
    syncTradeSymbols();
    paintOpenPosStrip();
    paintPositionLines();
  }

  function ensureSymbolOption(sym) {
    const sel = $('#t-symbol');
    if (!sel || !sym) return;
    if (![...sel.options].some((o) => o.value === sym)) {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = sym;
      sel.appendChild(opt);
    }
  }

  function selectSymbol(sym) {
    if (!sym) return;
    state.symbol = sym;
    ensureSymbolOption(sym);
    const sel = $('#t-symbol');
    if (sel) sel.value = sym;
    const pos = currentPosition(sym);
    if (pos && (pos.side === 'long' || pos.side === 'short')) {
      state.side = pos.side;
      $$('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === pos.side));
      updateSideAction();
    }
    buildSymbolSwitch();
    paintOpenPosStrip();
    paintPositionLines();
    loadCandles(true);
    loadTicker();
    loadOrderbook();
    loadTape();
    refreshTradeMark();
  }

  function syncTradeSymbols() {
    const symbols = watchlistSymbols();
    const sel = $('#t-symbol');
    if (!sel) {
      buildSymbolSwitch();
      return;
    }
    const current = sel.value;
    sel.innerHTML = '';
    symbols.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    });
    if (symbols.includes(current)) sel.value = current;
    else if (symbols.includes(state.symbol)) sel.value = state.symbol;
    else if (state.positions[0]) sel.value = state.positions[0].symbol;
    if (sel.value) state.symbol = sel.value;
    buildSymbolSwitch();
  }

  function symbolChip(sym) {
    const pos = currentPosition(sym);
    const active = sym === state.symbol ? 'active' : '';
    const label = pairLabel(sym);
    if (!pos) {
      return `<button type="button" role="tab" data-sym="${sym}" class="${active}">${label}</button>`;
    }
    const side = (pos.side || '').toLowerCase();
    return `<button type="button" role="tab" data-sym="${sym}" class="pos-chip ${side} ${active}">
      <span class="chip-pair">${label}</span>
      <span class="chip-side">${side}</span>
      <strong class="${pnlClass(pos.unrealised_pnl)}">${money(pos.unrealised_pnl)}</strong>
    </button>`;
  }

  function switcherSignature(symbols) {
    return symbols.map((s) => {
      const p = currentPosition(s);
      return [
        s,
        s === state.symbol ? '1' : '0',
        p && p.side,
        p && Number(p.unrealised_pnl).toFixed(2),
        p && p.leverage,
      ].join(':');
    }).join('|');
  }

  function buildSymbolSwitch() {
    const root = $('#symbol-switch');
    if (!root) return;
    const symbols = watchlistSymbols();
    if (!symbols.includes(state.symbol)) state.symbol = symbols[0] || 'SOLUSDT';
    const sig = switcherSignature(symbols);
    if (sig === state.switcherSig && root.childElementCount) return;
    state.switcherSig = sig;
    root.innerHTML = symbols.map(symbolChip).join('');
    root.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => selectSymbol(btn.dataset.sym));
    });
  }

  function paintOpenPosStrip() {
    const el = $('#open-pos-strip');
    const pos = currentPosition();
    paintMobilePosCard();
    if (!el) return;
    if (!pos) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const side = (pos.side || '').toLowerCase();
    el.hidden = false;
    el.className = `open-pos-strip ${side}`;
    el.innerHTML = `
      <div class="ops-head">
        <span class="side-pill ${side}">${side}</span>
        <strong>${pairLabel(pos.symbol)}</strong>
        <em>${pos.leverage != null ? `${fmt(pos.leverage, 0)}×` : ''}</em>
      </div>
      <div><span>Size</span><strong>${fmt(pos.size, 4)}</strong></div>
      <div><span>Entry</span><strong>${fmtPx(pos.entry)}</strong></div>
      <div><span>uPnL</span><strong class="${pnlClass(pos.unrealised_pnl)}">${money(pos.unrealised_pnl)}</strong></div>
      <div><span>To liq</span><strong>${pos.distance_to_liq_pct != null ? `${fmt(pos.distance_to_liq_pct, 2)}%` : '—'}</strong></div>`;
  }

  function lineStyle(kind) {
    const styles = (typeof LightweightCharts !== 'undefined' && LightweightCharts.LineStyle) || {};
    if (kind === 'liq') return styles.Solid != null ? styles.Solid : 0;
    return styles.Dashed != null ? styles.Dashed : 2;
  }

  function clearPosLines() {
    if (!state.series) {
      state.posLines = [];
      return;
    }
    (state.posLines || []).forEach((line) => {
      try { state.series.removePriceLine(line); } catch { /* ignore */ }
    });
    state.posLines = [];
  }

  function paintPositionLines() {
    if (!state.series) return;
    clearPosLines();
    const pos = currentPosition();
    if (!pos) return;
    const specs = [
      { price: pos.entry, color: '#35e5e5', title: 'Entry', kind: 'entry' },
      { price: pos.break_even, color: '#e8ca8c', title: 'BE', kind: 'be' },
      { price: pos.liq, color: '#ff6b7a', title: 'Liq', kind: 'liq' },
    ];
    specs.forEach((spec) => {
      if (spec.price == null || !Number.isFinite(Number(spec.price))) return;
      try {
        state.posLines.push(state.series.createPriceLine({
          price: Number(spec.price),
          color: spec.color,
          lineWidth: 1,
          lineStyle: lineStyle(spec.kind),
          axisLabelVisible: true,
          title: spec.title,
        }));
      } catch { /* ignore */ }
    });
  }

  function applyLiveLock(unlocked, message) {
    state.liveUnlocked = !!unlocked;
    const badge = $('#mode-badge span');
    const chip = $('#mode-chip');
    const side = $('#sidebar-live');
    const liveBtn = $('#btn-live');
    const lockMsg = $('#ticket-lock');
    document.body.classList.toggle('live-ok', !!unlocked);
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
    if (Array.isArray(data.pnl_history)) {
      ingestPnlHistory(data.pnl_history);
    }
    if (Array.isArray(data.positions)) {
      renderPositions(data.positions);
      ok = true;
      showNotice('');
    }
    if (data.account) {
      renderAccount(data.account);
      ok = true;
    } else if (data.equity != null || data.unrealised_pnl != null) {
      pushEquityTick({ equity: data.equity, unrealised_pnl: data.unrealised_pnl });
      ok = true;
    }
    if (Array.isArray(data.alerts) && data.alerts.length) {
      showNotice(data.alerts[0], data.stale ? 'warn' : 'warn');
    } else if (data.error) {
      showNotice(data.error, 'warn');
    }
    if (data.bot) {
      renderBot(data.bot);
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
        if (Array.isArray(acct.pnl_history)) ingestPnlHistory(acct.pnl_history);
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
    const first = bars[0].time;
    const last = bars[bars.length - 1].time;
    if (timeSec < first || timeSec > last + 120) return null;
    let nearest = bars[0].time;
    let bestDist = Math.abs(timeSec - nearest);
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
        text: '',
        size: 0.7,
        id: fill.id || `${t}-${label}-${n}`,
        _detail: detail,
      });
    }
    markers.sort((a, b) => a.time - b.time || a.position.localeCompare(b.position));
    return markers;
  }

  function paintTradeMarkers() {
    if (!state.series) return;
    const markers = isPhone() ? [] : buildTradeMarkers(state.fills, state.bars);
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
    const height = Math.max(240, el.clientHeight || Math.min(520, window.innerHeight * 0.48));
    state.chart = LightweightCharts.createChart(el, {
      layout: {
        background: { color: '#0b0f13' },
        textColor: '#8b98a4',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      width: el.clientWidth,
      height,
    });
    state.series = state.chart.addCandlestickSeries({
      upColor: '#3dd68c',
      downColor: '#ff6b7a',
      borderUpColor: '#3dd68c',
      borderDownColor: '#ff6b7a',
      wickUpColor: '#3dd68c',
      wickDownColor: '#ff6b7a',
    });
    const resize = () => {
      if (!state.chart) return;
      state.chart.applyOptions({
        width: el.clientWidth,
        height: Math.max(220, el.clientHeight || height),
      });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    window.addEventListener('orientationchange', () => setTimeout(resize, 250));
    window.addEventListener('resize', resize);
  }

  async function loadCandles(force) {
    if (state.view !== 'trade' && !force) return;
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
      paintTradeMarkers();
      paintPositionLines();
      loadFills();
    } catch (err) {
      $('#chart-foot').textContent = String(err.message || err);
    }
  }

  async function loadTicker() {
    try {
      const { data } = await api(`/api/ticker?symbol=${encodeURIComponent(state.symbol)}&category=${encodeURIComponent(state.category)}`);
      if (!data || !data.ok) return;
      const last = data.mark || data.last;
      const lastText = fmtPx(last);
      if ($('#chart-last')) $('#chart-last').textContent = lastText;
      if ($('#mh-last')) $('#mh-last').textContent = fmtPx(data.last || last);
      if ($('#mh-mark')) $('#mh-mark').textContent = fmtPx(data.mark || last);
      if ($('#mh-bid')) $('#mh-bid').textContent = fmtPx(data.bid);
      if ($('#mh-ask')) $('#mh-ask').textContent = fmtPx(data.ask);
      if ($('#mh-high')) $('#mh-high').textContent = fmtPx(data.high24h);
      if ($('#mh-low')) $('#mh-low').textContent = fmtPx(data.low24h);
      if ($('#mh-vol')) {
        const vol = data.quote_volume != null ? data.quote_volume : data.base_volume;
        $('#mh-vol').textContent = vol != null ? fmt(vol, vol >= 1000 ? 0 : 2) : '—';
      }
      if ($('#mh-funding')) {
        $('#mh-funding').textContent = data.funding != null ? `${fmt(Number(data.funding) * 100, 4)}%` : '—';
      }
      if ($('#mh-oi')) $('#mh-oi').textContent = data.open_interest != null ? fmt(data.open_interest, 2) : '—';
      const chg = $('#chart-chg');
      if (chg) {
        chg.textContent = fmtPct(data.change24h);
        chg.className = `chg ${pnlClass(data.change24h)}`;
      }
      const mhChg = $('#mh-chg');
      if (mhChg) {
        mhChg.textContent = fmtPct(data.change24h);
        mhChg.className = `chg ${pnlClass(data.change24h)}`;
      }
      if (last != null) state.lastMark = last;
      if ($('#t-mark') && state.lastMark != null) $('#t-mark').textContent = fmtPx(state.lastMark);
      if (state.series && (data.mark || data.last) != null) {
        try {
          state.series.applyOptions({
            priceLineVisible: true,
          });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  function fmtCompact(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    const x = Math.abs(Number(n));
    if (x >= 1e6) return `${fmt(n / 1e6, 2)}M`;
    if (x >= 1e3) return `${fmt(n / 1e3, 2)}K`;
    return fmt(n, x >= 1 ? 3 : 4);
  }

  function bookRow(level, side, maxSize) {
    const size = Number(level.size) || 0;
    const pct = maxSize > 0 ? Math.max(4, Math.min(100, (size / maxSize) * 100)) : 0;
    return `<button type="button" class="book-row ${side}" data-book-price="${level.price}" data-book-side="${side}">
      <i class="depth" style="width:${pct}%"></i>
      <span class="px">${fmtPx(level.price)}</span>
      <span>${fmtCompact(level.size)}</span>
      <span>${fmtCompact(level.cum_size)}</span>
    </button>`;
  }

  function applyBookPrice(price, side) {
    const type = $('#t-type');
    const wrap = $('#t-price-wrap');
    const input = $('#t-price');
    if (!type || !input) return;
    type.value = 'limit';
    if (wrap) wrap.hidden = false;
    input.value = String(price);
    if (side === 'ask') {
      state.side = 'long';
      $$('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === 'long'));
    } else if (side === 'bid') {
      state.side = 'short';
      $$('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === 'short'));
    }
    updateSideAction();
    updateCostStrip();
    queuePreview();
  }

  function renderBook(data) {
    const asksEl = $('#book-asks');
    const bidsEl = $('#book-bids');
    if (!asksEl || !bidsEl || !data) return;
    const asks = (data.asks || []).slice(0, 14);
    const bids = (data.bids || []).slice(0, 14);
    const maxSize = Math.max(
      0,
      ...asks.map((r) => Number(r.size) || 0),
      ...bids.map((r) => Number(r.size) || 0),
    );
    // Best ask sits on the spread; farthest ask at the top.
    asksEl.innerHTML = asks.slice().reverse().map((row) => bookRow(row, 'ask', maxSize)).join('');
    bidsEl.innerHTML = bids.map((row) => bookRow(row, 'bid', maxSize)).join('');
    if ($('#book-mid')) $('#book-mid').textContent = fmtPx(data.mid || data.best_ask || data.best_bid);
    if ($('#book-spread-val')) {
      const bps = data.spread_bps != null ? `${fmt(data.spread_bps, 2)} bps` : fmtPx(data.spread);
      $('#book-spread-val').textContent = bps;
    }
    if ($('#mh-bid') && data.best_bid != null) $('#mh-bid').textContent = fmtPx(data.best_bid);
    if ($('#mh-ask') && data.best_ask != null) $('#mh-ask').textContent = fmtPx(data.best_ask);
    [asksEl, bidsEl].forEach((root) => {
      if (!root.dataset.wired) {
        root.dataset.wired = '1';
        root.addEventListener('click', (ev) => {
          const btn = ev.target.closest('[data-book-price]');
          if (!btn) return;
          applyBookPrice(btn.dataset.bookPrice, btn.dataset.bookSide);
        });
      }
    });
  }

  async function loadOrderbook() {
    if (state.view !== 'trade') return;
    try {
      const { data } = await api(
        `/api/orderbook?symbol=${encodeURIComponent(state.symbol)}&category=${encodeURIComponent(state.category)}&limit=20`,
        { timeoutMs: 8000 },
      );
      if (data && data.ok) renderBook(data);
    } catch { /* keep last book */ }
  }

  function renderTape(trades) {
    const root = $('#tape-body');
    if (!root) return;
    const rows = (trades || []).slice(0, 40);
    if (!rows.length) {
      root.innerHTML = '<li class="empty">No public prints yet.</li>';
      return;
    }
    root.innerHTML = rows.map((t) => {
      const when = t.ts_ms
        ? new Date(t.ts_ms).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/London' })
        : '';
      return `<li class="${t.side || ''}">
        <span>${(t.side || '').toUpperCase()}</span>
        <strong>${fmtPx(t.price)}</strong>
        <em>${fmtCompact(t.qty)}</em>
        <time>${when}</time>
      </li>`;
    }).join('');
  }

  async function loadTape() {
    if (state.view !== 'trade') return;
    try {
      const { data } = await api(
        `/api/trades?symbol=${encodeURIComponent(state.symbol)}&category=${encodeURIComponent(state.category)}&limit=40`,
        { timeoutMs: 8000 },
      );
      if (data && data.ok) renderTape(data.trades);
    } catch { /* keep last tape */ }
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
    paintActionBar();
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
        const hint = $('#t-lev-hint');
        if (hint) {
          const n = Number(levRange.value) || 0;
          hint.textContent = n < 10 ? 'Safe · below 10×' : (n >= 100 ? 'High risk · up to 150×' : 'Risk · 10× and above');
        }
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
        selectSymbol($('#t-symbol').value);
        if ($('#t-size-suffix')) {
          $('#t-size-suffix').textContent = state.sizeMode === 'usdt'
            ? 'USDT'
            : state.symbol.replace('USDT', '');
        }
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

  function isPhone() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function mobilePane() {
    const trade = $('.hl-trade');
    return (trade && trade.dataset.mobilePane) || 'chart';
  }

  function resizeChartSoon() {
    requestAnimationFrame(() => {
      if (!state.chart) return;
      const el = $('#tv-chart');
      if (!el) return;
      state.chart.applyOptions({
        width: el.clientWidth,
        height: Math.max(220, el.clientHeight),
      });
    });
  }

  function paintPosCount() {
    const n = state.positions.length || 0;
    if ($('#m-pos-n')) $('#m-pos-n').textContent = String(n);
    if ($('#nav-pos')) $('#nav-pos').textContent = String(n);
    if ($('#pos-count')) $('#pos-count').textContent = `${n} open`;
  }

  function paintMobilePosCard() {
    const card = $('#m-pos-card');
    if (!card) return;
    const pos = currentPosition() || state.positions[0] || null;
    if (!pos) {
      card.hidden = true;
      card.innerHTML = '';
      return;
    }
    const side = (pos.side || '').toLowerCase();
    const more = state.positions.length > 1 ? `<em>+${state.positions.length - 1}</em>` : '';
    card.hidden = false;
    card.innerHTML = `
      <span><strong>${pairLabel(pos.symbol)}</strong><i class="${side}">${side}</i>${pos.leverage != null ? `${fmt(pos.leverage, 0)}×` : ''}${more}</span>
      <strong class="${pnlClass(pos.unrealised_pnl)}">${money(pos.unrealised_pnl)}</strong>`;
  }

  function paintActionBar() {
    const pane = mobilePane();
    const ticketOpen = pane === 'ticket';
    $$('.m-action-bar [data-pane]').forEach((b) => {
      b.classList.toggle('active', b.dataset.pane === pane);
    });
    $$('.m-action-bar [data-ticket-side]').forEach((b) => {
      b.classList.toggle('active', ticketOpen && b.dataset.ticketSide === state.side);
    });
    $$('.hl-mobile-panes button').forEach((b) => {
      b.classList.toggle('active', b.dataset.pane === pane);
    });
  }

  function setMobilePane(pane) {
    const trade = $('.hl-trade');
    if (!trade) return;
    const next = pane || 'chart';
    trade.dataset.mobilePane = next;
    const open = isPhone() && next !== 'chart';
    document.body.classList.toggle('sheet-open', open);
    const scrim = $('#m-scrim');
    if (scrim) scrim.hidden = !open;
    paintActionBar();
    if (next === 'chart' || next === 'book') resizeChartSoon();
  }

  function closeSheet() {
    setMobilePane('chart');
  }

  function setTicketSide(side) {
    if (side !== 'long' && side !== 'short') return;
    state.side = side;
    $$('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === side));
    updateSideAction();
    updateCostStrip();
    queuePreview();
  }

  function openTicket(side) {
    if (side) setTicketSide(side);
    if (state.view !== 'trade') {
      location.hash = 'trade';
      setView('trade');
    }
    if (!isPhone()) return;
    setMobilePane('ticket');
    const form = $('#trade-form');
    if (form) form.scrollTop = 0;
  }

  function openSheet(pane) {
    if (state.view !== 'trade') {
      location.hash = 'trade';
      setView('trade');
    }
    if (!isPhone()) return;
    if (pane === 'ticket') {
      openTicket();
      return;
    }
    setMobilePane(pane || 'chart');
  }

  function wireMobile() {
    $$('[data-ticket-side]').forEach((btn) => {
      btn.addEventListener('click', () => openTicket(btn.dataset.ticketSide));
    });
    $$('[data-close-sheet]').forEach((el) => {
      el.addEventListener('click', closeSheet);
    });
    const card = $('#m-pos-card');
    if (card) {
      card.addEventListener('click', () => {
        const pos = currentPosition() || state.positions[0];
        if (pos && pos.symbol) selectSymbol(pos.symbol);
        openSheet('dock');
      });
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && isPhone() && mobilePane() !== 'chart') {
        ev.preventDefault();
        closeSheet();
      }
    });
    window.addEventListener('resize', () => {
      if (!isPhone()) {
        document.body.classList.remove('sheet-open');
        const scrim = $('#m-scrim');
        if (scrim) scrim.hidden = true;
        const trade = $('.hl-trade');
        if (trade) trade.dataset.mobilePane = 'chart';
        paintActionBar();
      }
    });
    $$('.sheet-grab').forEach((grab) => {
      let startY = 0;
      grab.addEventListener('touchstart', (ev) => {
        if (ev.touches[0]) startY = ev.touches[0].clientY;
      }, { passive: true });
      grab.addEventListener('touchend', (ev) => {
        const y = ev.changedTouches && ev.changedTouches[0] && ev.changedTouches[0].clientY;
        if (y != null && y - startY > 40) closeSheet();
      });
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
      if (state.view === 'trade') {
        loadCandles(true);
        loadTicker();
        loadOrderbook();
        loadTape();
      }
    });
    const tf = $('#tf-switch');
    if (tf) {
      tf.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-tf]');
        if (!btn) return;
        state.tf = btn.dataset.tf;
        $$('#tf-switch button').forEach((b) => b.classList.toggle('active', b === btn));
        loadCandles(true);
      });
    }
    $$('[data-depth]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('[data-depth]').forEach((b) => b.classList.toggle('active', b === btn));
        const which = btn.dataset.depth;
        $$('[data-depth-panel]').forEach((p) => {
          p.hidden = p.dataset.depthPanel !== which;
        });
      });
    });
    $$('[data-dock]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('[data-dock]').forEach((b) => b.classList.toggle('active', b === btn));
        const which = btn.dataset.dock;
        $$('[data-dock-panel]').forEach((p) => {
          p.hidden = p.dataset.dockPanel !== which;
        });
      });
    });
    $$('button[data-pane]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pane = btn.dataset.pane;
        if (!pane) return;
        if (isPhone() && pane === mobilePane() && pane !== 'chart') {
          closeSheet();
          return;
        }
        if (pane === 'chart') {
          closeSheet();
          ensureChart();
          resizeChartSoon();
          return;
        }
        openSheet(pane);
      });
    });
  }

  let paperTrades = [];

  function renderPaperLab(data) {
    const lab = $('#paper-lab');
    if (!lab || !data) return;
    const halt = data.halt;
    const ev = data.performance_evidence || {};
    const metrics = data.metrics || {};
    const session = data.session || {};
    setText('paper-label', session.label || 'Simulated session · read-only');
    const statusEl = $('#paper-status');
    if (statusEl) {
      statusEl.textContent = halt ? 'HALTED' : (session.status || '—');
      statusEl.className = `status-badge ${halt ? 'warn' : 'neutral'}`;
    }
    const haltEl = $('#paper-halt');
    if (haltEl) {
      haltEl.hidden = !halt;
      haltEl.textContent = halt || '';
    }
    const netEl = $('#paper-net');
    if (netEl) {
      netEl.textContent = money(metrics.net_usdt);
      netEl.className = pnlClass(metrics.net_usdt);
    }
    setText('paper-closed', metrics.closed_trades != null ? String(metrics.closed_trades) : '—');
    setText('paper-win', metrics.win_rate != null ? fmtPct(Number(metrics.win_rate) * 100) : '—');
    const scoreEl = $('#paper-score');
    if (scoreEl) {
      scoreEl.textContent = ev.status || '—';
      scoreEl.className = ev.status === 'PASS' ? 'up' : '';
    }
    const pace = [];
    if (ev.observed_closed_trades_per_day != null) {
      pace.push(`${fmt(ev.observed_closed_trades_per_day, 1)} / ${fmt(ev.target_closed_trades_per_day, 0)} trades/day`);
    }
    if (ev.observed_net_usdt_per_day != null) {
      pace.push(`${money(ev.observed_net_usdt_per_day)} / day vs ${money(ev.target_net_usdt_per_day)} target`);
    }
    setText('paper-pace', pace.join(' · ') || '—');
    paperTrades = Array.isArray(data.trades) ? data.trades : [];
    if (halt && !state.liveUnlocked) {
      const badge = $('#mode-badge span');
      if (badge) badge.textContent = 'PAPER · HALTED';
    }
  }

  async function loadPaperLab() {
    try {
      const { data } = await api('/api/dashboard', { timeoutMs: 15000 });
      if (data && (data.metrics || data.halt || data.session)) renderPaperLab(data);
    } catch {
      /* keep last paper snapshot */
    }
  }

  function renderBot(bot) {
    if (!bot || !$('#ai-bot')) return;
    const running = Boolean(bot.running) && !bot.halt;
    const statusEl = $('#bot-status');
    if (statusEl) {
      statusEl.textContent = bot.halt ? 'HALTED' : (running ? 'SCALPING' : 'PAUSED');
      statusEl.className = `status-badge ${bot.halt ? 'warn' : (running ? 'live' : 'neutral')}`;
    }
    if ($('#bot-note')) $('#bot-note').textContent = bot.note || 'Paper scalper · live UTA signals only';
    const metrics = bot.metrics || {};
    const eqEl = $('#bot-equity');
    if (eqEl) eqEl.textContent = metrics.paper_equity != null ? `$${fmt(metrics.paper_equity)}` : '—';
    const netEl = $('#bot-net');
    if (netEl) {
      netEl.textContent = money(metrics.net_usdt);
      netEl.className = pnlClass(metrics.net_usdt);
    }
    const openEl = $('#bot-open-upnl');
    if (openEl) {
      openEl.textContent = money(metrics.open_upnl);
      openEl.className = pnlClass(metrics.open_upnl);
    }
    setText('bot-win', metrics.win_rate != null ? fmtPct(Number(metrics.win_rate) * 100) : '—');

    $$('[data-bot-profile]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.botProfile === bot.profile);
    });

    const urgent = (bot.live_signals || []).find((s) => s.signal === 'BANK_NOW' || s.signal === 'URGENT_TP' || s.signal === 'PROTECT');
    const banner = $('#bot-live-banner');
    if (banner) {
      banner.hidden = !urgent;
      if (urgent) {
        banner.className = `bot-signal ${urgent.signal === 'PROTECT' ? 'warn' : 'bank'}`;
        banner.textContent = `LIVE ${urgent.symbol} ${urgent.signal}: ${urgent.detail}`;
      }
    }

    const openBox = $('#bot-open');
    if (openBox) {
      const pos = bot.open;
      if (!pos) {
        openBox.className = 'bot-open empty';
        openBox.textContent = running ? 'Scanning USDT-M 1m/5m for an entry…' : 'No paper position.';
      } else {
        openBox.className = `bot-open ${pos.side || ''}`;
        openBox.innerHTML = `
          <div class="bot-open-head">
            <strong>${pos.symbol}</strong>
            <span class="side-pill ${pos.side}">${pos.side || '—'}</span>
            <span class="lev">${pos.leverage != null ? fmt(pos.leverage, 0) + '×' : ''}</span>
            <span class="quiet-label">${Number(pos.leverage) < 10 ? 'safe' : 'risk'}</span>
          </div>
          <div class="bot-open-grid">
            <div><span>Entry</span><strong>${fmtPx(pos.entry)}</strong></div>
            <div><span>Mark</span><strong>${fmtPx(pos.mark)}</strong></div>
            <div><span>Net</span><strong class="${pnlClass(pos.net)}">${money(pos.net)}</strong></div>
            <div><span>Hold</span><strong>${pos.held_seconds != null ? fmt(pos.held_seconds, 0) + 's' : '—'}</strong></div>
          </div>
          <p>${pos.be_armed ? 'Stop at break-even · ' : ''}${pos.reason || ''}</p>`;
      }
    }

    const scanRoot = $('#bot-scan');
    if (scanRoot) {
      const rows = bot.scan || [];
      scanRoot.hidden = !rows.length;
      scanRoot.innerHTML = rows.map((s) => `
        <div class="bot-scan-row ${s.verdict || 'SKIP'}">
          <strong>${s.symbol}</strong>
          <span>${s.verdict || 'SKIP'}${s.leverage ? ` · ${s.leverage}×` : ''}</span>
          <p>${s.reason || ''}</p>
        </div>`).join('');
    }

    const sigRoot = $('#bot-signals');
    if (sigRoot) {
      const rows = bot.live_signals || [];
      sigRoot.hidden = !rows.length;
      sigRoot.innerHTML = rows.map((s) => `
        <div class="bot-sig ${s.signal || ''}">
          <strong>${s.symbol} · ${s.signal}</strong>
          <span class="${pnlClass(s.upnl)}">${money(s.upnl)}</span>
          <p>${s.detail || ''}</p>
        </div>`).join('');
    }

    const tape = $('#bot-tape');
    if (tape) {
      const fills = (bot.closed || []).slice().reverse().slice(0, 8);
      tape.innerHTML = fills.length
        ? fills.map((f) => `<li><span>${f.symbol} ${f.side}</span><strong class="${pnlClass(f.net_usdt)}">${money(f.net_usdt)}</strong><em>${f.reason || ''}</em></li>`).join('')
        : '<li class="empty">No paper fills yet.</li>';
    }
  }

  async function botCommand(action, profile) {
    const body = { action };
    if (profile) body.profile = profile;
    const { data } = await api('/api/bot', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 8000,
    });
    if (data && data.ok) renderBot(data);
    else showNotice((data && data.error) || 'Bot command failed', 'warn');
  }

  async function loadBot() {
    try {
      const { data } = await api('/api/bot', { timeoutMs: 8000 });
      if (data && data.ok) renderBot(data);
    } catch {
      /* keep last */
    }
  }

  function wireBot() {
    if ($('#bot-start')) $('#bot-start').addEventListener('click', () => botCommand('start'));
    if ($('#bot-stop')) $('#bot-stop').addEventListener('click', () => botCommand('stop'));
    if ($('#bot-flatten')) $('#bot-flatten').addEventListener('click', () => botCommand('flatten'));
    $$('[data-bot-profile]').forEach((btn) => {
      btn.addEventListener('click', () => botCommand('profile', btn.dataset.botProfile));
    });
  }

  function exportPaperTrades() {
    if (!paperTrades.length) {
      showNotice('No closed paper trades to export.', 'warn');
      return;
    }
    const cols = ['at', 'symbol', 'side', 'entry', 'exit', 'qty', 'net_usdt', 'roi_pct'];
    const lines = [cols.join(',')].concat(paperTrades.map((row) => cols.map((key) => {
      const value = row[key];
      if (value == null) return '';
      const text = String(value);
      return text.includes(',') ? `"${text}"` : text;
    }).join(',')));
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'bitbot-paper-trades.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function boot() {
    paintIcons();
    loadEquityTicks();
    wireArt();
    wireNav();
    wireMobile();
    wireTrade();
    buildSymbolSwitch();
    setView(hashView());
    ukClock();
    setInterval(ukClock, 1000);
    wireBot();
    loadBot();
    setInterval(loadBot, 4000);
    loadPaperLab();
    setInterval(loadPaperLab, 30000);
    if ($('#export-trades')) $('#export-trades').addEventListener('click', exportPaperTrades);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    }
    startDeskStream();
    window.addEventListener('pagehide', stopDeskStream);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !deskStreamHealthy) startDeskStream();
    });
    setInterval(() => {
      if (state.view === 'trade') loadTicker();
    }, POLL_TICK_MS);
    setInterval(() => {
      if (state.view === 'trade') loadCandles(false);
    }, POLL_CANDLE_MS);
    setInterval(() => {
      if (state.view === 'trade') loadOrderbook();
    }, POLL_BOOK_MS);
    setInterval(() => {
      if (state.view === 'trade') loadTape();
    }, POLL_TAPE_MS);
    const trade = $('.hl-trade');
    if (trade && !trade.dataset.mobilePane) trade.dataset.mobilePane = 'chart';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
