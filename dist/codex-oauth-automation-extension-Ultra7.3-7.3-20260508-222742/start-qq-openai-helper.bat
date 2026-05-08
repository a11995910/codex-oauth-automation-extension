@echo off
cd /d "%~dp0"

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 scripts\qq_openai_code_helper.py --open
  exit /b %ERRORLEVEL%
)

python scripts\qq_openai_code_helper.py --open
