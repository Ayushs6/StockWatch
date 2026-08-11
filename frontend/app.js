/**
 * StockWatch - Phase 1 Search Bar
 * Connected to Massive API via Python backend at localhost:5001
 */

(function () {
    'use strict';

    const API_BASE = 'http://localhost:5001';
    const HISTORY_KEY = 'stockwatch_history';
    const FAVORITES_KEY = 'stockwatch_favorites';
    const MAX_HISTORY = 6;

    // --- DOM Elements ---
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    const searchSpinner = document.getElementById('searchSpinner');
    const searchShortcut = document.getElementById('searchShortcut');
    const searchContainer = document.getElementById('searchContainer');
    const hintTags = document.querySelectorAll('.hint-tag');

    // --- State ---
    let activeIndex = -1;
    let currentResults = [];
    let debounceTimer = null;
    let currentRequest = null;
    let showingHistory = false;

    // --- LocalStorage Helpers ---
    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
        } catch { return []; }
    }

    function saveToHistory(stock) {
        let history = getHistory();
        // Remove duplicate if exists
        history = history.filter(h => h.ticker !== stock.ticker);
        // Add to front
        history.unshift({ ticker: stock.ticker, name: stock.name, exchange: stock.exchange });
        // Keep max 6
        if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }

    function getFavorites() {
        try {
            return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || [];
        } catch { return []; }
    }

    function isFavorite(ticker) {
        return getFavorites().some(f => f.ticker === ticker);
    }

    function toggleFavorite(stock) {
        let favs = getFavorites();
        const exists = favs.findIndex(f => f.ticker === stock.ticker);
        if (exists >= 0) {
            favs.splice(exists, 1);
        } else {
            favs.push({ ticker: stock.ticker, name: stock.name, exchange: stock.exchange });
        }
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
    }

    /**
     * Fetch results from the backend (which calls Massive API).
     */
    async function fetchResults(query) {
        if (currentRequest) currentRequest.abort();

        const controller = new AbortController();
        currentRequest = controller;

        try {
            const res = await fetch(
                `${API_BASE}/api/search?q=${encodeURIComponent(query)}`,
                { signal: controller.signal }
            );
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') return null;
            console.error('Search error:', e);
            return [];
        }
    }

    // --- Rendering ---
    function renderResults(results, query, elapsed) {
        currentResults = results;
        activeIndex = -1;
        showingHistory = false;

        if (results.length === 0) {
            searchResults.innerHTML = `
                <div class="no-results">
                    No stocks found for "<strong>${escapeHtml(query)}</strong>"
                </div>`;
            openDropdown();
            return;
        }

        const isSemantic = results.length > 0 && results[0].search_type === 'semantic';
        const modeTag   = isSemantic
            ? `<span class="search-mode-tag semantic">⬡ Semantic AI</span>`
            : `<span class="search-mode-tag keyword">Keyword</span>`;

        const meta = `<div class="results-meta">
            <span>${results.length} result${results.length !== 1 ? 's' : ''}</span>
            <span style="display:flex;align-items:center;gap:8px">${modeTag} ${elapsed}ms</span>
        </div>`;

        const items = results.map((r, i) => {
            const fav      = isFavorite(r.ticker);
            const exchCls  = (r.exchange || '').toLowerCase();
            const scoreTag = r.score != null
                ? `<span class="result-score-pct">${Math.round(r.score * 100)}%</span>`
                : '';
            return `
            <div class="result-item"
                 role="option"
                 id="result-${i}"
                 data-index="${i}"
                 tabindex="-1"
                 aria-selected="false">
                <span class="result-ticker">${highlightMatch(r.ticker, query)}</span>
                <span class="result-name">${highlightMatch(r.name, query)}</span>
                ${scoreTag}
                <span class="result-exchange ${exchCls}">${r.exchange || '—'}</span>
                <button class="favorite-btn ${fav ? 'favorited' : ''}" data-ticker="${r.ticker}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}">
                    <svg viewBox="0 0 20 20" width="16" height="16">
                        <path d="M10 17.5s-7-4.5-7-9.5A3.5 3.5 0 0 1 6.5 4.5c1.3 0 2.5.7 3.5 2 1-1.3 2.2-2 3.5-2A3.5 3.5 0 0 1 17 8c0 5-7 9.5-7 9.5z"
                              stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"
                              fill="${fav ? 'currentColor' : 'none'}"/>
                    </svg>
                </button>
            </div>`;
        }).join('');

        searchResults.innerHTML = meta + items;
        openDropdown();
        attachFavoriteListeners();
    }

    function renderHistory() {
        const favorites = getFavorites();
        const history = getHistory();

        if (favorites.length === 0 && history.length === 0) return;

        showingHistory = true;
        let html = '';

        // Show favorites first if any
        if (favorites.length > 0) {
            html += `<div class="history-section-label">Favorites</div>`;
            favorites.forEach((stock, i) => {
                html += `
                <div class="result-item history-item"
                     role="option"
                     id="result-${i}"
                     data-index="${i}"
                     tabindex="-1"
                     aria-selected="false">
                    <span class="result-ticker">${escapeHtml(stock.ticker)}</span>
                    <span class="result-name">${escapeHtml(stock.name)}</span>
                    <span class="result-exchange ${(stock.exchange || '').toLowerCase()}">${stock.exchange || ''}</span>
                    <button class="favorite-btn favorited" data-ticker="${stock.ticker}" aria-label="Remove from favorites">
                        <svg viewBox="0 0 20 20" width="16" height="16">
                            <path d="M10 17.5s-7-4.5-7-9.5A3.5 3.5 0 0 1 6.5 4.5c1.3 0 2.5.7 3.5 2 1-1.3 2.2-2 3.5-2A3.5 3.5 0 0 1 17 8c0 5-7 9.5-7 9.5z"
                                  stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"
                                  fill="currentColor"/>
                        </svg>
                    </button>
                </div>`;
            });
        }

        // Then recent history
        if (history.length > 0) {
            html += `<div class="history-section-label">Recent</div>`;
            const offset = favorites.length;
            history.forEach((stock, i) => {
                const fav = isFavorite(stock.ticker);
                html += `
                <div class="result-item history-item"
                     role="option"
                     id="result-${offset + i}"
                     data-index="${offset + i}"
                     tabindex="-1"
                     aria-selected="false">
                    <span class="result-ticker">${escapeHtml(stock.ticker)}</span>
                    <span class="result-name">${escapeHtml(stock.name)}</span>
                    <span class="result-exchange ${(stock.exchange || '').toLowerCase()}">${stock.exchange || ''}</span>
                    <button class="favorite-btn ${fav ? 'favorited' : ''}" data-ticker="${stock.ticker}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}">
                        <svg viewBox="0 0 20 20" width="16" height="16">
                            <path d="M10 17.5s-7-4.5-7-9.5A3.5 3.5 0 0 1 6.5 4.5c1.3 0 2.5.7 3.5 2 1-1.3 2.2-2 3.5-2A3.5 3.5 0 0 1 17 8c0 5-7 9.5-7 9.5z"
                                  stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"
                                  fill="${fav ? 'currentColor' : 'none'}"/>
                        </svg>
                    </button>
                </div>`;
            });
        }

        // Build combined list for keyboard nav and click selection
        currentResults = [...favorites, ...history];
        activeIndex = -1;

        searchResults.innerHTML = html;
        openDropdown();
        attachFavoriteListeners();
    }

    function attachFavoriteListeners() {
        searchResults.querySelectorAll('.favorite-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const ticker = btn.dataset.ticker;
                const stock = currentResults.find(r => r.ticker === ticker);
                if (stock) {
                    toggleFavorite(stock);
                    // Re-render current view
                    if (showingHistory) {
                        renderHistory();
                    } else {
                        // Toggle the button state in place
                        const fav = isFavorite(ticker);
                        btn.classList.toggle('favorited', fav);
                        btn.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
                        const path = btn.querySelector('path');
                        path.setAttribute('fill', fav ? 'currentColor' : 'none');
                    }
                }
            });
        });
    }

    function highlightMatch(text, query) {
        if (!query || !text) return escapeHtml(text || '');
        const escaped = escapeRegex(query);
        const regex = new RegExp(`(${escaped})`, 'gi');
        return escapeHtml(text).replace(regex, '<strong style="color:#10B981">$1</strong>');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // --- Dropdown Control ---
    function openDropdown() {
        searchResults.classList.add('open');
        searchInput.setAttribute('aria-expanded', 'true');
    }

    function closeDropdown() {
        searchResults.classList.remove('open');
        searchInput.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
        showingHistory = false;
    }

    // --- Keyboard Navigation ---
    function setActiveItem(index) {
        const items = searchResults.querySelectorAll('.result-item');
        items.forEach(item => {
            item.classList.remove('active');
            item.setAttribute('aria-selected', 'false');
        });

        if (index >= 0 && index < items.length) {
            activeIndex = index;
            const active = items[index];
            active.classList.add('active');
            active.setAttribute('aria-selected', 'true');
            active.scrollIntoView({ block: 'nearest' });
            searchInput.setAttribute('aria-activedescendant', `result-${index}`);
        } else {
            activeIndex = -1;
            searchInput.removeAttribute('aria-activedescendant');
        }
    }

    function selectResult(index) {
        if (index >= 0 && index < currentResults.length) {
            const stock = currentResults[index];
            saveToHistory(stock);
            closeDropdown();
            window.location.href =
                `stock.html?ticker=${encodeURIComponent(stock.ticker)}`;
        }
    }

    // --- Debounced Search ---
    function handleInput() {
        const query = searchInput.value.trim();
        searchShortcut.classList.toggle('hidden', query.length > 0);

        if (query.length < 1) {
            searchSpinner.classList.remove('visible');
            // Show history when input is cleared
            renderHistory();
            return;
        }

        searchSpinner.classList.add('visible');

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const start = performance.now();
            const results = await fetchResults(query);

            if (results === null) return;

            const elapsed = Math.round(performance.now() - start);
            searchSpinner.classList.remove('visible');
            renderResults(results, query, elapsed);
        }, 50);
    }

    // --- Event Listeners ---
    searchInput.addEventListener('input', handleInput);

    searchInput.addEventListener('focus', () => {
        const query = searchInput.value.trim();
        if (query.length === 0) {
            renderHistory();
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        const items = searchResults.querySelectorAll('.result-item');
        if (!items.length) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setActiveItem(activeIndex < items.length - 1 ? activeIndex + 1 : 0);
                break;
            case 'ArrowUp':
                e.preventDefault();
                setActiveItem(activeIndex > 0 ? activeIndex - 1 : items.length - 1);
                break;
            case 'Enter':
                e.preventDefault();
                if (activeIndex >= 0) selectResult(activeIndex);
                break;
            case 'Escape':
                closeDropdown();
                searchInput.blur();
                break;
        }
    });

    searchResults.addEventListener('click', (e) => {
        const btn = e.target.closest('.favorite-btn');
        if (btn) return; // handled by favorite listener
        const item = e.target.closest('.result-item');
        if (item) selectResult(parseInt(item.dataset.index, 10));
    });

    document.addEventListener('click', (e) => {
        if (!searchContainer.contains(e.target)) closeDropdown();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput.focus();
        }
    });

    hintTags.forEach(tag => {
        tag.addEventListener('click', () => {
            searchInput.value = tag.dataset.query;
            searchInput.focus();
            handleInput();
        });
    });

    searchInput.focus();
})();
