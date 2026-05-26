from fastapi import FastAPI, Request, HTTPException
from datetime import datetime
import sqlite3
import json
import base64
import os
import binascii

app = FastAPI()

DB_FILE = "minew_ble_data.db"
JSON_LOG_FILE = "minew_received.jsonl"
RAW_DIR = "raw_payloads"


def init_db():
    os.makedirs(RAW_DIR, exist_ok=True)

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS minew_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT,
        client_ip TEXT,
        content_type TEXT,
        payload_type TEXT,
        gateway_mac TEXT,
        beacon_mac TEXT,
        rssi TEXT,
        uuid TEXT,
        major TEXT,
        minor TEXT,
        raw_json TEXT,
        raw_base64 TEXT,
        raw_hex TEXT,
        raw_file TEXT
    )
    """)

    conn.commit()
    conn.close()


def find_value(data, keys):
    """
    Minew G1-E의 JSON 필드명이 펌웨어/포맷별로 다를 수 있으므로
    여러 후보 키를 재귀적으로 검색합니다.
    """
    if isinstance(data, dict):
        for key in keys:
            if key in data:
                return data[key]

        for value in data.values():
            found = find_value(value, keys)
            if found is not None:
                return found

    elif isinstance(data, list):
        for item in data:
            found = find_value(item, keys)
            if found is not None:
                return found

    return None


def guess_payload_type(content_type: str, body: bytes):
    """
    요청이 JSON인지 Binary인지 추정합니다.
    """
    ct = (content_type or "").lower()

    if "application/json" in ct or "text/json" in ct:
        return "json"

    stripped = body.strip()
    if stripped.startswith(b"{") or stripped.startswith(b"["):
        return "json"

    return "binary"


def parse_json_body(body: bytes):
    """
    JSON 파싱.
    일부 장비가 content-type을 잘못 보내도 본문이 JSON이면 파싱합니다.
    """
    text = body.decode("utf-8", errors="replace")
    return json.loads(text)


def save_raw_file(received_at: str, body: bytes):
    """
    Binary 원본 파일 저장
    """
    safe_time = received_at.replace(":", "-")
    filename = f"minew_raw_{safe_time}.bin"
    filepath = os.path.join(RAW_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(body)

    return filepath


def save_to_json_log(record):
    with open(JSON_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def insert_db(
    received_at,
    client_ip,
    content_type,
    payload_type,
    gateway_mac=None,
    beacon_mac=None,
    rssi=None,
    uuid=None,
    major=None,
    minor=None,
    raw_json=None,
    raw_base64=None,
    raw_hex=None,
    raw_file=None
):
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("""
    INSERT INTO minew_logs (
        received_at,
        client_ip,
        content_type,
        payload_type,
        gateway_mac,
        beacon_mac,
        rssi,
        uuid,
        major,
        minor,
        raw_json,
        raw_base64,
        raw_hex,
        raw_file
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        received_at,
        client_ip,
        content_type,
        payload_type,
        str(gateway_mac) if gateway_mac is not None else None,
        str(beacon_mac) if beacon_mac is not None else None,
        str(rssi) if rssi is not None else None,
        str(uuid) if uuid is not None else None,
        str(major) if major is not None else None,
        str(minor) if minor is not None else None,
        raw_json,
        raw_base64,
        raw_hex,
        raw_file
    ))

    conn.commit()
    conn.close()


@app.on_event("startup")
def startup():
    init_db()
    print("==========================================")
    print("Minew G1-E HTTP Beacon 수집 서버 시작")
    print("수신 URL: http://0.0.0.0:8080/minew")
    print("상태 확인: http://0.0.0.0:8080/health")
    print("최근 로그: http://0.0.0.0:8080/logs")
    print("==========================================")


@app.get("/health")
def health():
    return {
        "status": "running",
        "server": "Minew G1-E HTTP Beacon Collector",
        "receive_url": "/minew"
    }


@app.post("/minew")
async def receive_minew(request: Request):
    """
    Minew G1-E Gateway에서 HTTP POST로 올라오는 데이터를 받는 주소입니다.

    JSON 데이터:
      - 파싱 후 주요 필드 추출
      - 원본 JSON 저장

    Binary 데이터:
      - 원본 .bin 파일 저장
      - base64 / hex 저장
    """

    received_at = datetime.now().isoformat(timespec="seconds")
    client_ip = request.client.host if request.client else "unknown"
    content_type = request.headers.get("content-type", "")

    body = await request.body()

    if not body:
        raise HTTPException(status_code=400, detail="Empty body")

    payload_type = guess_payload_type(content_type, body)

    print("\n========== MINEW DATA RECEIVED ==========")
    print("시간:", received_at)
    print("클라이언트 IP:", client_ip)
    print("Content-Type:", content_type)
    print("Payload Type:", payload_type)
    print("Body Length:", len(body))
    print("=========================================\n")

    if payload_type == "json":
        try:
            data = parse_json_body(body)
        except Exception as e:
            # JSON처럼 보였지만 파싱 실패하면 Binary로 저장
            payload_type = "binary"
            print("JSON 파싱 실패, Binary로 저장:", str(e))
        else:
            gateway_mac = find_value(data, [
                "gateway_mac", "gatewayMac", "gw_mac", "gwMac",
                "mac", "device_mac", "deviceMac"
            ])

            beacon_mac = find_value(data, [
                "beacon_mac", "beaconMac", "tag_mac", "tagMac",
                "ble_mac", "bleMac", "mac"
            ])

            rssi = find_value(data, [
                "rssi", "RSSI"
            ])

            uuid = find_value(data, [
                "uuid", "UUID", "proximityUuid", "proximity_uuid"
            ])

            major = find_value(data, [
                "major", "Major"
            ])

            minor = find_value(data, [
                "minor", "Minor"
            ])

            raw_json = json.dumps(data, ensure_ascii=False)

            record = {
                "received_at": received_at,
                "client_ip": client_ip,
                "content_type": content_type,
                "payload_type": "json",
                "gateway_mac": gateway_mac,
                "beacon_mac": beacon_mac,
                "rssi": rssi,
                "uuid": uuid,
                "major": major,
                "minor": minor,
                "data": data
            }

            print(json.dumps(record, ensure_ascii=False, indent=2))

            save_to_json_log(record)

            insert_db(
                received_at=received_at,
                client_ip=client_ip,
                content_type=content_type,
                payload_type="json",
                gateway_mac=gateway_mac,
                beacon_mac=beacon_mac,
                rssi=rssi,
                uuid=uuid,
                major=major,
                minor=minor,
                raw_json=raw_json
            )

            return {
                "status": "ok",
                "received_at": received_at,
                "payload_type": "json",
                "bytes": len(body)
            }

    # Binary 저장 처리
    raw_file = save_raw_file(received_at, body)
    raw_base64 = base64.b64encode(body).decode("ascii")
    raw_hex = binascii.hexlify(body).decode("ascii")

    record = {
        "received_at": received_at,
        "client_ip": client_ip,
        "content_type": content_type,
        "payload_type": "binary",
        "bytes": len(body),
        "raw_file": raw_file,
        "raw_base64": raw_base64,
        "raw_hex_preview": raw_hex[:200]
    }

    print(json.dumps(record, ensure_ascii=False, indent=2))

    save_to_json_log(record)

    insert_db(
        received_at=received_at,
        client_ip=client_ip,
        content_type=content_type,
        payload_type="binary",
        raw_base64=raw_base64,
        raw_hex=raw_hex,
        raw_file=raw_file
    )

    return {
        "status": "ok",
        "received_at": received_at,
        "payload_type": "binary",
        "bytes": len(body),
        "raw_file": raw_file
    }


@app.get("/logs")
def get_logs(limit: int = 30):
    """
    최근 수신 데이터 확인
    예: http://서버IP:8080/logs
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("""
    SELECT
        id,
        received_at,
        client_ip,
        content_type,
        payload_type,
        gateway_mac,
        beacon_mac,
        rssi,
        uuid,
        major,
        minor,
        raw_file
    FROM minew_logs
    ORDER BY id DESC
    LIMIT ?
    """, (limit,))

    rows = cur.fetchall()
    conn.close()

    return [dict(row) for row in rows]


@app.get("/raw/{log_id}")
def get_raw(log_id: int):
    """
    특정 로그의 원본 데이터 확인
    JSON이면 raw_json,
    Binary면 base64/hex 정보 반환
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("""
    SELECT *
    FROM minew_logs
    WHERE id = ?
    """, (log_id,))

    row = cur.fetchone()
    conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Log not found")

    result = dict(row)

    if result.get("raw_json"):
        try:
            result["raw_json"] = json.loads(result["raw_json"])
        except Exception:
            pass

    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "minew_server:app",
        host="0.0.0.0",
        port=8080,
        reload=False
    )