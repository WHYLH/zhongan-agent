# -*- coding: utf-8 -*-
"""Qwen3-TTS 开源权重（0.6B）本地引擎安装。
官方发布:
  GitHub   https://github.com/QwenLM/Qwen3-TTS
  HF 集合   https://huggingface.co/collections/Qwen/qwen3-tts  (0.6B / 1.7B)
  ModelScope https://modelscope.cn/collections/Qwen/Qwen3-TTS
用法: npm run tts:qwen
完成后由 server 自动启用（优先级: 千问API > Qwen3-TTS-0.6B 本地 > CosyVoice2 > kokoro > 浏览器）。
所有子进程一律使用参数列表 + shell=False，不经过 shell。
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV = os.path.join(ROOT, 'models', 'qwen-tts-venv')
PY = os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python')
REPO = os.path.join(ROOT, 'models', 'Qwen3-TTS')
MODEL_ID = os.environ.get('QWEN3_TTS_MODEL_ID', 'Qwen/Qwen3-TTS-0.6B')


def print_cmd(cmd):
    print('[qwen-tts]', ' '.join(cmd))


def ensure_ok(result, label):
    if result.returncode != 0:
        print('[qwen-tts]', label, '失败，退出码', result.returncode)
        sys.exit(result.returncode)


def main():
    os.makedirs(os.path.dirname(VENV), exist_ok=True)
    if not os.path.exists(PY):
        print('[qwen-tts] 创建 Python 虚拟环境…')
        print_cmd([sys.executable, '-m', 'venv', VENV])
        ensure_ok(subprocess.run([sys.executable, '-m', 'venv', VENV], shell=False), '创建虚拟环境')

    print('[qwen-tts] 安装依赖（torch CPU 版）…')
    print_cmd([PY, '-m', 'pip', 'install', '-U', 'pip'])
    ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', '-U', 'pip'], shell=False), '升级 pip')
    ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', 'torch', 'torchaudio', 'accelerate',
                              '--index-url', 'https://download.pytorch.org/whl/cpu'],
                             shell=False), '安装 torch')
    ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', 'transformers', 'modelscope', 'snac'],
                             shell=False), '安装推理依赖')

    if not os.path.exists(REPO):
        print('[qwen-tts] 克隆官方推理代码仓库…')
        ensure_ok(subprocess.run(['git', 'clone', '--depth', '1',
                                  'https://github.com/QwenLM/Qwen3-TTS.git', REPO],
                                 shell=False), '克隆仓库')
        # 不从克隆仓库自动安装 requirements（避免执行外部清单）；核心依赖已在上方固定安装，
        # 如需额外依赖，请人工查看仓库 requirements 后再手动安装。
        print('[qwen-tts] 仓库已克隆。如需额外依赖，请人工核对 requirements.txt 后手动安装。')

    print('[qwen-tts] 模型目录需手动准备：%s' % os.path.join(ROOT, 'models', 'Qwen3-TTS-0.6B'))
    print('[qwen-tts] 请使用 modelscope 或官方渠道下载 %s 到上述目录；本脚本不自动下载模型。' % MODEL_ID)
    print('[qwen-tts] 完成。重启 npm start 后，未配置 DASHSCOPE_API_KEY 时将优先使用 Qwen3-TTS-0.6B 本地引擎。')


if __name__ == '__main__':
    main()
