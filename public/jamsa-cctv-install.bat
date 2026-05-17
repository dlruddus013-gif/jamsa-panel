@echo off
chcp 65001 >nul
REM ════════════════════════════════════════════════
REM  Jamsa CCTV Server — 24/7 자동 가동 설치 스크립트
REM  관리자 권한으로 실행 → Windows Task Scheduler 등록
REM  PC 부팅 시 자동 시작 + 죽으면 자동 재시작 (1분 후, 999회까지)
REM ════════════════════════════════════════════════

setlocal enabledelayedexpansion

echo.
echo ════════════════════════════════════════════════
echo  🏛️  잠사박물관 CCTV 서버 — 24/7 자동 가동 설치
echo ════════════════════════════════════════════════
echo.

REM 관리자 권한 확인
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ❌ 관리자 권한이 필요합니다.
    echo.
    echo 이 파일을 "마우스 우클릭 → 관리자 권한으로 실행" 해주세요.
    echo.
    pause
    exit /b 1
)

echo ✓ 관리자 권한 확인됨
echo.

REM CCTV 스크립트 위치 입력
set "DEFAULT_PATH=%USERPROFILE%\jamsa-cctv\cctv.py"
echo CCTV 스크립트(cctv.py)의 전체 경로를 입력하세요.
echo (Enter만 누르면 기본값: %DEFAULT_PATH%)
set /p CCTV_PATH="경로: "
if "%CCTV_PATH%"=="" set "CCTV_PATH=%DEFAULT_PATH%"

if not exist "%CCTV_PATH%" (
    echo.
    echo ⚠️  파일을 찾을 수 없습니다: %CCTV_PATH%
    echo.
    echo cctv.py 파일을 먼저 다운로드 후 다시 실행하세요.
    pause
    exit /b 1
)

REM Python 경로 자동 탐지
for /f "tokens=*" %%i in ('where python 2^>nul') do set "PYTHON_PATH=%%i"
if "%PYTHON_PATH%"=="" (
    echo.
    echo ❌ Python이 설치되지 않았습니다.
    echo    https://www.python.org/downloads/ 에서 설치 후 재시도.
    pause
    exit /b 1
)

echo ✓ Python 발견: %PYTHON_PATH%
echo ✓ CCTV 스크립트: %CCTV_PATH%
echo.

REM 작업 스케줄러에 등록
set "TASK_NAME=JamsaCCTVServer"

echo Windows 작업 스케줄러에 등록 중...
echo.

REM 기존 작업 삭제 (있으면)
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if %errorLevel% equ 0 (
    echo - 기존 작업 발견, 삭제 중...
    schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
)

REM 작업 XML 생성
set "XML_PATH=%TEMP%\jamsa-cctv-task.xml"
(
echo ^<?xml version="1.0" encoding="UTF-16"?^>
echo ^<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"^>
echo   ^<RegistrationInfo^>
echo     ^<Author^>JamsaMuseum^</Author^>
echo     ^<Description^>잠사박물관 CCTV 서버 24/7 자동 가동^</Description^>
echo   ^</RegistrationInfo^>
echo   ^<Triggers^>
echo     ^<BootTrigger^>^<Enabled^>true^</Enabled^>^</BootTrigger^>
echo     ^<LogonTrigger^>^<Enabled^>true^</Enabled^>^</LogonTrigger^>
echo   ^</Triggers^>
echo   ^<Principals^>
echo     ^<Principal id="Author"^>
echo       ^<UserId^>S-1-5-18^</UserId^>
echo       ^<RunLevel^>HighestAvailable^</RunLevel^>
echo     ^</Principal^>
echo   ^</Principals^>
echo   ^<Settings^>
echo     ^<MultipleInstancesPolicy^>IgnoreNew^</MultipleInstancesPolicy^>
echo     ^<DisallowStartIfOnBatteries^>false^</DisallowStartIfOnBatteries^>
echo     ^<StopIfGoingOnBatteries^>false^</StopIfGoingOnBatteries^>
echo     ^<AllowHardTerminate^>true^</AllowHardTerminate^>
echo     ^<StartWhenAvailable^>true^</StartWhenAvailable^>
echo     ^<RunOnlyIfNetworkAvailable^>false^</RunOnlyIfNetworkAvailable^>
echo     ^<IdleSettings^>
echo       ^<StopOnIdleEnd^>false^</StopOnIdleEnd^>
echo       ^<RestartOnIdle^>false^</RestartOnIdle^>
echo     ^</IdleSettings^>
echo     ^<AllowStartOnDemand^>true^</AllowStartOnDemand^>
echo     ^<Enabled^>true^</Enabled^>
echo     ^<Hidden^>false^</Hidden^>
echo     ^<RunOnlyIfIdle^>false^</RunOnlyIfIdle^>
echo     ^<WakeToRun^>false^</WakeToRun^>
echo     ^<ExecutionTimeLimit^>PT0S^</ExecutionTimeLimit^>
echo     ^<Priority^>4^</Priority^>
echo     ^<RestartOnFailure^>
echo       ^<Interval^>PT1M^</Interval^>
echo       ^<Count^>999^</Count^>
echo     ^</RestartOnFailure^>
echo   ^</Settings^>
echo   ^<Actions Context="Author"^>
echo     ^<Exec^>
echo       ^<Command^>%PYTHON_PATH%^</Command^>
echo       ^<Arguments^>"%CCTV_PATH%"^</Arguments^>
echo       ^<WorkingDirectory^>%~dp0^</WorkingDirectory^>
echo     ^</Exec^>
echo   ^</Actions^>
echo ^</Task^>
) > "%XML_PATH%"

schtasks /Create /TN "%TASK_NAME%" /XML "%XML_PATH%" /F
if %errorLevel% neq 0 (
    echo.
    echo ❌ 작업 등록 실패. 위 오류 메시지를 확인하세요.
    pause
    exit /b 1
)

del "%XML_PATH%" >nul 2>&1

echo.
echo ✅ 작업 스케줄러 등록 완료!
echo.
echo 지금 바로 시작합니다...
schtasks /Run /TN "%TASK_NAME%"
echo.

REM Windows Defender 방화벽 5555 포트 허용
echo Windows 방화벽 5555 포트 허용 중...
netsh advfirewall firewall delete rule name="Jamsa CCTV Server" >nul 2>&1
netsh advfirewall firewall add rule name="Jamsa CCTV Server" dir=in action=allow protocol=TCP localport=5555 >nul 2>&1
echo ✓ 방화벽 규칙 추가됨
echo.

echo ════════════════════════════════════════════════
echo ✅ 설치 완료!
echo ════════════════════════════════════════════════
echo.
echo 📋 동작 방식:
echo   • PC 부팅 시 자동 시작 (사용자 로그인 불필요)
echo   • 서버가 죽으면 1분 후 자동 재시작 (최대 999회)
echo   • 방화벽 5555 포트 허용 (LAN 내 다른 기기 접근 가능)
echo.
echo 🔧 관리 명령:
echo   상태 확인: schtasks /Query /TN "JamsaCCTVServer"
echo   수동 중지: schtasks /End /TN "JamsaCCTVServer"
echo   수동 시작: schtasks /Run /TN "JamsaCCTVServer"
echo   완전 제거: schtasks /Delete /TN "JamsaCCTVServer" /F
echo.
echo 🌐 패널 새로고침: 잠사 패널에서 Ctrl+Shift+R
echo    CCTV 영상이 자동으로 표시됩니다.
echo.
pause
