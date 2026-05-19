@echo off
chcp 65001 >nul
REM 잠사 비콘 엣지 서버 실행 (Windows)
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088
pause
