# -*- coding: utf-8 -*-
"""CosyVoice2-0.5B 本地引擎安装（阿里通义开源，ModelScope 下载）。
用法: npm run tts:cosyvoice
完成后由 server 自动启用（优先级: 千问API > CosyVoice2 > kokoro > 浏览器）。
所有子进程一律使用参数列表 + shell=False，不经过 shell。
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV = os.path.join(ROOT, 'models', 'cosyvoice-venv')
PY = os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python')


def print_cmd(cmd):
    print('[cosyvoice]', ' '.join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd)))


def ensure_ok(result, label):
    if result.returncode != 0:
        print('[cosyvoice]', label, '失败，退出码', result.returncode)
        sys.exit(result.returncode)


def child_env(**updates):
    e = dict(os.environ)
    e.update(updates)
    return e


def main():
    os.makedirs(os.path.dirname(VENV), exist_ok=True)
    if not os.path.exists(PY):
        print('[cosyvoice] 创建 Python 虚拟环境…')
        print_cmd([sys.executable, '-m', 'venv', VENV])
        ensure_ok(subprocess.run([sys.executable, '-m', 'venv', VENV], shell=False), '创建虚拟环境')

    print('[cosyvoice] 安装依赖（torch 从 CPU 源，首次约 200MB）…')
    print_cmd([PY, '-m', 'pip', 'install', '-U', 'pip'])
    ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', '-U', 'pip'],
                             env=child_env(PIP_DEFAULT_TIMEOUT='120'), shell=False), '升级 pip')
    ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', 'torch', 'torchaudio',
                              '--index-url', 'https://download.pytorch.org/whl/cpu'],
                             shell=False), '安装 torch')
    ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', 'modelscope'], shell=False), '安装 modelscope')

    repo = os.path.join(ROOT, 'models', 'CosyVoice')
    if not os.path.exists(os.path.join(repo, 'cosyvoice', 'cli', 'cosyvoice.py')):
        print('[cosyvoice] 克隆 CosyVoice 仓库（引擎源码）…')
        ensure_ok(subprocess.run(['git', 'clone', '--depth', '1',
                                  'https://github.com/FunAudioLLM/CosyVoice.git', repo],
                                 shell=False), '克隆仓库')
        print('[cosyvoice] 安装引擎依赖（requirements.txt，较慢）…')
        ensure_ok(subprocess.run([PY, '-m', 'pip', 'install', '-r', os.path.join(repo, 'requirements.txt'),
                                  '--extra-index-url', 'https://mirrors.aliyun.com/pypi/simple/'],
                                 shell=False), '安装引擎依赖')

    print('[cosyvoice] 下载模型 iic/CosyVoice2-0.5B（约 5GB，国内直连较快）…')
    ensure_ok(subprocess.run([PY, '-c',
                              "from modelscope import snapshot_download;"
                              " p = snapshot_download('iic/CosyVoice2-0.5B'); print('模型目录:', p)"],
                             shell=False), '下载模型')
    print('[cosyvoice] 完成。重启 npm start 后，未配置 DASHSCOPE_API_KEY 时将使用 CosyVoice2 引擎。')


if __name__ == '__main__':
    main()
