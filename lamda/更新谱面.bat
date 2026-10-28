@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 goto :trypy
python tools\midi2chart.py --reindex
goto :done
:trypy
where py >nul 2>nul
if errorlevel 1 goto :nopython
py tools\midi2chart.py --reindex
goto :done
:nopython
echo.
echo   Python not found. Install Python 3 to rebuild the chart list.
echo.
:done
echo.
pause
