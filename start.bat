@echo off
title PhoneDesk
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo First run: installing...
  call npm install --omit=dev --no-audit --no-fund || (pause & exit /b 1)
)
set OPEN=--open
:loop
node server\index.js %OPEN%
if %errorlevel%==2 (pause & exit /b 2)
if %errorlevel%==0 exit /b 0
set OPEN=
echo PhoneDesk stopped unexpectedly. Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto loop
