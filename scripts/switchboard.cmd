@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "VENV_PYTHON=%REPO_ROOT%\.venv\Scripts\python.exe"
if defined PYTHONPATH (
    set "PYTHONPATH=%REPO_ROOT%;%PYTHONPATH%"
) else (
    set "PYTHONPATH=%REPO_ROOT%"
)

if exist "%VENV_PYTHON%" (
    "%VENV_PYTHON%" -m switchboard_core %*
    exit /b %ERRORLEVEL%
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    py -3 -m switchboard_core %*
    exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    python -m switchboard_core %*
    exit /b %ERRORLEVEL%
)

echo No Python interpreter found. Install Python or create the repo virtual environment at .venv. 1>&2
exit /b 1
