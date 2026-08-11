(function () {
    'use strict';

    const API    = 'http://localhost:5001';
    const params = new URLSearchParams(window.location.search);
    const TICKER = (params.get('ticker') || '').toUpperCase();

    if (!TICKER) { window.location.href = 'index.html'; return; }
    document.title = `${TICKER} News — StockWatch`;
    document.getElementById('headerTicker').textContent = TICKER;

    async function loadNews() {
        const el    = document.getElementById('newsList');
        const count = document.getElementById('newsCount');
        try {
            const r        = await fetch(`${API}/api/stock/${TICKER}/news`);
            const articles = await r.json();

            if (!Array.isArray(articles) || !articles.length) {
                el.innerHTML = '<div class="empty-state">No recent news found for ' + TICKER + '.</div>';
                return;
            }

            count.textContent = `${articles.length} article${articles.length !== 1 ? 's' : ''} from the past 7 days`;

            el.innerHTML = articles.map(a => {
                const senti = (a.sentiment && a.sentiment.label) || 'neutral';
                const ts    = a.datetime ? timeAgo(a.datetime * 1000) : '';
                const icon  = senti === 'positive' ? '▲' : senti === 'negative' ? '▼' : '—';
                const snip  = a.summary ? esc(a.summary.slice(0, 220)) + '…' : '';
                return `
                <a class="newsflow-card" href="${esc(a.url || '#')}" target="_blank" rel="noopener">
                    <div class="newsflow-meta">
                        <span class="newsflow-source">${esc(a.source || 'News')}</span>
                        <span class="newsflow-time">${ts}</span>
                    </div>
                    <div class="newsflow-headline">${esc(a.headline || '')}</div>
                    ${snip ? `<div class="newsflow-snippet">${snip}</div>` : ''}
                    <div class="newsflow-footer">
                        <span class="news-sentiment ${senti}">${icon} ${cap(senti)}</span>
                        <span class="newsflow-read-more">Read article ›</span>
                    </div>
                </a>`;
            }).join('');
        } catch (_) {
            el.innerHTML = '<div class="empty-state">News unavailable. Make sure the backend is running.</div>';
        }
    }

    function esc(s)  { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }
    function cap(s)  { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

    function timeAgo(ms) {
        const diff = Date.now() - ms;
        const m    = Math.floor(diff / 60000);
        if (m < 1)  return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        return d === 1 ? 'yesterday' : `${d}d ago`;
    }

    loadNews();
})();
