@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Tailscale Serve(HTTPS)를 쓰는 구성: 이 PC 안에서만 열고, 쿠키는 보안 모드로 동작
set HOST=127.0.0.1
set PORT=3000
set SECURE_COOKIE=1
:loop
node server.js
echo 서버가 종료되었습니다. 5초 후 다시 시작합니다. (끄려면 이 창을 닫으세요)
timeout /t 5 >nul
goto loop
