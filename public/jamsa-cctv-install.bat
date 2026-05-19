@echo off
chcp 65001 >nul
REM ════════════════════════════════════════════════
REM  Jamsa CCTV Server — 올인원 24/7 자동 가동 설치
REM  Python 확인 + cctv.py 자동 다운로드 + 작업 스케줄러 등록
REM ════════════════════════════════════════════════

setlocal enabledelayedexpansion
title 잠사 CCTV 24/7 자동 가동 설치

echo.
echo ════════════════════════════════════════════════
echo  🏛️  잠사박물관 CCTV 24/7 자동 가동 설치
echo ════════════════════════════════════════════════
echo.

REM 1. 관리자 권한 확인
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ❌ 관리자 권한이 필요합니다.
    echo.
    echo 이 파일을 마우스 우클릭 → "관리자 권한으로 실행"
    echo.
    pause
    exit /b 1
)
echo ✓ 관리자 권한 OK
echo.

REM 2. Python 확인 (없으면 Microsoft Store 자동 안내)
where python >nul 2>&1
if %errorLevel% neq 0 (
    echo ⚠️  Python이 설치되어 있지 않습니다.
    echo.
    echo Python 설치 옵션:
    echo   1^) Microsoft Store에서 자동 설치 (권장)
    echo   2^) 직접 설치 (https://www.python.org/downloads/)
    echo.
    set /p PY_CHOICE="Microsoft Store로 자동 설치할까요? (Y/N): "
    if /i "!PY_CHOICE!"=="Y" (
        echo Microsoft Store 실행 중...
        start ms-windows-store://pdp/?ProductId=9NRWMJP3717K
        echo.
        echo Python 설치 완료 후 이 창에서 아무 키나 누르세요.
        pause
        REM 다시 확인
        where python >nul 2>&1
        if !errorLevel! neq 0 (
            echo ❌ Python을 찾을 수 없습니다. 설치 후 재실행하세요.
            pause
            exit /b 1
        )
    ) else (
        echo Python을 직접 설치한 후 이 파일을 다시 실행하세요.
        start https://www.python.org/downloads/
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%i in ('where python') do set "PYTHON_PATH=%%i"
echo ✓ Python 발견: %PYTHON_PATH%

REM Python 버전 확인 (3.7+)
for /f "tokens=2 delims= " %%i in ('python --version 2^>^&1') do set "PY_VER=%%i"
echo   버전: !PY_VER!
echo.

REM 3. cctv.py 경로 결정 (현재 폴더 우선, 없으면 자동 다운로드)
set "INSTALL_DIR=%USERPROFILE%\jamsa-cctv"
set "CCTV_PATH=%INSTALL_DIR%\cctv.py"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%" 2>nul

REM 같은 폴더에 cctv.py가 있으면 사용
if exist "%~dp0cctv.py" (
    echo ✓ 현재 폴더에서 cctv.py 발견
    copy /Y "%~dp0cctv.py" "%CCTV_PATH%" >nul
) else if exist "%CCTV_PATH%" (
    echo ✓ 기존 설치: %CCTV_PATH%
) else (
    echo 📥 cctv.py 자동 다운로드 중...
    powershell -Command "try { Invoke-WebRequest -Uri 'https://jamsa-panel.vercel.app/cctv.py' -OutFile '%CCTV_PATH%' -UseBasicParsing; exit 0 } catch { exit 1 }"
    if !errorLevel! neq 0 (
        echo ❌ 다운로드 실패. 인터넷 연결 확인 후 재시도하세요.
        pause
        exit /b 1
    )
    echo ✓ 다운로드 완료: %CCTV_PATH%
)
echo.

REM 4. cctv_config.json 안내
set "CONFIG_PATH=%INSTALL_DIR%\cctv_config.json"
if not exist "%CONFIG_PATH%" (
    echo 📋 NVR 설정 파일이 생성됩니다 (첫 실행 시 자동 생성).
    echo    설치 후 메모장으로 열어서 NVR 정보 입력:
    echo    %CONFIG_PATH%
    echo.
)

REM 5. Windows 작업 스케줄러 등록
set "TASK_NAME=JamsaCCTVServer"
echo Windows 작업 스케줄러에 등록 중...
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if %errorLevel% equ 0 (
    echo - 기존 작업 발견, 제거 중...
    schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
)

set "XML_PATH=%TEMP%\jamsa-cctv-task.xml"
(
echo ^<?xml version="1.0" encoding="UTF-16"?^>
echo ^<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"^>
echo   ^<RegistrationInfo^>^<Author^>JamsaMuseum^</Author^>^<Description^>잠사 CCTV 24/7^</Description^>^</RegistrationInfo^>
echo   ^<Triggers^>
echo     ^<BootTrigger^>^<Enabled^>true^</Enabled^>^</BootTrigger^>
echo     ^<LogonTrigger^>^<Enabled^>true^</Enabled^>^</LogonTrigger^>
echo   ^</Triggers^>
echo   ^<Principals^>^<Principal id="Author"^>^<UserId^>S-1-5-18^</UserId^>^<RunLevel^>HighestAvailable^</RunLevel^>^</Principal^>^</Principals^>
echo   ^<Settings^>
echo     ^<MultipleInstancesPolicy^>IgnoreNew^</MultipleInstancesPolicy^>
echo     ^<DisallowStartIfOnBatteries^>false^</DisallowStartIfOnBatteries^>
echo     ^<StopIfGoingOnBatteries^>false^</StopIfGoingOnBatteries^>
echo     ^<AllowHardTerminate^>true^</AllowHardTerminate^>
echo     ^<StartWhenAvailable^>true^</StartWhenAvailable^>
echo     ^<Enabled^>true^</Enabled^>
echo     ^<Hidden^>false^</Hidden^>
echo     ^<ExecutionTimeLimit^>PT0S^</ExecutionTimeLimit^>
echo     ^<RestartOnFailure^>^<Interval^>PT1M^</Interval^>^<Count^>999^</Count^>^</RestartOnFailure^>
echo   ^</Settings^>
echo   ^<Actions Context="Author"^>
echo     ^<Exec^>
echo       ^<Command^>%PYTHON_PATH%^</Command^>
echo       ^<Arguments^>"%CCTV_PATH%"^</Arguments^>
echo       ^<WorkingDirectory^>%INSTALL_DIR%^</WorkingDirectory^>
echo     ^</Exec^>
echo   ^</Actions^>
echo ^</Task^>
) > "%XML_PATH%"

schtasks /Create /TN "%TASK_NAME%" /XML "%XML_PATH%" /F
if %errorLevel% neq 0 (
    echo.
    echo ❌ 작업 등록 실패. 위 오류 확인.
    pause
    exit /b 1
)
del "%XML_PATH%" >nul 2>&1
echo ✓ 작업 스케줄러 등록 완료

REM 6. 방화벽 5555 포트 허용
netsh advfirewall firewall delete rule name="Jamsa CCTV Server" >nul 2>&1
netsh advfirewall firewall add rule name="Jamsa CCTV Server" dir=in action=allow protocol=TCP localport=5555 >nul 2>&1
echo ✓ 방화벽 5555 포트 허용

REM 7. 지금 시작
echo.
echo CCTV 서버를 지금 시작합니다...
schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
timeout /t 3 /nobreak >nul
echo.

REM 8. 동작 확인
echo 동작 확인 중...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:5555/api/status' -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { Write-Host '✅ CCTV 서버 정상 작동' -ForegroundColor Green } else { Write-Host '⚠️ 응답 코드: ' $r.StatusCode -ForegroundColor Yellow } } catch { Write-Host '⚠️ 서버 응답 없음 — 30초 후 다시 확인하세요' -ForegroundColor Yellow; Write-Host '   (Python 모듈 로딩 시간 필요)' }"
echo.

echo ════════════════════════════════════════════════
echo ✅ 설치 완료!
echo ════════════════════════════════════════════════
echo.
echo 📂 설치 위치: %INSTALL_DIR%
echo    • cctv.py — 서버 프로그램
echo    • cctv_config.json — NVR 설정 (첫 실행 시 자동 생성)
echo.
echo 📋 다음 단계:
echo   1. 메모장으로 %CONFIG_PATH% 열기
echo   2. NVR host(IP), username, password 수정
echo   3. 채널 이름 추가
echo   4. 저장 후 작업 재시작:
echo      schtasks /End /TN "%TASK_NAME%"
echo      schtasks /Run /TN "%TASK_NAME%"
echo.
echo 🌐 잠사 패널에서 확인:
echo    http://localhost:5555/api/status (서버 확인)
echo    잠사 패널 새로고침 (Ctrl+Shift+R) → CCTV 자동 표시
echo.
echo 🔧 관리 명령:
echo   상태: schtasks /Query /TN "%TASK_NAME%"
echo   중지: schtasks /End /TN "%TASK_NAME%"
echo   시작: schtasks /Run /TN "%TASK_NAME%"
echo   제거: jamsa-cctv-uninstall.bat (관리자 권한)
echo.
pause
