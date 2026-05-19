#!/usr/bin/env bash
# 잠사 비콘 엣지 서버 실행 (Linux/Mac)
set -e
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt
exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8088
