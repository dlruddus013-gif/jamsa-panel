@echo off
chcp 65001 >nul
REM ════════════════════════════════════════════════
REM  Jamsa CCTV Server — 즉시 시작 + 자동 재시작 워치독
REM  스크립트가 죽으면 자동으로 재시작 (창 닫으면 멈춤)
REM ════════════════════════════════════════════════

title 🏛️ 잠사 CCTV 서버 (창 닫지 마세요!)

set "CCTV_PATH=%~dp0cctv.py"
if not exist "%CCTV_PATH%" (
    echo.
    echo ⚠️  같은 폴더에 cctv.py를 두고 다시 실행하세요.
    echo    현재 폴더: %~dp0
    echo.
    pause
    exit /b 1
)

:loop
echo.
echo ════════════════════════════════════════════════
echo  🏛️  잠사박물관 CCTV 서버 시작 — %date% %time%
echo ════════════════════════════════════════════════
echo.
echo 📡 포트 5555 가동 중...
echo 🌐 클라우드: https://cctv.thejamsa.com 으로 연결됨
echo.
echo 💡 창을 닫으면 서버가 멈춥니다.
echo    24/7 자동 가동을 원하면 jamsa-cctv-install.bat 실행.
echo.
python "%CCTV_PATH%"

echo.
echo ⚠️  서버가 종료됨 — 5초 후 자동 재시작
timeout /t 5 /nobreak >nul
goto loop
