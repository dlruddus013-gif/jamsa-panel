"""Pydantic 스키마 — 게이트웨이 payload 유연 수용"""
from typing import Optional, Any, Dict, List
from pydantic import BaseModel, Field


class BeaconLogInput(BaseModel):
    """게이트웨이가 보낼 수 있는 모든 필드 (모두 선택)
    추가 필드는 raw_payload로 별도 저장."""
    uuid: Optional[str] = None
    mac: Optional[str] = None
    beacon_id: Optional[str] = None
    major: Optional[int] = None
    minor: Optional[int] = None
    rssi: Optional[float] = None
    tx_power: Optional[float] = None
    gateway_id: Optional[str] = None
    gateway_name: Optional[str] = None
    ip: Optional[str] = None
    timestamp: Optional[str] = None
    raw: Optional[Any] = None
    model_config = {"extra": "allow"}


class BeaconLogRecord(BaseModel):
    id: int
    received_at: str
    gateway_id: Optional[str] = None
    gateway_name: Optional[str] = None
    uuid: Optional[str] = None
    mac: Optional[str] = None
    beacon_id: Optional[str] = None
    major: Optional[int] = None
    minor: Optional[int] = None
    rssi: Optional[float] = None
    tx_power: Optional[float] = None
    source_ip: Optional[str] = None
    raw_payload: Optional[Dict[str, Any]] = None
    resolved: Optional[Dict[str, Any]] = None


class LogResponse(BaseModel):
    ok: bool
    received_at: str
    id: int
    resolved: Optional[Dict[str, Any]] = None


class LogsListResponse(BaseModel):
    ok: bool
    count: int
    logs: List[BeaconLogRecord]


class LatestResponse(BaseModel):
    ok: bool
    count: int
    beacons: List[BeaconLogRecord]
