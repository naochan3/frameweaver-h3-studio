@echo off
REM ============================================================
REM FrameWeaver H3 Studio 起動スクリプト
REM  1) Ollama (プロンプト強化用LLM, 127.0.0.1:11434)
REM  2) ComfyUI バックエンド (127.0.0.1:8189)
REM  3) WebUI (http://localhost:5180)
REM  4) ブラウザを開く
REM ComfyUI/Ollamaはlocalhost限定。WebUIはLAN内端末向けに0.0.0.0で待受。
REM ============================================================

REM --- Ollama (未起動なら起動。プロンプト自動強化に使用) ---
powershell -NoProfile -Command "$up=$false; try { $up=((Invoke-WebRequest 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) } catch {}; if (-not $up) { Start-Process '%LOCALAPPDATA%\Programs\Ollama\ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden }"

REM --- ComfyUI バックエンド ---
start "ComfyUI_H3 (port 8189)" powershell -ExecutionPolicy Bypass -File "C:\AI\ComfyUI_H3\start.ps1"

REM --- WebUI ---
cd /d "%~dp0"
start "FrameWeaver WebUI (port 5180)" cmd /c "npm run dev"

REM --- 起動を待ってブラウザを開く ---
timeout /t 10 /nobreak >nul
start http://localhost:5180

echo.
echo FrameWeaver H3 Studio を起動しました。
echo   WebUI:   http://localhost:5180
echo   ComfyUI: http://127.0.0.1:8189
echo このウィンドウは閉じてかまいません(各サーバーは別ウィンドウで動作)。
timeout /t 15 >nul
