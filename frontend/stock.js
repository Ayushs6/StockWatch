(function () {
    'use strict';

    const API    = 'http://localhost:5001';
    const params = new URLSearchParams(window.location.search);
    const TICKER = (params.get('ticker') || '').toUpperCase();

    if (!TICKER) { window.location.href = 'index.html'; return; }
    document.title = `${TICKER} — StockWatch`;

    // ── State ──────────────────────────────────────────────────────────────
    let chart        = null;
    let candleSeries = null;
    let socialData   = null;
    let activeTab    = 'reddit';
    let stockMeta    = { name: TICKER, exchange: '' };
    let liveTimer    = null;

    // ── Watchlist helpers ──────────────────────────────────────────────────
    const WL_KEY = 'stockwatch_watchlist';
    function getWatchlist()  { try { return JSON.parse(localStorage.getItem(WL_KEY)) || []; } catch { return []; } }
    function isWatching()    { return getWatchlist().some(w => w.ticker === TICKER); }

    let toastTimer = null;
    function showToast(msg) {
        let toast = document.getElementById('wlToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'wlToast';
            toast.className = 'wl-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
    }

    function toggleWatchlist(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        try {
            let wl  = getWatchlist();
            const i = wl.findIndex(w => w.ticker === TICKER);
            if (i >= 0) {
                wl.splice(i, 1);
                localStorage.setItem(WL_KEY, JSON.stringify(wl));
                showToast('Removed from watchlist');
            } else {
                wl.unshift({ ticker: TICKER, name: stockMeta.name, exchange: stockMeta.exchange });
                localStorage.setItem(WL_KEY, JSON.stringify(wl));
                showToast('Added to watchlist ✓');
            }
            updateWatchlistBtn();
        } catch (err) {
            showToast('Error: ' + err.message);
        }
    }
    function updateWatchlistBtn() {
        const btn = document.getElementById('watchlistBtn');
        if (!btn) return;
        const watching = isWatching();
        btn.classList.toggle('watching', watching);
        btn.setAttribute('title', watching ? 'Remove from watchlist' : 'Add to watchlist');
        btn.setAttribute('aria-label', watching ? 'Remove from watchlist' : 'Add to watchlist');
    }

    // Script is at end of body — DOM is already available
    const _wlBtn = document.getElementById('watchlistBtn');
    if (_wlBtn) _wlBtn.addEventListener('click', toggleWatchlist);

    // ── Init ───────────────────────────────────────────────────────────────
    document.getElementById('headerTicker').textContent = TICKER;
    updateWatchlistBtn();

    initChart();
    initPeriodTabs();
    initSocialTabs();

    Promise.allSettled([
        loadSnapshot(),
        loadChart('1M'),
        loadSentiment(),
        loadSummary(),
        loadNews(),
        loadSocial(),
    ]);

    // ── Live price polling (Option C) ──────────────────────────────────────
    function startLive() {
        if (liveTimer) return;
        liveTimer = setInterval(refreshLive, 30000);
    }
    function stopLive() {
        clearInterval(liveTimer);
        liveTimer = null;
    }

    async function refreshLive() {
        try {
            const d = await apiFetch(`/api/stock/${TICKER}/live`);
            if (!d.price) return;

            // Flash price if it changed
            const priceEl = document.getElementById('headerPrice');
            const newText = `$${fmt(d.price)}`;
            if (priceEl.textContent !== '—' && priceEl.textContent !== newText) {
                const cls = d.change >= 0 ? 'price-flash-up' : 'price-flash-down';
                priceEl.classList.add(cls);
                setTimeout(() => priceEl.classList.remove(cls), 750);
            }
            priceEl.textContent = newText;

            const chEl = document.getElementById('headerChange');
            if (d.change != null && d.change_pct != null) {
                const sign = d.change >= 0 ? '+' : '';
                chEl.textContent = `${sign}${fmt(d.change)} (${sign}${fmt(d.change_pct)}%)`;
                chEl.className   = `stock-change ${d.change >= 0 ? 'up' : 'down'}`;
            }

            // Update badge
            const badge = document.getElementById('liveBadge');
            if (badge) {
                const t = new Date();
                badge.textContent = `● ${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
                badge.classList.remove('stale');
            }
        } catch (_) {
            const badge = document.getElementById('liveBadge');
            if (badge) badge.classList.add('stale');
        }
    }

    // Pause polling when tab is hidden, resume when visible
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopLive(); else { refreshLive(); startLive(); }
    });
    startLive();

    // ── Candlestick Chart ──────────────────────────────────────────────────
    function chartColors() {
        const light = document.body.classList.contains('light');
        return {
            bg:   light ? '#FFFFFF' : '#1A1D24',
            text: light ? '#374151' : '#9CA3AF',
            grid: light ? '#E5E7EB' : '#2A2E38',
        };
    }

    function initChart() {
        const el = document.getElementById('chartContainer');
        const c  = chartColors();
        chart = LightweightCharts.createChart(el, {
            layout: {
                background: { type: 'solid', color: c.bg },
                textColor: c.text,
            },
            grid: {
                vertLines: { color: c.grid },
                horzLines: { color: c.grid },
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: c.grid },
            timeScale: {
                borderColor: c.grid,
                timeVisible: true,
                secondsVisible: false,
            },
            width: el.clientWidth,
            height: 360,
        });

        candleSeries = chart.addCandlestickSeries({
            upColor:         '#10B981',
            downColor:       '#EF4444',
            borderUpColor:   '#10B981',
            borderDownColor: '#EF4444',
            wickUpColor:     '#10B981',
            wickDownColor:   '#EF4444',
        });

        // OHLC tooltip on crosshair
        const tooltip = document.createElement('div');
        tooltip.className = 'chart-tooltip';
        el.appendChild(tooltip);

        chart.subscribeCrosshairMove(param => {
            if (!param.time || !param.seriesData) {
                tooltip.style.display = 'none';
                return;
            }
            const d = param.seriesData.get(candleSeries);
            if (!d) { tooltip.style.display = 'none'; return; }

            const isUp = d.close >= d.open;
            tooltip.innerHTML = `
                <span class="tt-ohlc">O <b>${fmt(d.open)}</b></span>
                <span class="tt-ohlc">H <b>${fmt(d.high)}</b></span>
                <span class="tt-ohlc">L <b>${fmt(d.low)}</b></span>
                <span class="tt-ohlc">C <b style="color:${isUp ? '#10B981' : '#EF4444'}">${fmt(d.close)}</b></span>`;
            tooltip.style.display = 'flex';
        });

        window.addEventListener('resize', () => {
            chart.applyOptions({ width: el.clientWidth });
        });

        document.addEventListener('themechange', () => {
            const c = chartColors();
            chart.applyOptions({
                layout: {
                    background: { type: 'solid', color: c.bg },
                    textColor: c.text,
                },
                grid: {
                    vertLines: { color: c.grid },
                    horzLines: { color: c.grid },
                },
                rightPriceScale: { borderColor: c.grid },
                timeScale: { borderColor: c.grid },
            });
        });
    }

    async function loadChart(period) {
        document.getElementById('chartLoader').style.display = 'flex';
        try {
            const data = await apiFetch(`/api/stock/${TICKER}/chart?period=${period}`);
            if (Array.isArray(data) && data.length) {
                candleSeries.setData(data.map(d => ({
                    time:  d.time,
                    open:  d.open,
                    high:  d.high,
                    low:   d.low,
                    close: d.close,
                })));
                chart.timeScale().fitContent();
            }
        } catch (_) {}
        document.getElementById('chartLoader').style.display = 'none';
    }

    function initPeriodTabs() {
        document.getElementById('periodTabs').addEventListener('click', e => {
            const btn = e.target.closest('.period-btn');
            if (!btn) return;
            document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadChart(btn.dataset.period);
        });
    }

    // ── Snapshot ───────────────────────────────────────────────────────────
    async function loadSnapshot() {
        try {
            const d = await apiFetch(`/api/stock/${TICKER}`);
            stockMeta.name     = d.name || TICKER;
            stockMeta.exchange = d.exchange || '';
            updateWatchlistBtn();
            document.getElementById('headerCompany').textContent = d.name || TICKER;
            document.getElementById('headerPrice').textContent   = d.close ? `$${fmt(d.close)}` : '—';

            const chEl = document.getElementById('headerChange');
            if (d.change != null && d.change_pct != null) {
                const sign = d.change >= 0 ? '+' : '';
                chEl.textContent = `${sign}${fmt(d.change)} (${sign}${fmt(d.change_pct)}%)`;
                chEl.className   = `stock-change ${d.change >= 0 ? 'up' : 'down'}`;
            }

            document.getElementById('statOpen').textContent   = d.open   ? `$${fmt(d.open)}`   : '—';
            document.getElementById('statClose').textContent  = d.close  ? `$${fmt(d.close)}`  : '—';
            document.getElementById('statVolume').textContent = d.volume ? fmtBig(d.volume)     : '—';
            document.getElementById('statMktCap').textContent = d.market_cap ? fmtBig(d.market_cap) : '—';
            if (d.high && d.low) {
                document.getElementById('statRange').textContent =
                    `$${fmt(d.low)} — $${fmt(d.high)}`;
            }
        } catch (_) {}
    }

    // ── Sentiment ──────────────────────────────────────────────────────────
    async function loadSentiment() {
        try {
            const d     = await apiFetch(`/api/stock/${TICKER}/sentiment`);
            const score = d.score ?? 0.5;
            document.getElementById('meterFill').style.left = `${score * 100}%`;

            const b = d.breakdown || {};
            document.getElementById('pillPos').textContent = `▲ Positive ${pct(b.positive)}`;
            document.getElementById('pillNeu').textContent = `— Neutral ${pct(b.neutral)}`;
            document.getElementById('pillNeg').textContent = `▼ Negative ${pct(b.negative)}`;

            const label = d.label || 'neutral';
            document.getElementById('sentimentSub').textContent =
                `Overall: ${cap(label)} · ${d.total || 0} signals analyzed`;
        } catch (_) {
            document.getElementById('sentimentSub').textContent = 'Sentiment unavailable';
        }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    async function loadSummary() {
        try {
            const d = await apiFetch(`/api/stock/${TICKER}/summary`);
            document.getElementById('summaryText').textContent =
                d.summary || 'No summary available.';
            // Update the badge to show which model generated the summary
            if (d.model) {
                const badge = document.querySelector('#summaryCard .ai-badge');
                if (badge) badge.textContent = d.model;
            }
        } catch (_) {
            document.getElementById('summaryText').textContent = 'Summary unavailable.';
        }
    }

    // ── News ───────────────────────────────────────────────────────────────
    function newsCard(a) {
        const senti = a.sentiment?.label || 'neutral';
        const ts    = a.datetime ? timeAgo(a.datetime * 1000) : '';
        return `
        <a class="news-card" href="${esc(a.url || '#')}" target="_blank" rel="noopener">
            <div class="news-meta">
                <span class="news-source">${esc(a.source || 'News')}</span>
                <span class="news-time">${ts}</span>
            </div>
            <div class="news-headline">${esc(a.headline || '')}</div>
            <span class="news-sentiment ${senti}">${sentiIcon(senti)} ${cap(senti)}</span>
        </a>`;
    }

    async function loadNews() {
        const el = document.getElementById('newsList');
        try {
            const articles = await apiFetch(`/api/stock/${TICKER}/news`);
            if (!Array.isArray(articles) || !articles.length) {
                el.innerHTML = '<div class="empty-state">No recent news found.</div>';
                return;
            }
            el.innerHTML = articles.map(newsCard).join('');
        } catch (_) {
            el.innerHTML = '<div class="empty-state">News unavailable.</div>';
        }
    }

    // ── Social ─────────────────────────────────────────────────────────────
    async function loadSocial() {
        try {
            socialData = await apiFetch(`/api/stock/${TICKER}/social`);
            renderSocialTab(activeTab);
        } catch (_) {
            document.getElementById('socialList').innerHTML =
                '<div class="empty-state">Social data unavailable.</div>';
        }
    }

    function initSocialTabs() {
        document.getElementById('socialTabs').addEventListener('click', e => {
            const btn = e.target.closest('.social-tab');
            if (!btn) return;
            document.querySelectorAll('.social-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.tab;
            if (socialData) renderSocialTab(activeTab);
        });
    }

    function renderSocialTab(tab) {
        const el = document.getElementById('socialList');

        if (tab === 'buzz') {
            renderBuzz(el);
            return;
        }

        const posts = (socialData || {})[tab] || [];
        if (!posts.length) {
            el.innerHTML = `<div class="empty-state">No ${cap(tab)} posts found for ${TICKER}.</div>`;
            return;
        }
        el.innerHTML = posts.map(p => redditCard(p, tab)).join('');
    }

    // Reddit / Community cards share the same template
    function redditCard(p, tab) {
        const senti   = p.sentiment?.label || 'neutral';
        const iconColor = tab === 'community' ? '#7C5CBF' : '#FF4500';
        const initial   = tab === 'community' ? 'C' : 'R';
        return `
        <a class="social-card" href="${esc(p.url || '#')}" target="_blank" rel="noopener">
            <div class="social-card-header">
                <div class="social-user">
                    <span class="platform-icon" style="background:${iconColor}">${initial}</span>
                    <span class="social-username">${esc(p.source || 'Reddit')}</span>
                </div>
                <span class="social-sentiment ${senti}">${cap(senti)}</span>
            </div>
            <div class="social-title">${esc(p.title || '')}</div>
            ${p.text ? `<div class="social-text">${esc(p.text)}</div>` : ''}
            <div class="social-footer">
                <span class="social-metric">▲ ${p.score ?? 0}</span>
                <span class="social-metric">💬 ${p.comments ?? 0}</span>
                ${p.created ? `<span class="social-time">${timeAgo(p.created * 1000)}</span>` : ''}
            </div>
        </a>`;
    }

    // Market Buzz tab — FinBERT sentiment aggregated from news headlines
    function renderBuzz(el) {
        const b = (socialData || {}).buzz || {};
        if (!Object.keys(b).length) {
            el.innerHTML = '<div class="empty-state">Buzz data unavailable — sentiment analysis may still be loading. Try again in a moment.</div>';
            return;
        }

        const bullW   = b.bullish_pct ?? 50;
        const bearW   = b.bearish_pct ?? 50;
        const neutW   = b.neutral_pct ?? 0;
        const score   = b.score ?? 0.5;
        const dom     = b.dominant || 'neutral';
        const domColor = dom === 'positive' ? '#10B981' : dom === 'negative' ? '#EF4444' : '#9CA3AF';

        el.innerHTML = `
        <div class="buzz-card">
            <div class="buzz-title">News Sentiment <span style="font-size:0.6rem;background:rgba(16,185,129,.12);color:#10B981;border:1px solid rgba(16,185,129,.25);border-radius:4px;padding:1px 6px;letter-spacing:.06em">FinBERT AI</span></div>

            <div class="buzz-bar-wrap">
                <div class="buzz-bar">
                    <div class="buzz-bull" style="width:${bullW}%"></div>
                    <div class="buzz-neut" style="width:${neutW}%"></div>
                    <div class="buzz-bear" style="width:${bearW}%"></div>
                </div>
                <div class="buzz-bar-labels">
                    <span class="bull-label">▲ Bullish ${bullW}%</span>
                    <span style="color:#9CA3AF;font-size:.75rem">Neutral ${neutW}%</span>
                    <span class="bear-label">▼ Bearish ${bearW}%</span>
                </div>
            </div>

            <div class="buzz-grid">
                <div class="buzz-stat">
                    <span class="buzz-stat-val">${b.articles_week ?? '—'}</span>
                    <span class="buzz-stat-label">Articles analyzed</span>
                </div>
                <div class="buzz-stat">
                    <span class="buzz-stat-val">${Math.round(score * 100)}%</span>
                    <span class="buzz-stat-label">Sentiment score</span>
                </div>
                <div class="buzz-stat" style="grid-column:span 2">
                    <span class="buzz-stat-val" style="color:${domColor}">${cap(dom)}</span>
                    <span class="buzz-stat-label">Overall signal from recent headlines</span>
                </div>
            </div>

            <div class="buzz-note">
                Based on FinBERT AI analysis of ${b.articles_week ?? 0} recent news headlines
                for <strong>${TICKER}</strong>. Model: ProsusAI/finbert.
            </div>
        </div>`;
    }

    // ── Utilities ──────────────────────────────────────────────────────────
    async function apiFetch(path) {
        const r = await fetch(API + path);
        if (!r.ok) throw new Error(r.status);
        return r.json();
    }

    function fmt(n)    { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function pct(n)    { return `${Math.round((n || 0) * 100)}%`; }
    function cap(s)    { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
    function esc(s)    { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }
    function sentiIcon(s) { return s === 'positive' ? '▲' : s === 'negative' ? '▼' : '—'; }

    function fmtBig(n) {
        if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
        if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
        if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
        return `$${Number(n).toLocaleString()}`;
    }

    function timeAgo(ms) {
        const diff = Date.now() - ms;
        const m    = Math.floor(diff / 60000);
        if (m < 1)  return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }
})();
