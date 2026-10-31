# -*- coding: utf-8 -*-
"""Qwen3-TTS-0.6B 常驻语音子进程（官方开源权重）。
stdin 每行 JSON: {"id","text"} → stdout 每行 JSON: {"id","wav"} / {"id","error"}。
启动: python qwen-tts-worker.py <model_dir> <repo_dir>
说明: 推理调用以官方仓库 README 为准；当前按 Qwen 系模型通用 transformers 用法实现，
     若官方提供专用推理脚本，setup 完成后按其示例替换 run() 内三行即可。
"""
import json
import os
import sys
import tempfile

MODEL_DIR = sys.argv[1] if len(sys.argv) > 1 else ''
REPO_DIR = sys.argv[2] if len(sys.argv) > 2 else ''
if REPO_DIR and os.path.exists(REPO_DIR):
    sys.path.insert(0, REPO_DIR)


def log(msg):
    sys.stderr.write('[qwen-tts-worker] ' + msg + '\n')
    sys.stderr.flush()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def run():
    import torch
    import torchaudio
    from transformers import AutoModel, AutoTokenizer

    log('loading Qwen3-TTS-0.6B (first load may take minutes)...')
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    model = AutoModel.from_pretrained(MODEL_DIR, trust_remote_code=True, torch_dtype=torch.float32)
    model.eval()
    log('model ready')
    emit({'ready': True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = 'unknown'
        try:
            req = json.loads(line)
            req_id = str(req.get('id', 'unknown'))
            text = str(req.get('text', '')).strip()
            if not text:
                emit({'id': req_id, 'error': 'empty text'})
                continue
            out_path = os.path.join(tempfile.gettempdir(), 'qwen-tts-%s.wav' % req_id)
            with torch.no_grad():
                output = model.generate(
                    **tokenizer(text, return_tensors='pt'),
                    speaker=os.environ.get('QWEN_TTS_SPEAKER', 'Cherry'),
                    output_audio=True
                )
            audio = output.audio if hasattr(output, 'audio') else output[0]
            torchaudio.save(out_path, audio.float().unsqueeze(0), 24000)
            emit({'id': req_id, 'wav': out_path})
        except Exception as err:  # noqa: BLE001
            emit({'id': req_id, 'error': str(err)})


if __name__ == '__main__':
    main()
