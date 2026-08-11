"""
StockWatch Backend — Phase 2
Run: python backend.py
"""
import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from massive import RESTClient
import requests, threading
from datetime import datetime, timedelta, timezone
import db
import sentiment as sent
import vectordb

# Load secrets from a local .env file if python-dotenv is installed.
# See .env.example for the full list of keys the app understands.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)
CORS(app)

# ── API keys — supplied via environment variables (never hard-code them) ───────
# Copy .env.example → .env and drop in your own free-tier keys.
#Copy all the api keys below by creating your accounts
POLYGON_KEY       = os.getenv("POLYGON_KEY", "")
FINNHUB_KEY       = os.getenv("FINNHUB_KEY", "")
GEMINI_KEY        = os.getenv("GEMINI_KEY", "")
GROQ_KEY          = os.getenv("GROQ_KEY", "")
ALPHAVANTAGE_KEY  = os.getenv("ALPHAVANTAGE_KEY", "")
TWITTER_BEARER    = os.getenv("TWITTER_BEARER", "")

polygon     = RESTClient(POLYGON_KEY)
STOCK_TYPES = {"CS"}

db.init_db()
vectordb.init_db()

# ── Background startup tasks ───────────────────────────────────────────────────
threading.Thread(target=sent._load, daemon=True).start()


def _build_vector_index():
    """
    Build the semantic index from the S&P 500 Wikipedia table.
    This gives us ticker + company name + GICS sector + sub-industry — no API calls,
    no rate limits, and the industry labels make semantic queries like
    'electric vehicles' or 'semiconductors' work out of the box.
    """
    try:
        existing = vectordb.count()
        if existing >= 400:
            print(f"[vectordb] index ready — {existing} tickers", flush=True)
            return

        print("[vectordb] fetching S&P 500 from Wikipedia…", flush=True)
        import pandas as pd, io
        html = requests.get(
            "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
            timeout=15,
        ).text
        df = pd.read_html(io.StringIO(html), attrs={"id": "constituents"})[0]

        records = []
        for _, row in df.iterrows():
            ticker   = str(row.get("Symbol", "")).strip().replace(".", "-")
            name     = str(row.get("Security", ticker)).strip()
            sector   = str(row.get("GICS Sector", "")).strip()
            industry = str(row.get("GICS Sub-Industry", "")).strip()
            if not ticker or ticker == "nan":
                continue
            # Rich description: sector + industry gives semantic search its power
            desc = ""
            if sector and sector != "nan":
                desc = f"Sector: {sector}."
            if industry and industry != "nan":
                desc += f" Industry: {industry}."
            # Also check if we already have a richer description cached
            snap = db.get(f"snap:{ticker}", db.CHART_TTL)
            if snap and snap.get("description"):
                desc = snap["description"]
            records.append((ticker, name, "NYSE/NASDAQ", desc.strip()))

        if records:
            vectordb.build_bulk(records)
            print(f"[vectordb] indexed {len(records)} S&P 500 tickers", flush=True)
        else:
            print("[vectordb] Wikipedia fetch returned no rows", flush=True)
    except Exception as e:
        print(f"[vectordb] build error: {e}", flush=True)


threading.Thread(target=_build_vector_index, daemon=True).start()


# ── helpers ───────────────────────────────────────────────────────────────────

def _map_mic(mic):
    return {"XNAS": "NASDAQ", "XNYS": "NYSE", "ARCX": "NYSE",
            "BATS": "NYSE",   "XASE": "AMEX"}.get(mic, mic or "OTHER")


def _fetch_alphavantage_news(ticker: str) -> list:
    """Fetch up to 50 articles from Alpha Vantage NEWS_SENTIMENT endpoint.
    Articles come with pre-computed sentiment — no FinBERT pass needed."""
    if not ALPHAVANTAGE_KEY:
        return []
    try:
        r = requests.get(
            "https://www.alphavantage.co/query",
            params={
                "function": "NEWS_SENTIMENT",
                "tickers":  ticker,
                "limit":    50,
                "apikey":   ALPHAVANTAGE_KEY,
            },
            timeout=10,
        ).json()

        # AV rate-limit message comes back as a plain dict with "Information" key
        if "Information" in r or "Note" in r:
            return []

        articles = []
        for item in r.get("feed", []):
            # time_published format: "20231215T143000"
            ts = None
            try:
                ts = int(datetime.strptime(
                    item["time_published"], "%Y%m%dT%H%M%S"
                ).timestamp())
            except Exception:
                pass

            # Map AV label → our {label, score} format
            av_score = float(item.get("overall_sentiment_score", 0))
            av_label = item.get("overall_sentiment_label", "Neutral")
            if "Bullish" in av_label:
                senti = {"label": "positive", "score": round((av_score + 1) / 2, 3)}
            elif "Bearish" in av_label:
                senti = {"label": "negative", "score": round((av_score + 1) / 2, 3)}
            else:
                senti = {"label": "neutral",  "score": 0.5}

            articles.append({
                "headline":  item.get("title", ""),
                "source":    item.get("source", "Alpha Vantage"),
                "url":       item.get("url", ""),
                "datetime":  ts,
                "summary":   item.get("summary", ""),
                "sentiment": senti,
            })
        return articles
    except Exception:
        return []


def _fetch_yahoo_news(ticker: str) -> list:
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        articles = []
        for item in (t.news or [])[:12]:
            headline = item.get("title") or item.get("headline", "")
            if not headline:
                continue
            articles.append({
                "headline": headline,
                "source":   item.get("publisher") or item.get("source") or "Yahoo Finance",
                "url":      item.get("link") or item.get("url", ""),
                "datetime": item.get("providerPublishTime") or item.get("datetime"),
            })
        return articles
    except Exception:
        return []


def _fetch_news(ticker: str) -> list:
    cache_key = f"news:{ticker}"
    cached    = db.get(cache_key, db.NEWS_TTL)
    if cached is not None:
        return cached

    today = datetime.now().strftime("%Y-%m-%d")
    month = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    # ── Source 1: Finnhub (30-day window, no artificial cap) ──────────────
    finnhub_articles = []
    try:
        r = requests.get(
            "https://finnhub.io/api/v1/company-news",
            params={"symbol": ticker, "from": month, "to": today, "token": FINNHUB_KEY},
            timeout=8,
        ).json()
        finnhub_articles = r if isinstance(r, list) else []
    except Exception:
        pass

    # ── Source 2: Yahoo Finance ────────────────────────────────────────────
    yahoo_articles = _fetch_yahoo_news(ticker)

    # ── Source 3: Alpha Vantage (50 articles, pre-sentimentised) ──────────
    av_articles = _fetch_alphavantage_news(ticker)

    # ── Merge & deduplicate by first 50 chars of headline ─────────────────
    seen, articles = set(), []
    for a in finnhub_articles + yahoo_articles + av_articles:
        h = (a.get("headline", "") or "")[:50].lower().strip()
        if h and h not in seen:
            seen.add(h)
            articles.append(a)
    articles.sort(key=lambda x: x.get("datetime") or 0, reverse=True)

    # Cache immediately so the response is fast regardless of FinBERT state
    db.put(cache_key, articles)

    # ── FinBERT enrichment — only for articles without sentiment yet ───────
    def _enrich(arts, k):
        try:
            pending = [(i, a) for i, a in enumerate(arts) if not a.get("sentiment")]
            if not pending:
                return
            headlines  = [a.get("headline", "") for _, a in pending]
            sentiments = sent.analyze(headlines)
            for j, (i, a) in enumerate(pending):
                arts[i]["sentiment"] = (
                    sentiments[j] if j < len(sentiments)
                    else {"label": "neutral", "score": 0.5}
                )
            db.put(k, arts)
        except Exception:
            pass
    threading.Thread(target=_enrich, args=(articles, cache_key), daemon=True).start()

    return articles


def _fetch_social(ticker: str) -> dict:
    key    = f"social:{ticker}"
    cached = db.get(key, db.SOCIAL_TTL)
    if cached is not None:
        return cached

    out = {"reddit": [], "buzz": {}, "community": []}
    ua  = {"User-Agent": "StockWatch/1.0 (academic research project)"}

    # Reddit — WSB / stocks / investing
    for sub in ["wallstreetbets", "stocks", "investing"]:
        try:
            r = requests.get(
                f"https://www.reddit.com/r/{sub}/search.json",
                params={"q": ticker, "sort": "new", "restrict_sr": "on",
                        "limit": 5, "t": "week"},
                headers=ua, timeout=8,
            ).json()
            for p in r.get("data", {}).get("children", []):
                d = p["data"]
                out["reddit"].append({
                    "source":   f"r/{sub}",
                    "title":    d.get("title", ""),
                    "text":     d.get("selftext", "")[:300],
                    "score":    d.get("score", 0),
                    "comments": d.get("num_comments", 0),
                    "url":      f"https://reddit.com{d.get('permalink', '')}",
                    "created":  d.get("created_utc"),
                })
        except Exception:
            pass
    out["reddit"].sort(key=lambda x: x["score"], reverse=True)
    out["reddit"] = out["reddit"][:10]

    # Buzz — derived from FinBERT sentiment on news headlines (no paid API needed)
    news_cache = db.get(f"news:{ticker}", db.NEWS_TTL)
    if news_cache:
        analyzed = [a.get("sentiment") for a in news_cache if a.get("sentiment")]
        if analyzed:
            agg = sent.aggregate(analyzed)
            bp  = agg.get("breakdown", {})
            out["buzz"] = {
                "bullish_pct":   round(bp.get("positive", 0) * 100, 1),
                "bearish_pct":   round(bp.get("negative", 0) * 100, 1),
                "neutral_pct":   round(bp.get("neutral",  0) * 100, 1),
                "articles_week": len(news_cache),
                "dominant":      agg.get("label", "neutral"),
                "score":         round(agg.get("score", 0.5), 2),
            }

    # Community — investing subreddits that have individual stock discussion
    for sub in ["dividends", "stockmarket", "investing", "stocks"]:
        try:
            r = requests.get(
                f"https://www.reddit.com/r/{sub}/search.json",
                params={"q": ticker, "sort": "top", "restrict_sr": "on",
                        "limit": 3, "t": "month"},
                headers=ua, timeout=8,
            ).json()
            for p in r.get("data", {}).get("children", []):
                d = p["data"]
                out["community"].append({
                    "source":   f"r/{sub}",
                    "title":    d.get("title", ""),
                    "text":     d.get("selftext", "")[:300],
                    "score":    d.get("score", 0),
                    "comments": d.get("num_comments", 0),
                    "url":      f"https://reddit.com{d.get('permalink', '')}",
                    "created":  d.get("created_utc"),
                })
        except Exception:
            pass
    out["community"].sort(key=lambda x: x["score"], reverse=True)
    out["community"] = out["community"][:10]

    # FinBERT on reddit + community posts (non-blocking)
    def _enrich_social(data, k):
        try:
            posts = data["reddit"] + data["community"]
            texts = [p["title"] for p in posts]
            if not texts:
                return
            sentiments = sent.analyze(texts)
            idx = 0
            for p in data["reddit"]:
                p["sentiment"] = sentiments[idx]; idx += 1
            for p in data["community"]:
                p["sentiment"] = sentiments[idx]; idx += 1
            db.put(k, data)
        except Exception:
            pass

    db.put(key, out)
    threading.Thread(target=_enrich_social, args=(out, key), daemon=True).start()
    return out


# ── routes ────────────────────────────────────────────────────────────────────

@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    cached = db.get_search(q)
    if cached is not None:
        return jsonify(cached)

    results      = []
    search_mode  = "keyword"

    # ── Semantic vector search (when index is ready) ───────────────────────
    n_indexed = vectordb.count()
    if n_indexed >= 100:
        hits = vectordb.search(q, top_k=10)
        if hits and hits[0]["score"] >= 0.25:
            results     = [dict(h, search_type="semantic") for h in hits]
            search_mode = "semantic"

    # ── Polygon keyword fallback ───────────────────────────────────────────
    if not results:
        try:
            for t in polygon.list_tickers(search=q, market="stocks", active=True, limit=50):
                if t.type not in STOCK_TYPES:
                    continue
                results.append({
                    "ticker":      t.ticker,
                    "name":        t.name,
                    "exchange":    _map_mic(t.primary_exchange),
                    "search_type": "keyword",
                })
                if len(results) >= 10:
                    break
        except Exception as e:
            if "429" in str(e):
                return jsonify(db.get_search(q) or [])
            return jsonify({"error": str(e)}), 500

    db.set_search(q, results)
    return jsonify(results)


@app.route("/api/index/status")
def index_status():
    return jsonify({"indexed_tickers": vectordb.count()})


@app.route("/api/stock/<ticker>/live")
def live_price(ticker):
    """Current price via yfinance fast_info — 30-second server-side cache."""
    ticker = ticker.upper()
    key    = f"live:{ticker}"
    cached = db.get(key, 30)
    if cached:
        return jsonify(cached)
    try:
        import yfinance as yf
        info       = yf.Ticker(ticker).fast_info
        price      = getattr(info, "last_price",      None)
        prev_close = getattr(info, "previous_close",  None)
        if price is None:
            return jsonify({"error": "no price"}), 404
        price      = round(float(price), 2)
        prev_close = float(prev_close) if prev_close else price
        change     = round(price - prev_close, 2)
        change_pct = round((price - prev_close) / prev_close * 100, 2) if prev_close else 0
        data = {
            "ticker":     ticker,
            "price":      price,
            "change":     change,
            "change_pct": change_pct,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        db.put(key, data)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stock/<ticker>")
def snapshot(ticker):
    ticker = ticker.upper()
    key    = f"snap:{ticker}"
    cached = db.get(key, db.CHART_TTL)
    if cached:
        return jsonify(cached)
    try:
        prev = requests.get(
            f"https://api.polygon.io/v2/aggs/ticker/{ticker}/prev",
            params={"adjusted": "true", "apiKey": POLYGON_KEY}, timeout=6,
        ).json().get("results", [{}])[0]

        det = requests.get(
            f"https://api.polygon.io/v3/reference/tickers/{ticker}",
            params={"apiKey": POLYGON_KEY}, timeout=6,
        ).json().get("results", {})

        o, c = prev.get("o"), prev.get("c")
        data = {
            "ticker":      ticker,
            "name":        det.get("name", ticker),
            "description": det.get("description", ""),
            "market_cap":  det.get("market_cap"),
            "homepage":    det.get("homepage_url", ""),
            "open":        o,
            "close":       c,
            "high":        prev.get("h"),
            "low":         prev.get("l"),
            "volume":      prev.get("v"),
            "change":      round(c - o, 2) if c and o else None,
            "change_pct":  round((c - o) / o * 100, 2) if c and o else None,
        }
        db.put(key, data)

        # Enrich vector index with full description in background
        def _enrich_vector(t, n, d):
            try:
                vectordb.upsert(t, n, description=d)
            except Exception:
                pass
        threading.Thread(
            target=_enrich_vector,
            args=(ticker, det.get("name", ticker), det.get("description", "")),
            daemon=True,
        ).start()

        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


_PERIODS = {
    "1D": ("minute", 5,    1),
    "5D": ("hour",   1,    5),
    "1M": ("day",    1,   30),
    "6M": ("day",    1,  180),
    "1Y": ("day",    1,  365),
    "5Y": ("week",   1, 1825),
}

@app.route("/api/stock/<ticker>/chart")
def chart(ticker):
    ticker  = ticker.upper()
    period  = request.args.get("period", "1M")
    key     = f"chart:{ticker}:{period}"
    cached  = db.get(key, db.CHART_TTL)
    if cached:
        return jsonify(cached)

    timespan, mult, days = _PERIODS.get(period, _PERIODS["1M"])
    now     = datetime.now(timezone.utc)
    from_dt = (now - timedelta(days=days)).strftime("%Y-%m-%d")
    to_dt   = now.strftime("%Y-%m-%d")
    try:
        r = requests.get(
            f"https://api.polygon.io/v2/aggs/ticker/{ticker}"
            f"/range/{mult}/{timespan}/{from_dt}/{to_dt}",
            params={"adjusted": "true", "sort": "asc",
                    "limit": 500, "apiKey": POLYGON_KEY},
            timeout=10,
        ).json()
        candles = [
            {
                "time":   int(b["t"] / 1000),
                "value":  b["c"],
                "open":   b["o"],
                "high":   b["h"],
                "low":    b["l"],
                "close":  b["c"],
                "volume": b["v"],
            }
            for b in r.get("results", [])
        ]
        db.put(key, candles)
        return jsonify(candles)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stock/<ticker>/news")
def news(ticker):
    return jsonify(_fetch_news(ticker.upper()))


@app.route("/api/stock/<ticker>/social")
def social(ticker):
    return jsonify(_fetch_social(ticker.upper()))


@app.route("/api/stock/<ticker>/sentiment")
def sentiment_agg(ticker):
    ticker = ticker.upper()
    key    = f"sent:{ticker}"
    cached = db.get(key, db.NEWS_TTL)
    if cached:
        return jsonify(cached)

    all_s = []
    for a in _fetch_news(ticker):
        if a.get("sentiment"):
            all_s.append(a["sentiment"])

    soc = _fetch_social(ticker)
    for p in soc.get("reddit", []):
        if p.get("sentiment"):     all_s.append(p["sentiment"])
    for p in soc.get("stocktwits", []):
        if p.get("sentiment_ai"):  all_s.append(p["sentiment_ai"])
    for p in soc.get("twitter", []):
        if p.get("sentiment"):     all_s.append(p["sentiment"])

    result = sent.aggregate(all_s)
    result["total"] = len(all_s)
    db.put(key, result)
    return jsonify(result)


def _extractive_summary(ticker: str, headlines: list, sent_records: list = None) -> str:
    """Build a readable 3-sentence summary using all available headlines + FinBERT data."""
    if not headlines:
        return f"No recent news coverage is currently available for {ticker}."

    label = "neutral"
    pos_pct = neg_pct = 0
    if sent_records:
        try:
            agg     = sent.aggregate(sent_records)
            label   = agg.get("label", "neutral")
            bp      = agg.get("breakdown", {})
            pos_pct = round(bp.get("positive", 0) * 100)
            neg_pct = round(bp.get("negative", 0) * 100)
        except Exception:
            pass

    h = [x.rstrip(". ").strip() for x in headlines if x.strip()]
    n = len(h)

    # Sentence 1 — overall signal across all headlines
    if label == "positive":
        s1 = (f"{ticker} is generating broadly positive coverage across {n} recent article"
              f"{'s' if n != 1 else ''}, with {pos_pct}% of headlines reflecting bullish sentiment.")
    elif label == "negative":
        s1 = (f"{ticker} is attracting cautionary coverage across {n} recent article"
              f"{'s' if n != 1 else ''}, with {neg_pct}% of headlines reflecting bearish sentiment.")
    else:
        s1 = (f"{ticker} has drawn mixed coverage across {n} recent article"
              f"{'s' if n != 1 else ''}, with market participants divided on the near-term outlook.")

    # Sentence 2 — two headline highlights
    if len(h) >= 2:
        s2 = f'Key topics in recent coverage include "{h[0]}" and "{h[1].lower()}".'
    elif h:
        s2 = f'A key recent headline: "{h[0]}".'
    else:
        s2 = ""

    # Sentence 3 — third headline or outlook
    if len(h) >= 3:
        s3 = f'Additional coverage highlights "{h[2].lower()}", among other developments.'
    else:
        s3 = {"positive": "Sentiment signals suggest investor optimism in recent sessions.",
              "negative": "Caution is advised as the broader sentiment leans bearish.",
              "neutral":  "Investors should monitor ongoing developments closely."}.get(label, "")

    return " ".join(filter(None, [s1, s2, s3]))


def _build_summary_prompt(ticker: str, headlines: list) -> str:
    return (
        f"You are a financial analyst. Based on these {len(headlines)} recent headlines about {ticker}:\n\n"
        + "\n".join(f"- {h}" for h in headlines)
        + "\n\nWrite 2-3 sentences summarizing what is happening with this stock. "
        "Be factual, neutral, and concise. No investment advice."
    )


@app.route("/api/stock/<ticker>/summary")
def summary(ticker):
    ticker = ticker.upper()
    key    = f"summary:{ticker}"
    cached = db.get(key, db.NEWS_TTL)
    if cached:
        return jsonify(cached)

    news      = _fetch_news(ticker)
    headlines = [a.get("headline", "") for a in news[:15] if a.get("headline")]
    sent_recs = [a["sentiment"] for a in news[:15] if a.get("sentiment")]
    prompt    = _build_summary_prompt(ticker, headlines)

    result = None

    # 1. Try Groq (free, reliable — sign up at console.groq.com)
    if GROQ_KEY:
        try:
            from groq import Groq
            client = Groq(api_key=GROQ_KEY)
            comp   = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=180,
                temperature=0.3,
            )
            text = comp.choices[0].message.content.strip()
            if text:
                result = {"summary": text, "model": "Groq / Llama 3.1"}
        except Exception:
            pass

    # 2. Try Gemini fallback
    if not result:
        try:
            from google import genai as google_genai
            client = google_genai.Client(api_key=GEMINI_KEY)
            resp   = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
            text   = (resp.text or "").strip()
            if text:
                result = {"summary": text, "model": "Gemini"}
        except Exception:
            pass

    # 3. Extractive summary — always works, no external API
    if not result:
        result = {"summary": _extractive_summary(ticker, headlines, sent_recs), "model": "extractive"}

    db.put(key, result)
    return jsonify(result)


if __name__ == "__main__":
    print("StockWatch backend running at http://localhost:5001")
    app.run(port=5001, debug=True)
