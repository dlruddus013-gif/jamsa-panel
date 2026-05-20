@echo off
chcp 65001 >nul
REM ════════════════════════════════════════════════
REM  Jamsa Cloudflare Tunnel — 24/7 자동 가동 + 헬스체크 자동복구
REM  cctv.thejamsa.com  ─→  localhost:5556 (cctv.py)
REM ════════════════════════════════════════════════
setlocal enabledelayedexpansion
title 잠사 Cloudflare 터널 24/7 설치

echo.
echo ════════════════════════════════════════════════
echo  🌐 잠사박물관 CCTV 터널 24/7 자동 복구 설치
echo ════════════════════════════════════════════════
echo.

REM 1. 관리자 권한
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ❌ 관리자 권한 필요. 우클릭 → "관리자 권한으로 실행"
    pause & exit /b 1
)
echo ✓ 관리자 권한 OK

REM 2. 안전 경로 결정 (다운로드 폴더 → ProgramData로 이전)
set "SAFE_DIR=%ProgramData%\jamsa-tunnel"
set "SAFE_EXE=%SAFE_DIR%\cloudflared.exe"
if not exist "%SAFE_DIR%" mkdir "%SAFE_DIR%" 2>nul

REM 3. cloudflared.exe 위치 탐색 (현재 폴더 → 다운로드 → ProgramData 순)
set "SRC_EXE="
if exist "%~dp0cloudflared.exe" set "SRC_EXE=%~dp0cloudflared.exe"
if "!SRC_EXE!"=="" if exist "%USERPROFILE%\Downloads\files - 2026-05-03T220423.353\cloudflared.exe" set "SRC_EXE=%USERPROFILE%\Downloads\files - 2026-05-03T220423.353\cloudflared.exe"
if "!SRC_EXE!"=="" if exist "%SAFE_EXE%" set "SRC_EXE=%SAFE_EXE%"

if "!SRC_EXE!"=="" (
    echo 📥 cloudflared.exe 다운로드 중 ^(Cloudflare 공식^)...
    powershell -Command "try { Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%SAFE_EXE%' -UseBasicParsing; exit 0 } catch { exit 1 }"
    if !errorLevel! neq 0 (
        echo ❌ 다운로드 실패. 인터넷 확인 후 재시도.
        pause & exit /b 1
    )
    set "SRC_EXE=%SAFE_EXE%"
    echo ✓ 다운로드 완료
)

REM 4. ProgramData로 복사 (안전 경로)
if /i not "!SRC_EXE!"=="%SAFE_EXE%" (
    echo 📦 안전 경로로 복사: %SAFE_EXE%
    copy /Y "!SRC_EXE!" "%SAFE_EXE%" >nul
)
echo ✓ 실행 파일: %SAFE_EXE%

REM 5. config.yml / credentials 확인
set "CFG_SRC=%USERPROFILE%\.cloudflared"
if not exist "%CFG_SRC%\config.yml" (
    echo ❌ %CFG_SRC%\config.yml 없음. 터널을 먼저 생성하세요:
    echo    "%SAFE_EXE%" tunnel login
    echo    "%SAFE_EXE%" tunnel create jamsa-cctv
    pause & exit /b 1
)
echo ✓ 터널 설정: %CFG_SRC%\config.yml

REM 6. 기존 cloudflared 서비스 정리
sc query cloudflared >nul 2>&1
if %errorLevel% equ 0 (
    echo - 기존 서비스 발견, 중지 및 제거...
    sc stop cloudflared >nul 2>&1
    timeout /t 2 /nobreak >nul
    "%SAFE_EXE%" service uninstall >nul 2>&1
    sc delete cloudflared >nul 2>&1
    timeout /t 2 /nobreak >nul
)

REM 7. 새 서비스 등록 (안전 경로 기준)
echo Windows 서비스 등록 중...
"%SAFE_EXE%" service install
if !errorLevel! neq 0 (
    echo ❌ 서비스 등록 실패
    pause & exit /b 1
)

REM 자동 시작 + 실패시 자동 재시작
sc config cloudflared start= auto >nul 2>&1
sc failure cloudflared reset= 86400 actions= restart/30000/restart/30000/restart/60000 >nul 2>&1
echo ✓ 서비스 등록 + 자동 재시작 정책 적용

REM 8. 서비스 시작
sc start cloudflared >nul 2>&1
timeout /t 4 /nobreak >nul

REM 9. 헬스체크 작업 등록 (1분마다 도메인 확인 → 죽었으면 서비스 재시작)
set "HC_TASK=JamsaTunnelHealthcheck"
set "HC_SCRIPT=%SAFE_DIR%\healthcheck.ps1"

> "%HC_SCRIPT%" echo $url = 'https://cctv.thejamsa.com/'
>> "%HC_SCRIPT%" echo $logFile = 'C:\ProgramData\jamsa-tunnel\healthcheck.log'
>> "%HC_SCRIPT%" echo $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
>> "%HC_SCRIPT%" echo try {
>> "%HC_SCRIPT%" echo   $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8 -MaximumRedirection 1 -ErrorAction Stop
>> "%HC_SCRIPT%" echo   if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { "[$ts] OK $($r.StatusCode)" ^| Add-Content $logFile; exit 0 }
>> "%HC_SCRIPT%" echo   throw "Unexpected status $($r.StatusCode)"
>> "%HC_SCRIPT%" echo } catch {
>> "%HC_SCRIPT%" echo   "[$ts] FAIL $($_.Exception.Message) — restart" ^| Add-Content $logFile
>> "%HC_SCRIPT%" echo   try { Restart-Service -Name 'cloudflared' -Force -ErrorAction Stop } catch { Start-Service -Name 'cloudflared' -ErrorAction SilentlyContinue }
>> "%HC_SCRIPT%" echo }

schtasks /Query /TN "%HC_TASK%" >nul 2>&1
if %errorLevel% equ 0 schtasks /Delete /TN "%HC_TASK%" /F >nul 2>&1
schtasks /Create /TN "%HC_TASK%" /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%HC_SCRIPT%\"" /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /F >nul
if !errorLevel! equ 0 (
    echo ✓ 헬스체크 작업 등록 ^(1분마다 자동 확인^)
) else (
    echo ⚠ 헬스체크 등록 실패 ^(서비스만 작동^)
)

REM 10. 최종 확인
echo.
echo 동작 확인 중 ^(5초^)...
timeout /t 5 /nobreak >nul
powershell -Command "try { $r = Invoke-WebRequest -Uri 'https://cctv.thejamsa.com/' -UseBasicParsing -TimeoutSec 8; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { Write-Host '✅ cctv.thejamsa.com 정상 응답 (HTTP' $r.StatusCode ')' -ForegroundColor Green } else { Write-Host '⚠ 응답 코드:' $r.StatusCode -ForegroundColor Yellow } } catch { Write-Host '⚠ 아직 응답 없음 — 30초 후 재시도 권장' -ForegroundColor Yellow }"

echo.
echo ════════════════════════════════════════════════
echo ✅ 설치 완료
echo ════════════════════════════════════════════════
echo.
echo 📂 설치 경로: %SAFE_DIR%
echo 📋 헬스체크 로그: %SAFE_DIR%\healthcheck.log
echo.
echo 🔧 관리 명령:
echo   서비스 상태:  sc query cloudflared
echo   서비스 재시작: sc stop cloudflared ^&^& sc start cloudflared
echo   터널 정보:    "%SAFE_EXE%" tunnel info 4205544b-1e55-4d8b-82a6-bd74573e6146
echo   로그 보기:    notepad %SAFE_DIR%\healthcheck.log
echo.
pause
