"""SQLite + JSONL 백업 저장소

- SQLite: 빠른 조회 + 인덱스
- JSONL: 백업/리플레이용 append-only 로그
- 두 곳에 모두 기록 (하나 실패해도 다른 곳에 남음)
"""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import SQLITE_PATH, JSONL_PATH

_lock = threading.Lock()  # SQLite 멀티스레드 안전

_INIT_SQL = """
CREATE TABLE IF NOT EXISTS beacon_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    gateway_id TEXT,
    gateway_name TEXT,
    uuid TEXT,
    mac TEXT,
    beacon_id TEXT,
    major INTEGER,
    minor INTEGER,
    rssi REAL,
    tx_power REAL,
    source_ip TEXT,
    raw_payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_received_at ON beacon_logs(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_id ON beacon_logs(gateway_id);
CREATE INDEX IF NOT EXISTS idx_major_minor ON beacon_logs(major, minor);
CREATE INDEX IF NOT EXISTS idx_beacon_id ON beacon_logs(beacon_id);
"""


def _conn():
    c = sqlite3.connect(SQLITE_PATH, check_same_thread=False, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init():
    """앱 시작 시 호출 — 스키마 생성"""
    with _lock:
        with _conn() as c:
            for stmt in _INIT_SQL.strip().split(";"):
                if stmt.strip():
                    c.execute(stmt)
            c.commit()


def _to_jsonable(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:
        return str(v)


def insert(data: Dict[str, Any], raw_payload: Dict[str, Any], source_ip: Optional[str]) -> Dict[str, Any]:
    """로그 1건 저장 → 새 record 반환 (id, received_at 포함)"""
    received_at = datetime.now(timezone.utc).isoformat()
    row = {
        "received_at": received_at,
        "gateway_id": data.get("gateway_id"),
        "gateway_name": data.get("gateway_name"),
        "uuid": data.get("uuid"),
        "mac": data.get("mac"),
        "beacon_id": data.get("beacon_id"),
        "major": data.get("major"),
        "minor": data.get("minor"),
        "rssi": data.get("rssi"),
        "tx_power": data.get("tx_power"),
        "source_ip": source_ip,
        "raw_payload": json.dumps(raw_payload, ensure_ascii=False, default=str),
    }
    new_id = None
    try:
        with _lock:
            with _conn() as c:
                cur = c.execute(
                    """INSERT INTO beacon_logs
                    (received_at, gateway_id, gateway_name, uuid, mac, beacon_id, major, minor, rssi, tx_power, source_ip, raw_payload)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        row["received_at"], row["gateway_id"], row["gateway_name"], row["uuid"],
                        row["mac"], row["beacon_id"], row["major"], row["minor"],
                        row["rssi"], row["tx_power"], row["source_ip"], row["raw_payload"],
                    ),
                )
                new_id = cur.lastrowid
                c.commit()
    except Exception as e:
        print(f"[storage] SQLite insert 실패: {e}")

    # JSONL 백업 (SQLite 실패해도 여기에는 남도록 try 분리)
    try:
        with open(JSONL_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": new_id, **row, "raw_payload": raw_payload}, ensure_ascii=False, default=str) + "\n")
    except Exception as e:
        print(f"[storage] JSONL append 실패: {e}")

    return {"id": new_id, **row, "raw_payload": raw_payload}


def _row_to_dict(r: sqlite3.Row) -> Dict[str, Any]:
    d = dict(r)
    try:
        d["raw_payload"] = json.loads(d.get("raw_payload") or "{}")
    except Exception:
        pass
    return d


def list_logs(
    limit: int = 100,
    gateway_id: Optional[str] = None,
    major: Optional[int] = None,
    minor: Optional[int] = None,
    since: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """필터 + 최신순"""
    sql = "SELECT * FROM beacon_logs WHERE 1=1"
    params: List[Any] = []
    if gateway_id is not None:
        sql += " AND gateway_id = ?"
        params.append(gateway_id)
    if major is not None:
        sql += " AND major = ?"
        params.append(major)
    if minor is not None:
        sql += " AND minor = ?"
        params.append(minor)
    if since:
        sql += " AND received_at >= ?"
        params.append(since)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(1, min(limit, 5000)))
    with _lock:
        with _conn() as c:
            cur = c.execute(sql, params)
            return [_row_to_dict(r) for r in cur.fetchall()]


def latest_per_beacon() -> List[Dict[str, Any]]:
    """beacon_id 또는 major/minor 기준 가장 최근 1건씩"""
    # COALESCE로 키 생성 (beacon_id 우선, 없으면 major/minor)
    sql = """
    SELECT * FROM beacon_logs
    WHERE id IN (
        SELECT MAX(id) FROM beacon_logs
        GROUP BY COALESCE(beacon_id, CAST(major AS TEXT) || '-' || CAST(minor AS TEXT))
    )
    ORDER BY id DESC
    LIMIT 200
    """
    with _lock:
        with _conn() as c:
            cur = c.execute(sql)
            return [_row_to_dict(r) for r in cur.fetchall()]


def get_recent(limit: int = 10) -> List[Dict[str, Any]]:
    return list_logs(limit=limit)
