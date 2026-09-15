@echo off
setlocal
cd /d "%~dp0"

set "PORT=4173"
set "MEME_WAR_PORT=%PORT%"
node scripts\launch.mjs
if errorlevel 1 pause
exit /b 0
