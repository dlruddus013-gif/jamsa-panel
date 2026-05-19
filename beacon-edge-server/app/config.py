"""설정 로더 — beacon_map.json + 환경변수"""
import json
import os
from pathlib import Path
from typing import Dict, Any, Optional

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"

DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

SQLITE_PATH = DATA_DIR / "beacon_logs.sqlite"
JSONL_PATH = DATA_DIR / "beacon_logs.jsonl"
BEACON_MAP_PATH = CONFIG_DIR / "beacon_map.json"

PORT = int(os.environ.get("PORT", "8088"))
HOST = os.environ.get("HOST", "0.0.0.0")

_DEFAULT_MAP = {
    "locations": [
        {"major": 1, "minor": 1, "name": "전시실 1"},
        {"major": 1, "minor": 2, "name": "전시실 2"},
    ],
    "staff": [
        {"major": 100, "minor": 1, "name": "직원 테스트 태그"},
    ],
}


def load_beacon_map() -> Dict[str, Any]:
    """beacon_map.json 로드. 없으면 기본값 생성."""
    if not BEACON_MAP_PATH.exists():
        BEACON_MAP_PATH.write_text(
            json.dumps(_DEFAULT_MAP, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    try:
        return json.loads(BEACON_MAP_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[config] beacon_map.json 파싱 오류: {e} — 기본값 사용")
        return _DEFAULT_MAP


def resolve_beacon(major: Optional[int], minor: Optional[int]) -> Optional[Dict[str, Any]]:
    """major/minor → 위치명 또는 직원명 매핑"""
    if major is None or minor is None:
        return None
    bm = load_beacon_map()
    for entry in bm.get("locations", []):
        if entry.get("major") == major and entry.get("minor") == minor:
            return {"kind": "location", "name": entry.get("name"), **entry}
    for entry in bm.get("staff", []):
        if entry.get("major") == major and entry.get("minor") == minor:
            return {"kind": "staff", "name": entry.get("name"), **entry}
    return None
