"""Qwen3-TTS-12Hz-0.6B-CustomVoice - minimal OpenAI-compatible HTTP server.

本文件已纳入「众安」项目：权重位于 models/tts/qwen3-tts-0.6b，
可用项目自带启动脚本 scripts/start-qwen-tts.cmd 一键启动（端口 7861）。

Endpoints:
  GET  /v1/models                       -> engine info
  POST /v1/audio/speech                 -> wav bytes (OpenAI TTS shape)

Speech request JSON:
  text        (str, required)
  voice       (str, optional) one of the 9 official speakers, default Vivian
  instruct    (str, optional) natural-language style, e.g. "用愤怒的语气说"
  language    (str, optional) default "Chinese"
  speed       (float, optional) reserved for future use

The model loads lazily on the first request, so startup is instant and the
idle VRAM cost is zero - same discipline as IndexTTS2 on the shared 8G card.
"""
import argparse
import io
import os
import sys
import threading

MODEL_DIR = os.environ.get("QWEN_TTS_MODEL") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "models", "tts", "qwen3-tts-0.6b")

SPEAKERS = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric",
            "Ryan", "Aiden", "Ono_Anna", "Sohee"]

_app = None
_lock = threading.Lock()
_state = {"model": None}


def get_app():
    global _app
    if _app is not None:
        return _app
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import Response
    from pydantic import BaseModel

    app = FastAPI(title="Qwen3-TTS-0.6B")

    class SpeechIn(BaseModel):
        text: str
        voice: str = "Vivian"
        instruct: str = ""
        language: str = "Chinese"
        speed: float = 1.0

    def load_model():
        with _lock:
            if _state["model"] is None:
                if not os.path.isdir(MODEL_DIR):
                    raise HTTPException(500, f"model dir missing: {MODEL_DIR}")
                import torch
                from qwen_tts import Qwen3TTSModel
                print(f"loading model from {MODEL_DIR} ...", flush=True)
                _state["model"] = Qwen3TTSModel.from_pretrained(
                    MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
                print("model ready", flush=True)
            return _state["model"]

    @app.get("/v1/models")
    def models():
        return {"object": "list", "engine": "Qwen3-TTS-12Hz-0.6B-CustomVoice",
                "voices": SPEAKERS, "local_model_dir": MODEL_DIR}

    @app.post("/v1/audio/speech")
    def speech(body: SpeechIn):
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "text is empty")
        if len(text) > 2000:
            raise HTTPException(400, "text too long (max 2000 chars); split it")
        if body.voice not in SPEAKERS:
            raise HTTPException(400, f"unknown voice {body.voice!r}; one of {SPEAKERS}")
        model = load_model()
        kwargs = dict(text=text, language=body.language, speaker=body.voice)
        if body.instruct.strip():
            kwargs["instruct"] = body.instruct.strip()
        try:
            wavs, sr = model.generate_custom_voice(**kwargs)
        except Exception as exc:
            raise HTTPException(500, f"synthesis failed: {exc}")
        import soundfile as sf
        buf = io.BytesIO()
        sf.write(buf, wavs[0], sr, format="WAV")
        return Response(content=buf.getvalue(), media_type="audio/wav")

    _app = app
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7861)
    args = ap.parse_args()
    import uvicorn
    uvicorn.run(get_app(), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
