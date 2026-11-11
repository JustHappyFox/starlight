@echo off
rem wm_watchdog launcher for Windows: restarts the watchdog if it ever stops.
rem Autostart: Win+R -> shell:startup -> put a shortcut to this file there.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
:loop
python wm_watchdog.py run
echo wm_watchdog stopped, restarting in 15 seconds... (Ctrl+C to quit)
timeout /t 15 >nul
goto loop
