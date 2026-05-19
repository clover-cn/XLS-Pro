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


def unique_texts(values):
    output = []
    seen = set()
    for value in values:
        text = safe_text(value).strip()
        if text and text not in seen:
            seen.add(text)
            output.append(text)
    return output


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
    fallback_domains = [
        safe_text(value)
        for value in (payload.get("fallbackDomains") or [])
        if safe_text(value)
    ]
    keys = payload.get("keys") or []
    rows = []
    for item in keys:
        key = safe_text(item.get("key") if isinstance(item, dict) else item).strip()
        aliases = item.get("aliases") if isinstance(item, dict) else []
        candidates = unique_texts([key, *(aliases or [])])
        row = None
        scope = "exact"
        row_domain = domain
        row_taxonomy_version = taxonomy_version
        row_prompt_version = prompt_version
        matched_digest = ""
        for candidate in candidates:
            digest = key_hash(candidate)
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
                matched_digest = digest
                scope = "exact" if candidate == key else "alias"
                break
        if not row and fallback_domains:
            placeholders = ",".join("?" for _ in fallback_domains)
            for candidate in candidates:
                digest = key_hash(candidate)
                cursor = conn.execute(
                    f"""
                    SELECT domain, taxonomy_version, prompt_version, semantic_key, label, confidence, source, model, hit_count
                    FROM semantic_mappings
                    WHERE domain IN ({placeholders}) AND key_hash = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    (*fallback_domains, digest),
                )
                fallback_row = cursor.fetchone()
                if fallback_row:
                    row_domain = fallback_row[0]
                    row_taxonomy_version = fallback_row[1]
                    row_prompt_version = fallback_row[2]
                    row = fallback_row[3:]
                    matched_digest = digest
                    scope = "fallback" if candidate == key else "fallback_alias"
                    break
        if row:
            conn.execute(
                """
                UPDATE semantic_mappings
                SET hit_count = hit_count + 1, updated_at = ?
                WHERE domain = ? AND taxonomy_version = ? AND prompt_version = ? AND key_hash = ?
                """,
                (datetime.now(timezone.utc).isoformat(), row_domain, row_taxonomy_version, row_prompt_version, matched_digest),
            )
            rows.append({
                "key": key,
                "cachedKey": row[0],
                "label": row[1],
                "confidence": row[2],
                "source": row[3],
                "model": row[4],
                "hitCount": row[5] + 1,
                "cacheScope": scope,
                "domain": row_domain,
                "taxonomyVersion": row_taxonomy_version,
                "promptVersion": row_prompt_version,
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
    alias_count = 0
    for item in mappings:
        key = safe_text(item.get("key") or "").strip()
        label = safe_text(item.get("label") or "").strip()
        if not key or not label:
            continue
        confidence = float(item.get("confidence") or 0)
        aliases = unique_texts([key, *(item.get("aliases") or [])])
        for alias in aliases:
            digest = key_hash(alias)
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
                    alias,
                    label,
                    confidence,
                    source,
                    model,
                    now,
                    now,
                ),
            )
            alias_count += 1
        count += 1
    conn.commit()
    return {"saved": count, "savedAliases": alias_count}


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
