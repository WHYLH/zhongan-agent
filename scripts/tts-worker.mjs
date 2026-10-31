/* TTS worker：kokoro 引擎常驻子线程，生成不阻塞主线程事件循环 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';

const D = workerData.dir;
const SUFFIX_RE = /[～~]/g;

const sherpa = await import('sherpa-onnx-node');
const OfflineTts = sherpa.OfflineTts || (sherpa.default && sherpa.default.OfflineTts);

let engine = null;
function ensure() {
  if (engine) return engine;
  engine = new OfflineTts({
    model: {
      kokoro: {
        model: path.join(D, 'model.int8.onnx'),
        voices: path.join(D, 'voices.bin'),
        tokens: path.join(D, 'tokens.txt'),
        lexicon: path.join(D, 'lexicon-zh.txt'),
        dataDir: path.join(D, 'espeak-ng-data'),
        dictDir: path.join(D, 'dict'),
      },
    },
    numThreads: Number(process.env.TTS_THREADS || 2),
    debug: 0,
    provider: 'cpu',
  });
  return engine;
}

function wavFromSamples(samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

parentPort.on('message', ({ id, text, sid, speed }) => {
  try {
    const tts = ensure();
    const audio = tts.generate({ text: String(text).replace(SUFFIX_RE, '，'), sid: sid, speed: speed });
    const wav = wavFromSamples(audio.samples, audio.sampleRate);
    parentPort.postMessage({ id, wav, transfer: undefined });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});

ensure();
parentPort.postMessage({ ready: true, sampleRate: engine.sampleRate });
