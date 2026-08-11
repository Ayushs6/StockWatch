"""
Semantic ticker search — all-MiniLM-L6-v2 + SQLite BLOB storage.
Cosine similarity computed in numpy (vectors are L2-normalised, so dot == cos).
"""
import sqlite3, threading, numpy as np
from pathlib import Path

_DBFILE = Path(__file__).with_name("vectors.db")
_lock   = threading.Lock()   # guards model + batch encode
_model  = None
DIM     = 384                # all-MiniLM-L6-v2 output dimension


# ── DB ────────────────────────────────────────────────────────────────────────

def init_db():
    with sqlite3.connect(_DBFILE) as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS tickers (
                ticker     TEXT PRIMARY KEY,
                name       TEXT    NOT NULL,
                exchange   TEXT    DEFAULT '',
                text       TEXT    NOT NULL,
                embedding  BLOB    NOT NULL,
                indexed_at REAL    DEFAULT (strftime('%s','now'))
            )
        """)
        con.commit()


def count() -> int:
    try:
        with sqlite3.connect(_DBFILE) as con:
            return con.execute("SELECT COUNT(*) FROM tickers").fetchone()[0]
    except Exception:
        return 0


# ── Model ─────────────────────────────────────────────────────────────────────

def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def _make_text(ticker: str, name: str, description: str = "") -> str:
    """Compose the text we embed for each ticker."""
    text = f"{ticker}: {name}."
    if description:
        text += f" {description[:500]}"
    return text


# ── Write ─────────────────────────────────────────────────────────────────────

def upsert(ticker: str, name: str, exchange: str = "", description: str = ""):
    """Embed and store a single ticker (used for incremental enrichment)."""
    text = _make_text(ticker, name, description)
    with _lock:
        vec = _get_model().encode(text, normalize_embeddings=True).astype(np.float32)
    with sqlite3.connect(_DBFILE) as con:
        con.execute("""
            INSERT INTO tickers (ticker, name, exchange, text, embedding)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name       = excluded.name,
                exchange   = excluded.exchange,
                text       = excluded.text,
                embedding  = excluded.embedding,
                indexed_at = strftime('%s','now')
        """, (ticker, name, exchange, text, vec.tobytes()))
        con.commit()


def build_bulk(records: list):
    """
    Batch-embed and store a list of (ticker, name, exchange, description) tuples.
    Much faster than calling upsert() in a loop.
    """
    tickers, names, exchanges, descriptions = zip(*records)
    texts = [_make_text(t, n, d) for t, n, d in zip(tickers, names, descriptions)]

    with _lock:
        embeddings = _get_model().encode(
            texts,
            normalize_embeddings=True,
            batch_size=64,
            show_progress_bar=False,
        ).astype(np.float32)

    rows = [
        (t, n, e, txt, emb.tobytes())
        for t, n, e, txt, emb in zip(tickers, names, exchanges, texts, embeddings)
    ]
    with sqlite3.connect(_DBFILE) as con:
        con.executemany("""
            INSERT INTO tickers (ticker, name, exchange, text, embedding)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name       = excluded.name,
                exchange   = excluded.exchange,
                text       = excluded.text,
                embedding  = excluded.embedding,
                indexed_at = strftime('%s','now')
        """, rows)
        con.commit()


# ── Search ────────────────────────────────────────────────────────────────────

def search(query: str, top_k: int = 10) -> list:
    """
    Embed query → dot product against all stored vectors → top-k results.
    Returns list of {ticker, name, exchange, score}.
    """
    with sqlite3.connect(_DBFILE) as con:
        rows = con.execute(
            "SELECT ticker, name, exchange, embedding FROM tickers"
        ).fetchall()

    if not rows:
        return []

    with _lock:
        q_vec = _get_model().encode(
            query, normalize_embeddings=True
        ).astype(np.float32)

    tickers   = [r[0] for r in rows]
    names     = [r[1] for r in rows]
    exchanges = [r[2] for r in rows]
    matrix    = np.frombuffer(b"".join(r[3] for r in rows), dtype=np.float32).reshape(len(rows), DIM)
    scores    = matrix @ q_vec

    top_idx = np.argsort(scores)[::-1][:top_k]
    return [
        {
            "ticker":   tickers[i],
            "name":     names[i],
            "exchange": exchanges[i] or "—",
            "score":    round(float(scores[i]), 4),
        }
        for i in top_idx
    ]
