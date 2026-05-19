"""FastAPI 메인 — HTTP 수신 + 조회 + SSE + 대시보드"""
import asyncio
import json
from typing import Optional, Any, Dict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Query, HTTPException
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from . import storage
from .config import STATIC_DIR, load_beacon_map, PORT, HOST
from .models import normalize, annotate
from .realtime import broker


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init()
    print(f"[beacon-edge] 서버 시작 — http://{HOST}:{PORT}")
    print(f"[beacon-edge] 대시보드: http://{HOST}:{PORT}/dashboard")
    print(f"[beacon-edge] POST 엔드포인트: http://{HOST}:{PORT}/api/beacon/log")
    yield
    print("[beacon-edge] 서버 종료")


app = FastAPI(title="Jamsa Beacon Edge Server", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ─── 페이로드 파싱: JSON / form / x-www-form-urlencoded 모두 수용 ──
async def _read_payload(request: Request) -> Dict[str, Any]:
    ct = (request.headers.get("content-type") or "").lower()
    body = await request.body()
    if not body:
        return {}
    # 1) JSON 우선
    if "application/json" in ct or body.lstrip().startswith((b"{", b"[")):
        try:
            data = json.loads(body)
            if isinstance(data, dict):
                return data
            if isinstance(data, list):
                # 배열로 오면 obj/beacons 키처럼 처리
                return {"beacons": data}
            return {"raw": data}
        except Exception:
            pass
    # 2) form 류 (python-multipart 미설치 환경에서도 동작하도록 수동 파싱)
    if "x-www-form-urlencoded" in ct:
        try:
            from urllib.parse import parse_qs
            qs = body.decode("utf-8", errors="replace")
            parsed = parse_qs(qs, keep_blank_values=True)
            return {k: (v[0] if len(v) == 1 else v) for k, v in parsed.items()}
        except Exception:
            pass
    if "multipart/form-data" in ct:
        try:
            form = await request.form()
            return {k: (v if isinstance(v, str) else getattr(v, "filename", str(v))) for k, v in form.items()}
        except Exception as e:
            # python-multipart 미설치 시
            return {"_form_parse_failed": str(e), "raw_text": body.decode("utf-8", errors="replace")}
    # 3) 일반 텍스트 fallback
    try:
        return {"raw_text": body.decode("utf-8", errors="replace")}
    except Exception:
        return {"raw_bytes": str(body)}


def _client_ip(request: Request) -> Optional[str]:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


# ─── 엔드포인트 ──────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "subscribers": broker.subscriber_count}


@app.post("/api/beacon/log")
async def post_beacon_log(request: Request):
    """게이트웨이 메인 수신부.
    JSON/form/raw 모두 받음. 정의되지 않은 필드도 raw_payload로 저장."""
    try:
        payload = await _read_payload(request)
        norm = normalize(payload)
        # 게이트웨이가 [array of beacons] 또는 {obj:[...]} 형태로 여러 건 묶어 보내는 경우 분해
        items = []
        if isinstance(payload.get("obj"), list):
            items = payload["obj"]
        elif isinstance(payload.get("beacons"), list):
            items = payload["beacons"]
        elif isinstance(payload.get("data"), list):
            items = payload["data"]

        ip = _client_ip(request)
        saved = []

        if items:
            # 다건: 공통 gateway 필드 + 각 비콘
            for it in items:
                merged = {**norm, **normalize(it if isinstance(it, dict) else {"raw": it})}
                rec = storage.insert(merged, raw_payload={**payload, "_item": it}, source_ip=ip)
                rec = annotate(rec)
                saved.append(rec)
                print(f"[수신] gw={merged.get('gateway_id')} mac={merged.get('mac')} maj/min={merged.get('major')}/{merged.get('minor')} rssi={merged.get('rssi')}")
                await broker.publish({"type": "beacon_log", "record": rec})
        else:
            # 단건
            rec = storage.insert(norm, raw_payload=payload, source_ip=ip)
            rec = annotate(rec)
            saved.append(rec)
            print(f"[수신] gw={norm.get('gateway_id')} mac={norm.get('mac')} maj/min={norm.get('major')}/{norm.get('minor')} rssi={norm.get('rssi')} ip={ip}")
            await broker.publish({"type": "beacon_log", "record": rec})

        last = saved[-1] if saved else None
        return {
            "ok": True,
            "received_at": last.get("received_at") if last else None,
            "id": last.get("id") if last else None,
            "count": len(saved),
            "resolved": last.get("resolved") if last else None,
        }
    except Exception as e:
        # 전체 서버 죽지 않도록 swallow + 200 OK (게이트웨이 재시도 방지)
        print(f"[ERROR] beacon log 수신 실패: {e}")
        return JSONResponse(status_code=200, content={"ok": False, "error": str(e)})


@app.get("/api/beacon/logs")
async def get_logs(
    limit: int = Query(100, ge=1, le=5000),
    gateway_id: Optional[str] = None,
    major: Optional[int] = None,
    minor: Optional[int] = None,
    since: Optional[str] = None,
):
    logs = storage.list_logs(limit=limit, gateway_id=gateway_id, major=major, minor=minor, since=since)
    return {
        "ok": True,
        "count": len(logs),
        "logs": [annotate(r) for r in logs],
    }


@app.get("/api/beacon/latest")
async def get_latest():
    rows = storage.latest_per_beacon()
    return {
        "ok": True,
        "count": len(rows),
        "beacons": [annotate(r) for r in rows],
    }


@app.get("/api/beacon/events")
async def beacon_events(request: Request):
    """SSE — 새 비콘 로그 들어오면 즉시 push"""
    q = await broker.subscribe()

    async def stream():
        try:
            # 초기 hello
            yield f"event: hello\ndata: {json.dumps({'subscribers': broker.subscriber_count})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"event: beacon_log\ndata: {data}\n\n"
                except asyncio.TimeoutError:
                    # keepalive ping
                    yield ": keepalive\n\n"
        finally:
            await broker.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


@app.get("/api/config/beacon_map")
async def get_beacon_map():
    return {"ok": True, "map": load_beacon_map()}


# ─── 대시보드 ────────────────────────────────────────────────────
@app.get("/")
@app.get("/dashboard")
async def dashboard():
    f = STATIC_DIR / "dashboard.html"
    if f.exists():
        return FileResponse(f)
    raise HTTPException(404, "dashboard not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)
