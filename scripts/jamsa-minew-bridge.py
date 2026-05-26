#!/usr/bin/env python3
"""
잠사박물관 Minew BLE 게이트웨이 → Vercel webhook 브리지

배경:
  Minew G1/G2 게이트웨이는 webhook URL 을 단 하나만 설정할 수 있는데,
  현장에서는 minew_server.py (FastAPI, port 8080) 가 raw 데이터를
  로컬 SQLite + JSONL 로 저장하기 위해 그 자리를 차지하고 있다.
  이 브리지는 minew_server.py 와 함께 돌면서, 새로 들어온 raw 페이로드를
  주기적으로 폴링해서 우리 클라우드의 /api/beacon-webhook 으로 forward 한다.

사용법:
  pip install requests
  python jamsa-minew-bridge.py \\
      --minew  http://localhost:8080 \\
      --webhook https://jamsa-panel.vercel.app/api/beacon-webhook \\
      --interval 3 \\
      --state-file C:\\minew_server\\bridge-state.json

옵션:
  --minew         : minew_server.py 가 떠 있는 base URL (default http://localhost:8080)
  --webhook       : forward 대상 (default https://jamsa-panel.vercel.app/api/beacon-webhook)
  --interval      : polling 주기 초 (default 3)
  --state-file    : 마지막으로 처리한 raw id 기억하는 파일
  --logs-endpoint : /logs 경로 (default /logs?since=ID&limit=200)

자동 시작:
  Windows 작업 스케줄러 → 작업 만들기 → 트리거: 시스템 시작 시
  → 동작: python.exe + 이 스크립트 경로
"""

import argparse
import json
import os
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
        return {"last_id": 0, "forwarded": 0, "errors": 0}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"last_id": 0, "forwarded": 0, "errors": 0}


def save_state(path: Path, state: dict):
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_new_payloads(minew_base: str, since_id: int, limit: int = 200) -> list:
    """minew_server.py /logs?since=ID&limit=N 에서 새 페이로드 가져오기"""
    url = f"{minew_base}/logs?since={since_id}&limit={limit}"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    data = r.json()
    # 응답 형식 추정: {"logs": [{id, ts, payload, ...}, ...]}
    # 형식이 다르면 사용자가 minew_server.py 의 /logs 응답에 맞게 수정
    if isinstance(data, list):
        return data
    return data.get("logs", []) or data.get("data", []) or []


def forward_to_webhook(webhook: str, payload: dict, gateway_serial_hint: str = None) -> bool:
    """우리 cloud /api/beacon-webhook 으로 forward"""
    # /api/beacon-webhook 가 받는 형식에 맞춰서 변환
    forward = payload if isinstance(payload, dict) else {"raw": payload}
    if gateway_serial_hint and "gatewaySerial" not in forward:
        forward["gatewaySerial"] = gateway_serial_hint

    r = requests.post(webhook, json=forward, timeout=15)
    r.raise_for_status()
    return r.ok


def main():
    parser = argparse.ArgumentParser(description="Minew → Vercel webhook bridge")
    parser.add_argument("--minew", default="http://localhost:8080",
                        help="minew_server.py base URL")
    parser.add_argument("--webhook", default="https://jamsa-panel.vercel.app/api/beacon-webhook",
                        help="forward target")
    parser.add_argument("--interval", type=int, default=3,
                        help="polling interval (seconds)")
    parser.add_argument("--state-file", default="bridge-state.json",
                        help="state file path")
    parser.add_argument("--limit", type=int, default=200,
                        help="max payloads per tick")
    parser.add_argument("--verbose", action="store_true",
                        help="print every forward")
    args = parser.parse_args()

    state_path = Path(args.state_file)
    state = load_state(state_path)

    print(f"╔════════════════════════════════════════════════════════════╗")
    print(f"║  잠사 Minew BLE → Vercel Webhook Bridge                    ║")
    print(f"╚════════════════════════════════════════════════════════════╝")
    print(f"  Minew     : {args.minew}")
    print(f"  Webhook   : {args.webhook}")
    print(f"  Interval  : {args.interval}s")
    print(f"  StateFile : {state_path.absolute()}")
    print(f"  StartID   : {state['last_id']}  (지금까지 forward: {state.get('forwarded',0)})")
    print("─" * 64)

    last_health = 0
    while True:
        tick_start = time.time()
        try:
            payloads = fetch_new_payloads(args.minew, state["last_id"], args.limit)
            n_ok, n_err = 0, 0
            max_id = state["last_id"]

            for p in payloads:
                pid = p.get("id") or p.get("ID") or 0
                if pid <= state["last_id"]:
                    continue
                payload = p.get("payload") or p.get("body") or p.get("data") or p
                gw_serial = p.get("gateway") or p.get("gateway_serial") or p.get("device_mac")
                try:
                    forward_to_webhook(args.webhook, payload, gw_serial)
                    n_ok += 1
                    max_id = max(max_id, pid)
                    if args.verbose:
                        bcount = len(payload.get("beacons") or payload.get("obj") or []) if isinstance(payload, dict) else 0
                        print(f"  ✓ #{pid} gw={gw_serial} beacons={bcount}")
                except requests.HTTPError as e:
                    n_err += 1
                    print(f"  ✗ #{pid} HTTP {e.response.status_code}: {e.response.text[:120]}", file=sys.stderr)
                except Exception as e:
                    n_err += 1
                    print(f"  ✗ #{pid} {type(e).__name__}: {e}", file=sys.stderr)

            if n_ok or n_err:
                ts = datetime.now().strftime("%H:%M:%S")
                print(f"[{ts}] forward ok={n_ok} err={n_err}  last_id={max_id}")
            state["last_id"] = max_id
            state["forwarded"] = state.get("forwarded", 0) + n_ok
            state["errors"] = state.get("errors", 0) + n_err
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
