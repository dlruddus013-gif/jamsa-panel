#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
잠사박물관 CCTV 서버 (cctv.py)
- 박물관 LAN의 NVR/카메라 HTTP 스냅샷을 잠사 패널에 프록시
- 표준 라이브러리만 사용 (외부 의존성 없음 — Python 3.7+)
- Dahua/Hikvision/ONVIF/Custom NVR 자동 지원

사용법:
  1. cctv.py와 같은 폴더에 cctv_config.json 두기 (없으면 자동 생성)
  2. python cctv.py
  3. 브라우저: http://localhost:5555/api/status
  4. 잠사 패널: 통합지도 → CCTV 오버레이 켜기 → 자동 표시
"""
import http.server
import socketserver
import json
import os
import sys
import urllib.request
import urllib.parse
import base64
import socket
import threading
import time
from datetime import datetime

PORT = 5555
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "cctv_config.json")

# ─── 기본 설정 ──────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "version": "1.0",
    "nvrs": [
        {
            "name": "본관 NVR (Dahua)",
            "brand": "dahua",
            "host": "192.168.0.100",
            "port": 80,
            "rtsp_port": 554,
            "username": "admin",
            "password": "CHANGEME",
            "channels": {
                "1": "외부매표소", "2": "누에쉼터", "3": "오른쪽라인",
                "4": "왼쪽라인", "5": "IPC", "6": "바베큐존",
                "7": "메인NVR", "8": "양떼정원"
            }
        }
    ]
}

def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        print(f"[설정] 기본 설정 생성: {CONFIG_PATH}")
        print(f"        파일을 열어서 NVR host/username/password를 수정한 후 재시작하세요.")
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[설정 오류] {e} — 기본 설정 사용")
        return DEFAULT_CONFIG

CONFIG = load_config()

# ─── NVR 스냅샷 URL 빌더 ────────────────────────────────────────
def build_snapshot_path(nvr, ch):
    brand = nvr.get("brand", "dahua").lower()
    if brand == "dahua":
        return f"/cgi-bin/snapshot.cgi?channel={ch}"
    elif brand == "hikvision":
        return f"/ISAPI/Streaming/channels/{ch}01/picture"
    elif brand == "onvif":
        return f"/onvif/snapshot?ProfileToken=Profile_{ch}"
    elif brand == "custom":
        tmpl = nvr.get("snapshot_path", "/snap?ch={ch}")
        return tmpl.replace("{ch}", str(ch))
    return f"/cgi-bin/snapshot.cgi?channel={ch}"

# ─── HTTP 핸들러 ─────────────────────────────────────────────────
class CCTVHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} - {fmt % args}\n")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store, no-cache")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            params = urllib.parse.parse_qs(parsed.query)

            # 헬스체크 / 상태
            if path in ("/", "/api/status", "/api/health"):
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                channels = {}
                for idx, n in enumerate(CONFIG.get("nvrs", [])):
                    channels[f"nvr_{idx}"] = {
                        "name": n.get("name", f"NVR {idx+1}"),
                        "channels": list((n.get("channels") or {}).keys())
                    }
                self.wfile.write(json.dumps({
                    "ok": True,
                    "service": "jamsa-cctv-server",
                    "version": "1.0",
                    "nvrs": len(CONFIG.get("nvrs", [])),
                    "channels": channels,
                    "port": PORT,
                    "time": datetime.now().isoformat(),
                }, ensure_ascii=False).encode("utf-8"))
                return

            # 채널 정보
            if path == "/api/channels":
                out = []
                for idx, n in enumerate(CONFIG.get("nvrs", [])):
                    for ch, name in (n.get("channels") or {}).items():
                        out.append({"nvr": idx, "nvrName": n.get("name"), "ch": int(ch), "name": name})
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "channels": out}, ensure_ascii=False).encode("utf-8"))
                return

            # 설정 export (잠사 패널 자동 등록용)
            if path == "/api/config-snapshot":
                configs = []
                for idx, n in enumerate(CONFIG.get("nvrs", [])):
                    configs.append({
                        "id": f"server_{idx}_{int(time.time())}",
                        "name": n.get("name", f"NVR {idx+1}"),
                        "brand": n.get("brand", "dahua"),
                        "host": n.get("host"),
                        "port": n.get("port", 80),
                        "rtspPort": n.get("rtsp_port", 554),
                        "username": n.get("username"),
                        "channels": [{"ch": int(c), "name": name} for c, name in (n.get("channels") or {}).items()],
                        "source": "server_auto",
                    })
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "configs": configs, "exportedAt": datetime.now().isoformat()}, ensure_ascii=False).encode("utf-8"))
                return

            # 스냅샷 프록시: /api/snap/:ch?nvr=0
            if path.startswith("/api/snap/"):
                try:
                    ch = int(path.split("/api/snap/")[1].split("/")[0].split("?")[0])
                except ValueError:
                    self.send_error(400, "invalid channel")
                    return
                nvr_idx = int(params.get("nvr", ["0"])[0])
                nvrs = CONFIG.get("nvrs", [])
                if nvr_idx >= len(nvrs):
                    self.send_error(404, "nvr not configured")
                    return
                nvr = nvrs[nvr_idx]
                snap_path = build_snapshot_path(nvr, ch)
                url = f"http://{nvr['host']}:{nvr.get('port', 80)}{snap_path}"

                # Basic Auth
                username = nvr.get("username", "")
                password = nvr.get("password", "")
                auth = base64.b64encode(f"{username}:{password}".encode()).decode()
                req = urllib.request.Request(url, headers={
                    "Authorization": f"Basic {auth}",
                    "User-Agent": "jamsa-cctv-server/1.0"
                })
                try:
                    with urllib.request.urlopen(req, timeout=8) as upstream:
                        content_type = upstream.headers.get("Content-Type", "image/jpeg")
                        data = upstream.read()
                    self.send_response(200)
                    self._cors()
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except urllib.error.HTTPError as e:
                    if e.code == 401:
                        self.send_error(401, f"NVR auth failed (check username/password) host={nvr['host']}")
                    else:
                        self.send_error(e.code, f"NVR error: {e.reason}")
                except Exception as e:
                    self.send_error(502, f"NVR connection error: {e}")
                return

            # 404
            self.send_response(404)
            self._cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"not found. Endpoints: /api/status, /api/snap/:ch, /api/channels, /api/config-snapshot")
        except Exception as e:
            sys.stderr.write(f"[ERROR] {e}\n")
            try:
                self.send_error(500, str(e))
            except: pass

# ─── 멀티스레드 서버 ────────────────────────────────────────────
class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    print("═" * 60)
    print(" 🏛️  잠사박물관 CCTV 서버 v1.0")
    print("═" * 60)
    print(f" 📡 포트: {PORT}")
    print(f" 📄 설정: {CONFIG_PATH}")
    print(f" 📹 NVR: {len(CONFIG.get('nvrs', []))}대")
    for i, n in enumerate(CONFIG.get("nvrs", [])):
        chs = len(n.get("channels", {}))
        print(f"    [{i}] {n.get('name')} ({n.get('brand')}) {n.get('host')}:{n.get('port', 80)} · {chs}채널")
    # LAN IP
    try:
        hostname = socket.gethostname()
        lan_ip = socket.gethostbyname(hostname)
    except: lan_ip = "127.0.0.1"
    print("═" * 60)
    print(f" ✅ 접속 주소:")
    print(f"    http://localhost:{PORT}")
    print(f"    http://{lan_ip}:{PORT}  (LAN 내 다른 기기에서 접속)")
    print("═" * 60)
    print(f" 🌐 잠사 패널 설정:")
    print(f"    안전관리 → IoT 안전제어 → 📹 NVR/VMS 탭")
    print(f"    로컬 브릿지 입력: http://localhost:{PORT}")
    print("═" * 60)
    print()
    try:
        with ThreadedServer(("0.0.0.0", PORT), CCTVHandler) as server:
            server.serve_forever()
    except KeyboardInterrupt:
        print("\n[중지] 사용자 요청으로 종료")
    except OSError as e:
        if "이미 사용 중" in str(e) or "Address already in use" in str(e):
            print(f"\n❌ 포트 {PORT}가 이미 사용 중입니다.")
            print(f"   기존 CCTV 서버가 실행 중인지 확인하세요.")
        else:
            print(f"\n❌ 시작 실패: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
