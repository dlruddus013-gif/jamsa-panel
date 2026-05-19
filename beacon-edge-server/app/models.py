"""도메인 모델 — payload 정규화 + 매핑 해석

게이트웨이마다 보내는 필드 이름이 다를 수 있어서 (mac/macAddress/bleMac 등),
여기서 표준 필드로 정규화한다.
"""
from typing import Any, Dict, Optional

from .config import resolve_beacon


def _to_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        try:
            return int(float(v))
        except Exception:
            return None


def _to_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _first_str(payload: Dict[str, Any], keys: list) -> Optional[str]:
    for k in keys:
        v = payload.get(k)
        if v is not None and v != "":
            return str(v)
    return None


def normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    """게이트웨이 payload → 표준 record 필드.
    원본 payload는 호출자가 raw_payload로 별도 보관."""
    return {
        "uuid": _first_str(payload, ["uuid", "UUID", "Uuid"]),
        "mac": _first_str(payload, ["mac", "MAC", "macAddress", "mac_address", "bleMac", "device_mac"]),
        "beacon_id": _first_str(payload, ["beacon_id", "beaconId", "id", "tag_id"]),
        "major": _to_int(payload.get("major") or payload.get("Major")),
        "minor": _to_int(payload.get("minor") or payload.get("Minor")),
        "rssi": _to_float(payload.get("rssi") or payload.get("RSSI")),
        "tx_power": _to_float(payload.get("tx_power") or payload.get("txPower") or payload.get("TxPower")),
        "gateway_id": _first_str(payload, ["gateway_id", "gatewayId", "gw_id", "gw_mac", "gmac", "deviceMac"]),
        "gateway_name": _first_str(payload, ["gateway_name", "gatewayName", "gw_name"]),
        "timestamp": _first_str(payload, ["timestamp", "ts", "time"]),
    }


def annotate(record: Dict[str, Any]) -> Dict[str, Any]:
    """저장된 record에 beacon_map 매핑 결과 추가"""
    resolved = resolve_beacon(record.get("major"), record.get("minor"))
    return {**record, "resolved": resolved}
