@echo off
cd /d "%~dp0"
node_modules\electron\dist\electron.exe .
if %errorlevel% neq 0 pause
