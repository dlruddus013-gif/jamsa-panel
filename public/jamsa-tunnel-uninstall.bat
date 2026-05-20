@echo off
chcp 65001 >nul
title 잠사 터널 제거
echo.
echo ════════════════════════════════════════════════
echo  🗑  잠사 Cloudflare 터널 제거
echo ════════════════════════════════════════════════
echo.
net session >nul 2>&1
if %errorLevel% neq 0 ( echo ❌ 관리자 권한 필요 & pause & exit /b 1 )

set "SAFE_EXE=%ProgramData%\jamsa-tunnel\cloudflared.exe"

echo - 헬스체크 작업 제거...
schtasks /Delete /TN "JamsaTunnelHealthcheck" /F >nul 2>&1

echo - 서비스 중지 + 제거...
sc stop cloudflared >nul 2>&1
timeout /t 2 /nobreak >nul
if exist "%SAFE_EXE%" "%SAFE_EXE%" service uninstall >nul 2>&1
sc delete cloudflared >nul 2>&1

echo.
echo ✅ 제거 완료 (config.yml 및 credentials는 보존됨: %USERPROFILE%\.cloudflared\)
echo.
pause
