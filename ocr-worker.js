import {
  VisionEncoderDecoderModel,
  PreTrainedTokenizer,
  Tensor,
  cat,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.proxy = true;

const MODEL_ID = 'alephpi/FormulaNet';
let model = null;
let tokenizer = null;
let loadingPromise = null;

function sendError(error) {
  self.postMessage({ type: 'error', message: error?.message || String(error) });
}

async function init() {
  if (model && tokenizer) {
    self.postMessage({ type: 'ready' });
    return;
  }
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      env.remoteHost = 'https://huggingface.co/';
      env.remotePathTemplate = '{model}/resolve/{revision}';

      model = await VisionEncoderDecoderModel.from_pretrained(MODEL_ID, {
        dtype: 'fp32',
        progress_callback: (p) => {
          self.postMessage({
            type: 'progress',
            status: p?.status,
            file: p?.file || p?.name || '',
            progress: Number.isFinite(p?.progress) ? p.progress : undefined,
          });
        },
      });
      tokenizer = await PreTrainedTokenizer.from_pretrained(MODEL_ID, {
        progress_callback: (p) => {
          self.postMessage({
            type: 'progress',
            status: p?.status,
            file: p?.file || p?.name || '',
            progress: Number.isFinite(p?.progress) ? p.progress : undefined,
          });
        },
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      model = null;
      tokenizer = null;
      loadingPromise = null;
      sendError(err);
      throw err;
    }
  })();
  return loadingPromise;
}

async function predict(buffer) {
  await init();
  const array = new Float32Array(buffer);
  if (array.length !== 384 * 384) throw new Error('预处理后的图像尺寸无效。');

  const one = new Tensor('float32', array, [1, 1, 384, 384]);
  const pixelValues = cat([one, one, one], 1);
  const outputs = await model.generate({ inputs: pixelValues });
  const text = tokenizer.batch_decode(outputs, { skip_special_tokens: true })[0] || '';
  self.postMessage({ type: 'result', text });
}

self.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data.type === 'init') {
    try { await init(); } catch (_) { /* error already posted */ }
  } else if (data.type === 'predict') {
    try { await predict(data.pixels); }
    catch (err) { sendError(err); }
  }
});
