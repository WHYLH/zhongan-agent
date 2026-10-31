# -*- coding: utf-8 -*-
"""CosyVoice2-0.5B 常驻语音子进程。
stdin 每行一条 JSON: {"id": "...", "text": "..."}
stdout 每行回 JSON: {"id": "...", "wav": "路径"} 或 {"id": "...", "error": "..."}
启动参数: python cosyvoice-worker.py <model_dir> <cosyvoice_repo_dir>
"""
import json
import os
import sys
import tempfile

MODEL_DIR = sys.argv[1] if len(sys.argv) > 1 else ''
REPO_DIR = sys.argv[2] if len(sys.argv) > 2 else ''
if REPO_DIR:
    sys.path.insert(0, REPO_DIR)


def log(msg):
    sys.stderr.write('[cosyvoice-worker] ' + msg + '\n')
    sys.stderr.flush()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    import torch  # noqa: F401
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice2

    log('loading CosyVoice2 (first load may take minutes)...')
    model = CosyVoice2(MODEL_DIR)
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
            out_path = os.path.join(tempfile.gettempdir(), 'cosyvoice-%s.wav' % req_id)
            chunks = [item['tts_speech'] for item in model.inference_sft(text, '中文女', stream=False)]
            audio = chunks[0]
            for extra in chunks[1:]:
                audio = torch.cat([audio, extra], dim=-1)
            torchaudio.save(out_path, audio, 24000)
            emit({'id': req_id, 'wav': out_path})
        except Exception as err:  # noqa: BLE001
            emit({'id': req_id, 'error': str(err)})


if __name__ == '__main__':
    main()
