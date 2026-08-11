import sqlite3, json, time, os

DB_PATH    = os.path.join(os.path.dirname(__file__), "stockwatch.db")
SEARCH_TTL = 86400   # 24 h
NEWS_TTL   = 3600    # 1 h
SOCIAL_TTL = 900     # 15 min
CHART_TTL  = 300     # 5 min


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS search_cache (
                query TEXT PRIMARY KEY,
                data  TEXT NOT NULL,
                ts    REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS data_cache (
                key  TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                ts   REAL NOT NULL
            );
        """)


def get_search(query: str):
    with _conn() as c:
        row = c.execute(
            "SELECT data, ts FROM search_cache WHERE query = ?", (query.lower(),)
        ).fetchone()
        if row and time.time() - row["ts"] < SEARCH_TTL:
            return json.loads(row["data"])
    return None


def set_search(query: str, value):
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO search_cache VALUES (?, ?, ?)",
            (query.lower(), json.dumps(value), time.time()),
        )


def get(key: str, ttl: int):
    with _conn() as c:
        row = c.execute(
            "SELECT data, ts FROM data_cache WHERE key = ?", (key,)
        ).fetchone()
        if row and time.time() - row["ts"] < ttl:
            return json.loads(row["data"])
    return None


def put(key: str, value):
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO data_cache VALUES (?, ?, ?)",
            (key, json.dumps(value), time.time()),
        )
