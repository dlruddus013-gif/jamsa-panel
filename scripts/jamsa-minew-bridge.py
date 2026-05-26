#!/usr/bin/env python3
"""
잠사박물관 Minew BLE 게이트웨이 → Vercel webhook 브리지
(정찬주 전무님 첨부 minew_server.py 의 실제 endpoint 에 맞춰 보정 — 2026-05-25)

minew_server.py 실제 사양:
  POST /minew        — Minew G1-E 게이트웨이가 POST 하는 수신 URL
  GET  /health       — { status, server, receive_url }
  GET  /logs?limit=N — 최근 N건 (DESC by id), `since` 파라미터 없음
  GET  /raw/{id}     — 특정 id 의 row 전체 (raw_json 포함)

이 브리지 동작:
  1) /logs?limit=200 으로 최근 데이터 가져옴 (DESC 정렬)
  2) state-file 의 last_id 보다 큰 것만 골라 ASC 로 정렬
  3) 각각 /raw/{id} 로 raw_json 가져옴
  4) Vercel /api/beacon-webhook 으로 forward (raw_json + gateway_mac 힌트)
  5) state-file 에 last_id 저장

사용법:
  pip install requests
  python jamsa-minew-bridge.py \\
      --minew  http://localhost:8080 \\
      --webhook https://jamsa-panel.vercel.app/api/beacon-webhook \\
      --interval 3 \\
      --state-file C:\\minew_server\\bridge-state.json \\
      --verbose

옵션:
  --minew         : minew_server.py 가 떠 있는 base URL (default http://localhost:8080)
  --webhook       : forward 대상 (default https://jamsa-panel.vercel.app/api/beacon-webhook)
  --interval      : polling 주기 초 (default 3)
  --state-file    : 마지막으로 처리한 raw id 기억하는 파일
  --batch-limit   : /logs 한 번에 가져올 행 수 (default 200, 트래픽 많으면 500까지)
  --verbose       : 매 forward 마다 1줄 출력

자동 시작 (Windows 작업 스케줄러):
  트리거: 시스템 시작 시
  동작:   python.exe  C:\\minew_server\\jamsa-minew-bridge.py
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    print("requests 패키지가 필요합니다: pip install requests", file=sys.stderr)
    sys.exit(1)


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"last_id": 0, "forwarded": 0, "errors": 0, "started_at": datetime.now().isoformat()}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"last_id": 0, "forwarded": 0, "errors": 0, "started_at": datetime.now().isoformat()}


def save_state(path: Path, state: dict):
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_recent_logs(minew_base: str, since_id: int, limit: int = 200) -> list:
    """minew_server.py /logs?limit=N → since_id 보다 큰 것만 ASC 정렬해서 반환"""
    url = f"{minew_base}/logs?limit={limit}"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    rows = r.json()  # DESC by id
    if not isinstance(rows, list):
        return []
    new_rows = [row for row in rows if isinstance(row, dict) and (row.get("id") or 0) > since_id]
    new_rows.sort(key=lambda r: r.get("id", 0))  # ASC
    return new_rows


def fetch_raw(minew_base: str, log_id: int) -> dict:
    """특정 id 의 행 전체 (raw_json 포함)"""
    r = requests.get(f"{minew_base}/raw/{log_id}", timeout=10)
    r.raise_for_status()
    return r.json()


def build_forward_payload(log_row: dict, raw_row: dict) -> dict:
    """
    Vercel /api/beacon-webhook 가 기대하는 형식으로 변환.
    우리 webhook handler 는 다양한 별칭(gatewaySerial / gateway / gw_mac / deviceMac 등)을
    이미 지원하므로 raw_json 을 그대로 보내고, 누락된 게이트웨이 힌트만 보충한다.
    """
    payload = raw_row.get("raw_json")
    if not isinstance(payload, dict):
        # JSON 파싱 실패 / binary 페이로드인 경우 → 메타데이터 + base64 로 감싸 보냄
        payload = {
            "_source": "minew-bridge",
            "_payload_type": raw_row.get("payload_type"),
            "raw_base64": raw_row.get("raw_base64"),
            "raw_hex_preview": (raw_row.get("raw_hex") or "")[:200],
        }

    # 게이트웨이 시리얼 보강 (raw_json 에 없으면 minew 의 flat 필드에서 가져옴)
    if "gatewaySerial" not in payload and "gateway" not in payload:
        gw_mac = (log_row.get("gateway_mac") or raw_row.get("gateway_mac")
                  or payload.get("gateway_mac") or payload.get("gw_mac"))
        if gw_mac:
            payload["gatewaySerial"] = gw_mac

    # 단일 비콘 형태 (Minew G1-E 가 1건씩 보낼 때) → beacons 배열로 변환
    has_beacons = any(k in payload for k in ("beacons", "obj", "advertisements", "data", "devices"))
    if not has_beacons:
        beacon_mac = log_row.get("beacon_mac") or raw_row.get("beacon_mac") or payload.get("beacon_mac")
        beacon_rssi = log_row.get("rssi") or raw_row.get("rssi") or payload.get("rssi")
        beacon_uuid = log_row.get("uuid") or raw_row.get("uuid") or payload.get("uuid")
        if beacon_mac or beacon_uuid:
            payload["beacons"] = [{
                "mac": beacon_mac,
                "uuid": beacon_uuid or beacon_mac,
                "rssi": int(beacon_rssi) if beacon_rssi and str(beacon_rssi).lstrip("-").isdigit() else None,
                "major": payload.get("major"),
                "minor": payload.get("minor"),
            }]

    # 수신 시각 메타
    if log_row.get("received_at"):
        payload.setdefault("timestamp", log_row["received_at"])

    return payload


def forward_to_webhook(webhook: str, payload: dict, timeout: int = 15) -> dict:
    r = requests.post(webhook, json=payload, timeout=timeout)
    if not r.ok:
        raise requests.HTTPError(f"{r.status_code}: {r.text[:200]}", response=r)
    try:
        return r.json()
    except Exception:
        return {"ok": True, "_text": r.text[:200]}


def main():
    parser = argparse.ArgumentParser(description="Minew → Vercel webhook bridge (2026-05-25 ver.)")
    parser.add_argument("--minew", default="http://localhost:8080",
                        help="minew_server.py base URL")
    parser.add_argument("--webhook", default="https://jamsa-panel.vercel.app/api/beacon-webhook",
                        help="forward target")
    parser.add_argument("--interval", type=int, default=3,
                        help="polling interval (seconds)")
    parser.add_argument("--state-file", default="bridge-state.json",
                        help="state file path")
    parser.add_argument("--batch-limit", type=int, default=200,
                        help="rows per /logs call (max 500 권장)")
    parser.add_argument("--verbose", action="store_true",
                        help="print every forward")
    parser.add_argument("--dry-run", action="store_true",
                        help="forward 안 하고 콘솔에만 출력")
    args = parser.parse_args()

    state_path = Path(args.state_file)
    state = load_state(state_path)

    print(f"╔════════════════════════════════════════════════════════════╗")
    print(f"║  잠사 Minew BLE → Vercel Webhook Bridge  v2 (2026-05-25)  ║")
    print(f"╚════════════════════════════════════════════════════════════╝")
    print(f"  Minew     : {args.minew}")
    print(f"  Webhook   : {args.webhook}{'  [DRY-RUN]' if args.dry_run else ''}")
    print(f"  Interval  : {args.interval}s · batch {args.batch_limit}")
    print(f"  StateFile : {state_path.absolute()}")
    print(f"  StartID   : {state['last_id']}  (누적 forward: {state.get('forwarded',0)})")
    print("─" * 64)

    last_health = 0
    while True:
        tick_start = time.time()
        try:
            new_rows = fetch_recent_logs(args.minew, state["last_id"], args.batch_limit)
            n_ok, n_err = 0, 0
            max_id = state["last_id"]

            for log_row in new_rows:
                log_id = log_row.get("id") or 0
                try:
                    raw_row = fetch_raw(args.minew, log_id)
                    payload = build_forward_payload(log_row, raw_row)

                    if args.dry_run:
                        print(f"  [DRY] #{log_id} → {json.dumps(payload, ensure_ascii=False)[:200]}")
                    else:
                        result = forward_to_webhook(args.webhook, payload)
                        if args.verbose:
                            bcount = result.get("received", 0) if isinstance(result, dict) else 0
                            gw = result.get("gateway", "?") if isinstance(result, dict) else "?"
                            print(f"  ✓ #{log_id}  gw={gw}  beacons={bcount}")
                    n_ok += 1
                    max_id = max(max_id, log_id)
                except requests.HTTPError as e:
                    n_err += 1
                    print(f"  ✗ #{log_id} HTTP: {e}", file=sys.stderr)
                except Exception as e:
                    n_err += 1
                    print(f"  ✗ #{log_id} {type(e).__name__}: {e}", file=sys.stderr)

            if n_ok or n_err:
                ts = datetime.now().strftime("%H:%M:%S")
                print(f"[{ts}] forward ok={n_ok} err={n_err}  last_id={max_id}")
            state["last_id"] = max_id
            state["forwarded"] = state.get("forwarded", 0) + n_ok
            state["errors"] = state.get("errors", 0) + n_err
            state["last_tick_at"] = datetime.now().isoformat()
            save_state(state_path, state)

        except requests.ConnectionError:
            now = time.time()
            if now - last_health > 30:
                print(f"⚠ minew_server.py 응답 없음 ({args.minew}) — 재시도 중...", file=sys.stderr)
                last_health = now
        except Exception as e:
            print(f"⚠ 예외: {type(e).__name__}: {e}", file=sys.stderr)

        elapsed = time.time() - tick_start
        sleep_for = max(0.5, args.interval - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n중단됨 (Ctrl+C)")
        sys.exit(0)
