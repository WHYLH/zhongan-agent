@echo off
rem Keep this file ASCII-only: cmd.exe parses batch files in the OEM codepage,
rem and UTF-8 Chinese can be split into stray operators (&, |, <, >).
setlocal
cd /d "%~dp0.."

echo ============================================================
echo   Zhongan - Qwen3-TTS local speech engine
echo   Weights: models\tts\qwen3-tts-0.6b (2.4GB, CustomVoice, 9 voices)
echo   API    : http://127.0.0.1:7861 (OpenAI TTS compatible)
echo ============================================================
echo.

rem Prefer the ready ComfyUI-H3 venv (torch/qwen_tts/fastapi);
rem set QWEN_TTS_VENV to any venv that has the dependencies.
set "VENV=%QWEN_TTS_VENV%"
if "%VENV%"=="" set "VENV=C:\Users\whylh\Saved Games\ComfyUI-H3\TTS\qwen"

if not exist "%VENV%\Scripts\python.exe" (
  echo [ERROR] python venv not found: %VENV%
  echo Install torch + qwen_tts + fastapi + uvicorn + soundfile,
  echo or set QWEN_TTS_VENV to a venv directory.
  pause
  exit /b 1
)

set "PYTORCH_ALLOC_CONF=backend:cudaMallocAsync"
set "HF_ENDPOINT=https://hf-mirror.com"
set "QWEN_TTS_MODEL=%~dp0..\models\tts\qwen3-tts-0.6b"

echo [Qwen3-TTS] serving on port 7861, lazy load (first synthesis ~6s)...
"%VENV%\Scripts\python.exe" "%~dp0qwen-tts-server.py" --host 127.0.0.1 --port 7861
echo.
echo Qwen TTS API exited.
pause