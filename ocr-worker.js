import {
  VisionEncoderDecoderModel,
  PreTrainedTokenizer,
  Tensor,
  cat,
  env,
  pipeline,
  RawImage,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = true;
  env.backends.onnx.wasm.numThreads = Math.max(
    1,
    Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency || 4) / 2)),
  );
}

const FAST_MODEL_ID = 'alephpi/FormulaNet';
const ACCURATE_MODEL_ID = 'Xenova/texify2';
const HAS_WEBGPU = !!globalThis.navigator?.gpu;

let fastModel = null;
let fastTokenizer = null;
let fastLoadingPromise = null;
let accuratePipe = null;
let accurateLoadingPromise = null;
let accurateBackend = HAS_WEBGPU ? 'WebGPU' : 'WASM';

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function sendError(error, engine = '') {
  post('error', { engine, message: error?.message || String(error) });
}

function progressHandler(engine) {
  return (p) => {
    post('progress', {
      engine,
      status: p?.status || '',
      file: p?.file || p?.name || '',
      progress: Number.isFinite(p?.progress) ? p.progress : undefined,
      loaded: p?.loaded,
      total: p?.total,
    });
  };
}

async function initFast() {
  if (fastModel && fastTokenizer) {
    post('ready', { engine: 'fast', backend: 'WASM' });
    return;
  }
  if (fastLoadingPromise) return fastLoadingPromise;

  fastLoadingPromise = (async () => {
    try {
      post('phase', { engine: 'fast', phase: 'loading' });
      fastModel = await VisionEncoderDecoderModel.from_pretrained(FAST_MODEL_ID, {
        dtype: 'fp32',
        progress_callback: progressHandler('fast'),
      });
      fastTokenizer = await PreTrainedTokenizer.from_pretrained(FAST_MODEL_ID, {
        progress_callback: progressHandler('fast'),
      });
      post('ready', { engine: 'fast', backend: 'WASM' });
    } catch (err) {
      fastModel = null;
      fastTokenizer = null;
      fastLoadingPromise = null;
      sendError(err, 'fast');
      throw err;
    }
  })();
  return fastLoadingPromise;
}

async function loadAccurate(device) {
  // q4f16 is substantially smaller for Texify2 on WebGPU than q4,
  // while WASM falls back to the most compatible q4 variant.
  const dtype = device === 'webgpu' ? 'q4f16' : 'q4';
  return await pipeline('image-to-text', ACCURATE_MODEL_ID, {
    device,
    dtype,
    progress_callback: progressHandler('accurate'),
  });
}

async function initAccurate() {
  if (accuratePipe) {
    post('ready', { engine: 'accurate', backend: accurateBackend });
    return;
  }
  if (accurateLoadingPromise) return accurateLoadingPromise;

  accurateLoadingPromise = (async () => {
    try {
      post('phase', { engine: 'accurate', phase: 'loading' });
      if (HAS_WEBGPU) {
        try {
          accuratePipe = await loadAccurate('webgpu');
          accurateBackend = 'WebGPU';
        } catch (gpuErr) {
          post('backend-fallback', {
            engine: 'accurate',
            message: 'WebGPU 初始化失败，已自动切换 CPU/WASM。',
          });
          accuratePipe = await loadAccurate('wasm');
          accurateBackend = 'WASM';
        }
      } else {
        accuratePipe = await loadAccurate('wasm');
        accurateBackend = 'WASM';
      }
      post('ready', { engine: 'accurate', backend: accurateBackend });
    } catch (err) {
      accuratePipe = null;
      accurateLoadingPromise = null;
      sendError(err, 'accurate');
      throw err;
    }
  })();
  return accurateLoadingPromise;
}

async function predictFast(buffer) {
  await initFast();
  post('phase', { engine: 'fast', phase: 'infer', backend: 'WASM' });
  const started = performance.now();
  const array = new Float32Array(buffer);
  if (array.length !== 384 * 384) throw new Error('预处理后的图像尺寸无效。');

  const one = new Tensor('float32', array, [1, 1, 384, 384]);
  const pixelValues = cat([one, one, one], 1);
  const outputs = await fastModel.generate({
    inputs: pixelValues,
    max_new_tokens: 320,
    do_sample: false,
  });
  const text = fastTokenizer.batch_decode(outputs, { skip_special_tokens: true })[0] || '';
  post('result', {
    engine: 'fast',
    backend: 'WASM',
    elapsed_ms: performance.now() - started,
    text,
  });
}

async function predictAccurate(blob) {
  await initAccurate();
  post('phase', { engine: 'accurate', phase: 'infer', backend: accurateBackend });
  const started = performance.now();
  const image = await RawImage.fromBlob(blob);
  const output = await accuratePipe(image, {
    max_new_tokens: 384,
    num_beams: 1,
    do_sample: false,
  });

  let text = '';
  if (Array.isArray(output)) {
    text = output[0]?.generated_text ?? output[0]?.text ?? '';
  } else {
    text = output?.generated_text ?? output?.text ?? '';
  }

  post('result', {
    engine: 'accurate',
    backend: accurateBackend,
    elapsed_ms: performance.now() - started,
    text: String(text || ''),
  });
}

self.addEventListener('message', async (event) => {
  const data = event.data || {};
  try {
    if (data.type === 'predict-fast') await predictFast(data.pixels);
    else if (data.type === 'predict-accurate') await predictAccurate(data.image);
    else if (data.type === 'init-fast') await initFast();
    else if (data.type === 'init-accurate') await initAccurate();
  } catch (err) {
    if (!['init-fast', 'init-accurate'].includes(data.type)) {
      sendError(err, data.type?.includes('accurate') ? 'accurate' : 'fast');
    }
  }
});
