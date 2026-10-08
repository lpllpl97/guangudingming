@echo off
chcp 65001 >nul
rem 一键启动取名服务（默认端口 6700）。双击即可，或在本目录命令行执行。
rem 停止服务：关掉这个窗口，或按 Ctrl+C。
rem 注意：本文件必须用 CRLF 换行保存。cmd.exe 读不了只有 LF 的批处理，
rem       会把每行开头的字符吃掉（表现为 "'IOENCODING' 不是内部或外部命令"）。
rem       改完请跑：python tools\fix_script_newlines.py
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
set "PORT=6700"

echo ============================================
echo   观古定名服务
echo   打开网址： http://127.0.0.1:%PORT%/
echo   停止服务：按 Ctrl+C 或直接关掉本窗口
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 python 命令。
  echo        请先安装 Python 3.8 或更高版本，安装时勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

rem 端口若已在监听，多半是本服务已经在跑，不必重复启动
netstat -ano | findstr /c:"LISTENING" | findstr /c:":%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 %PORT% 已在监听，服务可能已经在运行。
  echo        请先打开 http://127.0.0.1:%PORT%/ 试试；
  echo        若打不开，先关掉旧的命令行窗口，再重新双击本文件。
  echo.
  pause
  exit /b 0
)

python mobile\server.py %PORT%
echo.
echo [服务已退出] 若上面有报错信息，请把它发给开发者。
pause
