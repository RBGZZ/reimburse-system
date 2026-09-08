@echo off
chcp 65001 >nul
title 报销云 · 启动器
setlocal
pushd "%~dp0" >nul

echo ==================================================
echo    报销云 · 财务报销管理系统  一键启动
echo ==================================================
echo.

REM ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。请先安装 Node.js v22.5 或更高版本：
  echo        https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%a in ('node --version') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%
echo [OK] 已检测到 Node.js（主版本 %NODE_MAJOR%）
if %NODE_MAJOR% LSS 22 (
  echo [警告] Node 版本可能过低，需 ^>= 22.5（内置 node:sqlite），否则无法启动。
  echo.
  pause
  exit /b 1
)

REM ---- 2. 确保 config.json 存在 ----
if not exist "config.json" (
  echo [提示] 未找到 config.json，已从 config.example.json 生成。
  echo         （如需智能问答，请编辑 config.json 填入 DeepSeek API Key 后重启）
  copy /y "config.example.json" "config.json" >nul
)
if not exist "server.js" (
  echo [错误] 未找到 server.js，请在项目目录运行本脚本。
  echo.
  pause
  exit /b 1
)

REM ---- 3. 启动服务（独立窗口）----
echo.
echo 正在启动服务： http://127.0.0.1:3300
echo 服务窗口名为“报销云服务”，按 Ctrl+C 或关闭该窗口即停止。
echo.
start "报销云服务" cmd /k "chcp 65001 >nul & node server.js"

REM ---- 4. 稍候打开浏览器 ----
timeout /t 3 >nul
start "" "http://127.0.0.1:3300"

echo 已在浏览器打开。测试账号（密码均为 123456）：
echo   zhangwei   lina   finance   cashier   admin
echo.
echo 本启动窗口可关闭；服务在“报销云服务”窗口运行。
echo 若提示端口被占用，可在 config.json/README 看“换端口”说明。
pause
