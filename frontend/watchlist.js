/* ============================================
   StockWatch — Watchlist Dashboard
   ============================================ */

const WL_KEY    = 'stockwatch_watchlist';
const API_BASE  = 'http://localhost:5001';
const REFRESH_MS = 60_000;

let refreshTimer = null;

/* ── LocalStorage helpers ─────────────────── */
function getWatchlist() {
    try { return JSON.parse(localStorage.getItem(WL_KEY)) || []; }
    catch { return []; }
}

function removeFromWatchlist(ticker) {
    const wl = getWatchlist().filter(s => s.ticker !== ticker);
    localStorage.setItem(WL_KEY, JSON.stringify(wl));
}

/* ── Fetch helpers ────────────────────────── */
async function fetchLive(ticker) {
    const r = await fetch(`${API_BASE}/api/stock/${ticker}/live`);
    if (!r.ok) throw new Error('live failed');
    return r.json();
}

async function fetchSentiment(ticker) {
    const r = await fetch(`${API_BASE}/api/stock/${ticker}/sentiment`);
    if (!r.ok) throw new Error('sent failed');
    return r.json();
}

/* ── Render ───────────────────────────────── */
function renderEmpty() {
    return `
        <div class="watchlist-empty">
            <div class="watchlist-empty-icon">🔖</div>
            <h2>Your watchlist is empty</h2>
            <p>Add stocks by clicking the bookmark icon on any stock page.</p>
            <a href="index.html">Search Stocks</a>
        </div>`;
}

function fmtPrice(p) {
    if (p == null) return '—';
    return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtChange(chg, pct) {
    if (chg == null) return '';
    const sign = chg >= 0 ? '+' : '';
    return `${sign}${chg.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}

function sentimentBar(sent) {
    if (!sent) return '';
    const bull = Math.round((sent.bullish  || 0) * 100);
    const neut = Math.round((sent.neutral  || 0) * 100);
    const bear = Math.round((sent.bearish  || 0) * 100);
    return `
        <div class="wl-sentiment">
            <div class="wl-sent-bar">
                <div class="wl-sent-bull" style="width:${bull}%"></div>
                <div class="wl-sent-neut" style="width:${neut}%"></div>
                <div class="wl-sent-bear" style="width:${bear}%"></div>
            </div>
            <div class="wl-sent-label">
                <span class="bull">${bull}% Bull</span>
                <span>${neut}% Neu</span>
                <span class="bear">${bear}% Bear</span>
            </div>
        </div>`;
}

function renderSkeletons(count) {
    return Array.from({ length: count }, () => `
        <div class="wl-skeleton">
            <div class="wl-skel-line" style="width:40%;height:14px"></div>
            <div class="wl-skel-line" style="width:70%;height:10px;margin-top:6px"></div>
            <div class="wl-skel-line" style="width:55%;height:20px;margin-top:12px"></div>
            <div class="wl-skel-line" style="width:100%;height:5px;margin-top:14px"></div>
        </div>`).join('');
}

function renderCard(stock, live, sent) {
    const up      = live && live.change != null && live.change >= 0;
    const chgCls  = live ? (up ? 'up' : 'down') : '';
    const exchange = (stock.exchange || '').toUpperCase();

    return `
        <div class="wl-card" data-ticker="${stock.ticker}">
            <button class="wl-remove" data-ticker="${stock.ticker}" aria-label="Remove ${stock.ticker} from watchlist">×</button>
            <a href="stock.html?ticker=${stock.ticker}" style="text-decoration:none;display:block;">
                <div class="wl-card-top">
                    <span class="wl-ticker">${stock.ticker}</span>
                    ${exchange ? `<span class="wl-exchange">${exchange}</span>` : ''}
                </div>
                <div class="wl-name">${stock.name || ''}</div>
                <div class="wl-price-row">
                    <span class="wl-price">${live ? fmtPrice(live.price) : '—'}</span>
                    <span class="wl-change ${chgCls}">${live ? fmtChange(live.change, live.change_pct) : ''}</span>
                </div>
                ${sentimentBar(sent)}
            </a>
        </div>`;
}

/* ── Main render pass ─────────────────────── */
async function renderWatchlist() {
    const main = document.getElementById('watchlistMain');
    const wl   = getWatchlist();

    if (!wl.length) {
        main.innerHTML = renderEmpty();
        return;
    }

    /* Show skeletons immediately */
    main.innerHTML = `
        <p class="watchlist-meta">${wl.length} stock${wl.length !== 1 ? 's' : ''} watched</p>
        <div class="watchlist-grid" id="wlGrid">${renderSkeletons(wl.length)}</div>`;

    /* Fetch live + sentiment in parallel for every ticker */
    const results = await Promise.allSettled(
        wl.map(s => Promise.allSettled([fetchLive(s.ticker), fetchSentiment(s.ticker)]))
    );

    /* Re-read watchlist in case user removed something during fetch */
    const current = getWatchlist();
    if (!current.length) { renderWatchlist(); return; }

    const cards = current.map((stock, i) => {
        const pair    = results[i];
        const liveRes = pair.status === 'fulfilled' ? pair.value[0] : null;
        const sentRes = pair.status === 'fulfilled' ? pair.value[1] : null;
        const live    = liveRes?.status === 'fulfilled' ? liveRes.value : null;
        const sent    = sentRes?.status === 'fulfilled' ? sentRes.value : null;
        return renderCard(stock, live, sent);
    });

    const grid = document.getElementById('wlGrid');
    if (grid) grid.innerHTML = cards.join('');

    /* Remove buttons */
    document.querySelectorAll('.wl-remove').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            removeFromWatchlist(btn.dataset.ticker);
            btn.closest('.wl-card').remove();
            const remaining = document.querySelectorAll('.wl-card').length;
            if (!remaining) renderWatchlist();
            else {
                const meta = document.querySelector('.watchlist-meta');
                if (meta) meta.textContent = `${remaining} stock${remaining !== 1 ? 's' : ''} watched`;
            }
        });
    });
}

/* ── Auto-refresh ─────────────────────────── */
function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(renderWatchlist, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearInterval(refreshTimer);
    } else {
        renderWatchlist();
        startAutoRefresh();
    }
});

/* ── Boot ─────────────────────────────────── */
renderWatchlist();
startAutoRefresh();
