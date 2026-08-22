@echo off
REM ============================================================
REM FrameWeaver H3 Studio 起動スクリプト
REM  1) ComfyUI バックエンド (127.0.0.1:8188)
REM  2) WebUI (http://localhost:5180)
REM  3) ブラウザを開く
REM すべて localhost バインドなのでファイアウォール許可は不要。
REM ============================================================

REM --- ComfyUI バックエンド ---
start "ComfyUI (port 8188)" powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ogosh\work\shirokuma-openclaw-ops\scripts\Start-ShirokumaComfyUI.ps1"

REM --- WebUI ---
cd /d "%~dp0"
start "FrameWeaver WebUI (port 5180)" cmd /c "npm run dev"

REM --- 起動を待ってブラウザを開く ---
timeout /t 10 /nobreak >nul
start http://localhost:5180

echo.
echo FrameWeaver H3 Studio を起動しました。
echo   WebUI:   http://localhost:5180
echo   ComfyUI: http://127.0.0.1:8188
echo このウィンドウは閉じてかまいません(各サーバーは別ウィンドウで動作)。
timeout /t 15 >nul
