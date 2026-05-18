import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def key_hash(key):
    return hashlib.sha256(safe_text(key).encode("utf-8")).hexdigest()


def safe_text(value):
    return str(value).encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def connect(db_path):
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS semantic_mappings (
            domain TEXT NOT NULL,
            taxonomy_version TEXT NOT NULL,
            prompt_version TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            semantic_key TEXT NOT NULL,
            label TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'llm',
            model TEXT NOT NULL DEFAULT '',
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (domain, taxonomy_version, prompt_version, key_hash)
        )
        """
    )
    return conn


def lookup(conn, payload):
    domain = payload.get("domain") or "general"
    taxonomy_version = payload.get("taxonomyVersion") or "default"
    prompt_version = payload.get("promptVersion") or "semantic-v1"
    keys = payload.get("keys") or []
    rows = []
    for item in keys:
        key = safe_text(item.get("key") if isinstance(item, dict) else item)
        digest = key_hash(key)
        cursor = conn.execute(
            """
            SELECT semantic_key, label, confidence, source, model, hit_count
            FROM semantic_mappings
            WHERE domain = ? AND taxonomy_version = ? AND prompt_version = ? AND key_hash = ?
            """,
            (domain, taxonomy_version, prompt_version, digest),
        )
        row = cursor.fetchone()
        if row:
            conn.execute(
                """
                UPDATE semantic_mappings
                SET hit_count = hit_count + 1, updated_at = ?
                WHERE domain = ? AND taxonomy_version = ? AND prompt_version = ? AND key_hash = ?
                """,
                (datetime.now(timezone.utc).isoformat(), domain, taxonomy_version, prompt_version, digest),
            )
            rows.append({
                "key": row[0],
                "label": row[1],
                "confidence": row[2],
                "source": row[3],
                "model": row[4],
                "hitCount": row[5] + 1,
            })
    conn.commit()
    return {"hits": rows}


def upsert(conn, payload):
    domain = payload.get("domain") or "general"
    taxonomy_version = payload.get("taxonomyVersion") or "default"
    prompt_version = payload.get("promptVersion") or "semantic-v1"
    model = payload.get("model") or ""
    source = payload.get("source") or "llm"
    now = datetime.now(timezone.utc).isoformat()
    mappings = payload.get("mappings") or []
    count = 0
    for item in mappings:
        key = safe_text(item.get("key") or "").strip()
        label = safe_text(item.get("label") or "").strip()
        if not key or not label:
            continue
        confidence = float(item.get("confidence") or 0)
        digest = key_hash(key)
        conn.execute(
            """
            INSERT INTO semantic_mappings (
                domain, taxonomy_version, prompt_version, key_hash, semantic_key,
                label, confidence, source, model, hit_count, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(domain, taxonomy_version, prompt_version, key_hash)
            DO UPDATE SET
                semantic_key = excluded.semantic_key,
                label = excluded.label,
                confidence = excluded.confidence,
                source = excluded.source,
                model = excluded.model,
                updated_at = excluded.updated_at
            """,
            (
                domain,
                taxonomy_version,
                prompt_version,
                digest,
                key,
                label,
                confidence,
                source,
                model,
                now,
                now,
            ),
        )
        count += 1
    conn.commit()
    return {"saved": count}


def main():
    if len(sys.argv) != 3:
        fail("参数错误")
    db_path = sys.argv[1]
    command = sys.argv[2]
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail(f"输入 JSON 无法解析: {exc}")
    conn = connect(db_path)
    try:
        if command == "lookup":
            data = lookup(conn, payload)
        elif command == "upsert":
            data = upsert(conn, payload)
        else:
            fail(f"未知命令: {command}")
    finally:
        conn.close()
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


if __name__ == "__main__":
    main()
