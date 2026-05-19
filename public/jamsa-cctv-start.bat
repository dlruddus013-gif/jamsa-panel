@echo off
chcp 65001 >nul
REM 잠사 CCTV 서버 — 즉시 시작 (창 닫으면 멈춤)
title 🏛️ 잠사 CCTV 서버 (창 닫지 마세요!)

REM Python 확인
where python >nul 2>&1
if %errorLevel% neq 0 (
    echo ❌ Python이 없습니다. https://www.python.org/downloads/ 에서 설치 후 재실행.
    pause
    exit /b 1
)

REM cctv.py 자동 다운로드
set "CCTV_PATH=%~dp0cctv.py"
if not exist "%CCTV_PATH%" (
    echo 📥 cctv.py 자동 다운로드 중...
    powershell -Command "try { Invoke-WebRequest -Uri 'https://jamsa-panel.vercel.app/cctv.py' -OutFile '%CCTV_PATH%' -UseBasicParsing; exit 0 } catch { exit 1 }"
    if !errorLevel! neq 0 (
        echo ❌ 다운로드 실패. 인터넷 확인 후 재시도.
        pause
        exit /b 1
    )
    echo ✓ 다운로드 완료
)

:loop
echo.
echo ════════════════════════════════════════════════
echo  🏛️ 잠사 CCTV 서버 — %date% %time%
echo ════════════════════════════════════════════════
echo.
echo 📡 포트 5555 가동
echo 💡 창을 닫으면 서버 중지 — 24/7은 jamsa-cctv-install.bat 권장
echo.
python "%CCTV_PATH%"
echo.
echo ⚠️ 서버 종료 — 5초 후 자동 재시작
timeout /t 5 /nobreak >nul
goto loop
