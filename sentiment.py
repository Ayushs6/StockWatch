import threading

_pipe = None
_lock = threading.Lock()


def _load():
    global _pipe
    if _pipe is None:
        with _lock:
            if _pipe is None:
                from transformers import pipeline
                _pipe = pipeline(
                    "text-classification",
                    model="ProsusAI/finbert",
                    top_k=None,
                    truncation=True,
                    max_length=512,
                )
    return _pipe


def analyze(texts: list) -> list:
    if not texts:
        return []
    try:
        pipe = _load()
        results = []
        for output in pipe(texts):
            best = max(output, key=lambda x: x["score"])
            results.append({"label": best["label"], "score": round(best["score"], 3)})
        return results
    except Exception:
        return [{"label": "neutral", "score": 0.5}] * len(texts)


def aggregate(sentiments: list) -> dict:
    if not sentiments:
        return {
            "label": "neutral",
            "score": 0.5,
            "breakdown": {"positive": 0.0, "negative": 0.0, "neutral": 1.0},
        }
    counts = {"positive": 0, "negative": 0, "neutral": 0}
    for s in sentiments:
        label = s.get("label", "neutral").lower()
        if label in counts:
            counts[label] += 1
    total = len(sentiments)
    pct = {k: round(v / total, 2) for k, v in counts.items()}
    composite = round((pct["positive"] - pct["negative"] + 1) / 2, 2)
    dominant = max(counts, key=counts.get)
    return {"label": dominant, "score": composite, "breakdown": pct}
