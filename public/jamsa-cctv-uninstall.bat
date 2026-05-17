@echo off
chcp 65001 >nul
REM 잠사 CCTV 자동 가동 제거

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ❌ 관리자 권한 필요. 우클릭 → 관리자 권한으로 실행.
    pause
    exit /b 1
)

echo 작업 스케줄러에서 JamsaCCTVServer 제거 중...
schtasks /End /TN "JamsaCCTVServer" >nul 2>&1
schtasks /Delete /TN "JamsaCCTVServer" /F
echo.
echo 방화벽 규칙 제거 중...
netsh advfirewall firewall delete rule name="Jamsa CCTV Server" >nul 2>&1
echo.
echo ✅ 자동 가동 제거 완료
pause
