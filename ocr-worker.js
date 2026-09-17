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
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.proxy = true;

const FAST_MODEL_ID = 'alephpi/FormulaNet';
const ACCURATE_MODEL_ID = 'Xenova/texify2';

let fastModel = null;
let fastTokenizer = null;
let fastLoadingPromise = null;
let accuratePipe = null;
let accurateLoadingPromise = null;

function post(type, payload = {}) { self.postMessage({ type, ...payload }); }
function sendError(error, engine = '') { post('error', { engine, message: error?.message || String(error) }); }
function progressHandler(engine) {
  return (p) => post('progress', {
    engine,
    status: p?.status,
    file: p?.file || p?.name || '',
    progress: Number.isFinite(p?.progress) ? p.progress : undefined,
  });
}

async function initFast() {
  if (fastModel && fastTokenizer) { post('ready', { engine: 'fast' }); return; }
  if (fastLoadingPromise) return fastLoadingPromise;
  fastLoadingPromise = (async () => {
    try {
      env.remoteHost = 'https://huggingface.co/';
      env.remotePathTemplate = '{model}/resolve/{revision}';
      fastModel = await VisionEncoderDecoderModel.from_pretrained(FAST_MODEL_ID, {
        dtype: 'fp32', progress_callback: progressHandler('fast'),
      });
      fastTokenizer = await PreTrainedTokenizer.from_pretrained(FAST_MODEL_ID, {
        progress_callback: progressHandler('fast'),
      });
      post('ready', { engine: 'fast' });
    } catch (err) {
      fastModel = null; fastTokenizer = null; fastLoadingPromise = null;
      sendError(err, 'fast'); throw err;
    }
  })();
  return fastLoadingPromise;
}

async function initAccurate() {
  if (accuratePipe) { post('ready', { engine: 'accurate' }); return; }
  if (accurateLoadingPromise) return accurateLoadingPromise;
  accurateLoadingPromise = (async () => {
    try {
      accuratePipe = await pipeline('image-to-text', ACCURATE_MODEL_ID, {
        dtype: 'q4',
        progress_callback: progressHandler('accurate'),
      });
      post('ready', { engine: 'accurate' });
    } catch (err) {
      accuratePipe = null; accurateLoadingPromise = null;
      sendError(err, 'accurate'); throw err;
    }
  })();
  return accurateLoadingPromise;
}

async function predictFast(buffer) {
  await initFast();
  const array = new Float32Array(buffer);
  if (array.length !== 384 * 384) throw new Error('预处理后的图像尺寸无效。');
  const one = new Tensor('float32', array, [1, 1, 384, 384]);
  const pixelValues = cat([one, one, one], 1);
  const outputs = await fastModel.generate({ inputs: pixelValues, max_new_tokens: 512 });
  const text = fastTokenizer.batch_decode(outputs, { skip_special_tokens: true })[0] || '';
  post('result', { engine: 'fast', text });
}

async function predictAccurate(blob) {
  await initAccurate();
  const image = await RawImage.fromBlob(blob);
  const output = await accuratePipe(image, {
    max_new_tokens: 1024,
    num_beams: 1,
  });
  let text = '';
  if (Array.isArray(output)) text = output[0]?.generated_text ?? output[0]?.text ?? '';
  else text = output?.generated_text ?? output?.text ?? '';
  post('result', { engine: 'accurate', text: String(text || '') });
}

self.addEventListener('message', async (event) => {
  const data = event.data || {};
  try {
    if (data.type === 'init-fast') await initFast();
    else if (data.type === 'init-accurate') await initAccurate();
    else if (data.type === 'predict-fast') await predictFast(data.pixels);
    else if (data.type === 'predict-accurate') await predictAccurate(data.image);
  } catch (err) {
    if (!['init-fast','init-accurate'].includes(data.type)) {
      sendError(err, data.type?.includes('accurate') ? 'accurate' : 'fast');
    }
  }
});
