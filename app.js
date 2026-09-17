const MODEL_SIZE_HINT = '首次约需下载 80 MB，后续通常直接读取浏览器缓存。';
const $ = (id) => document.getElementById(id);
const drop = $('drop');
const fileInput = $('fileInput');
const dropEmpty = $('dropEmpty');
const previewImg = $('previewImg');
const recognizeBtn = $('recognizeBtn');
const clearBtn = $('clearBtn');
const statusEl = $('status');
const bar = $('bar');
const latexEl = $('latex');
const formulaPreview = $('formulaPreview');
const copyWordBtn = $('copyWordBtn');
const copyLatexBtn = $('copyLatexBtn');
const copyMathmlBtn = $('copyMathmlBtn');
const charCount = $('charCount');
const toast = $('toast');

let currentFile = null;
let currentUrl = null;
let modelReady = false;
let modelFailed = false;
let recognizing = false;
let pendingAutoRecognize = false;
let renderTimer = null;

const worker = new Worker('./ocr-worker.js', { type: 'module' });

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setProgress(value) {
  const n = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  bar.style.width = n + '%';
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 1800);
}

function stripDelimiters(s) {
  let t = String(s || '').trim();
  const pairs = [['\\[','\\]'], ['\\(','\\)'], ['$$','$$']];
  for (const [a,b] of pairs) {
    if (t.startsWith(a) && t.endsWith(b)) t = t.slice(a.length, -b.length).trim();
  }
  if (t.startsWith('$') && t.endsWith('$') && !t.startsWith('$$') && t.length > 1) t = t.slice(1,-1).trim();
  return t;
}

function updateCopyButtons() {
  const has = latexEl.value.trim().length > 0;
  copyWordBtn.disabled = !has;
  copyLatexBtn.disabled = !has;
  copyMathmlBtn.disabled = !has;
  charCount.textContent = `${latexEl.value.length} 字符`;
}

function getMathML() {
  const latex = stripDelimiters(latexEl.value);
  if (!latex) return '';
  if (!window.temml) throw new Error('MathML 转换组件仍在加载，请稍后重试。');
  return window.temml.renderToString(latex, { displayMode: true, trust: false });
}

function renderFormula() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    updateCopyButtons();
    const latex = stripDelimiters(latexEl.value);
    if (!latex) {
      formulaPreview.className = 'preview empty';
      formulaPreview.textContent = '识别结果会显示在这里';
      return;
    }
    try {
      const mathml = getMathML();
      formulaPreview.className = 'preview';
      formulaPreview.innerHTML = mathml;
    } catch (err) {
      formulaPreview.className = 'preview empty';
      formulaPreview.textContent = '预览失败：' + (err?.message || String(err));
    }
  }, 100);
}

async function loadImage(file, auto = true) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('请选择图片文件。', 'warn');
    return;
  }
  currentFile = file;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  previewImg.src = currentUrl;
  previewImg.hidden = false;
  dropEmpty.hidden = true;
  drop.classList.add('has-image');
  clearBtn.disabled = false;
  recognizeBtn.disabled = recognizing || (!modelReady && modelFailed);

  if (auto) {
    if (modelReady) await recognize();
    else {
      pendingAutoRecognize = true;
      setStatus(`图片已就绪，模型加载完成后会自动识别。${MODEL_SIZE_HINT}`);
    }
  }
}

function clearAll() {
  currentFile = null;
  pendingAutoRecognize = false;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  previewImg.hidden = true;
  previewImg.removeAttribute('src');
  dropEmpty.hidden = false;
  drop.classList.remove('has-image');
  fileInput.value = '';
  latexEl.value = '';
  clearBtn.disabled = true;
  recognizeBtn.disabled = !modelReady;
  renderFormula();
  setStatus(modelReady ? '模型已就绪。粘贴截图或上传公式图片即可识别。' : `正在加载模型。${MODEL_SIZE_HINT}`, modelReady ? 'ok' : '');
}

async function bitmapFromFile(file) {
  if ('createImageBitmap' in window) return await createImageBitmap(file);
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function preprocessImage(file) {
  const img = await bitmapFromFile(file);
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, src.width, src.height);
  sctx.drawImage(img, 0, 0);
  if (img.close) img.close();

  const id = sctx.getImageData(0, 0, src.width, src.height);
  const gray = new Uint8ClampedArray(src.width * src.height);
  let dark = 0, light = 0, min = 255, max = 0;
  for (let i = 0, p = 0; i < id.data.length; i += 4, p++) {
    let g = Math.round(0.299 * id.data[i] + 0.587 * id.data[i+1] + 0.114 * id.data[i+2]);
    gray[p] = g;
    if (g < 200) dark++; else light++;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  if (dark >= light) {
    min = 255; max = 0;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 255 - gray[i];
      if (gray[i] < min) min = gray[i];
      if (gray[i] > max) max = gray[i];
    }
  }

  let minX = src.width, minY = src.height, maxX = -1, maxY = -1;
  if (max > min) {
    const span = max - min;
    for (let y = 0; y < src.height; y++) {
      const row = y * src.width;
      for (let x = 0; x < src.width; x++) {
        const norm = ((gray[row+x] - min) / span) * 255;
        if (norm < 200) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    minX = 0; minY = 0; maxX = src.width - 1; maxY = src.height - 1;
  }

  const marginX = Math.max(2, Math.round((maxX - minX + 1) * 0.025));
  const marginY = Math.max(2, Math.round((maxY - minY + 1) * 0.06));
  minX = Math.max(0, minX - marginX); minY = Math.max(0, minY - marginY);
  maxX = Math.min(src.width - 1, maxX + marginX); maxY = Math.min(src.height - 1, maxY + marginY);

  const cw = Math.max(1, maxX - minX + 1), ch = Math.max(1, maxY - minY + 1);
  const crop = document.createElement('canvas');
  crop.width = cw; crop.height = ch;
  const cctx = crop.getContext('2d');
  const cropData = cctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const g = gray[(minY + y) * src.width + (minX + x)];
      const k = (y * cw + x) * 4;
      cropData.data[k] = g; cropData.data[k+1] = g; cropData.data[k+2] = g; cropData.data[k+3] = 255;
    }
  }
  cctx.putImageData(cropData, 0, 0);

  const target = 384;
  const scale = Math.min(target / cw, target / ch);
  const nw = Math.max(1, Math.round(cw * scale));
  const nh = Math.max(1, Math.round(ch * scale));
  const out = document.createElement('canvas');
  out.width = target; out.height = target;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, target, target);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(crop, Math.floor((target-nw)/2), Math.floor((target-nh)/2), nw, nh);

  const outData = octx.getImageData(0,0,target,target).data;
  const pixels = new Float32Array(target * target);
  const mean = 0.7931, std = 0.1738;
  for (let i = 0, p = 0; i < outData.length; i += 4, p++) {
    pixels[p] = (outData[i] / 255 - mean) / std;
  }
  return pixels;
}

async function recognize() {
  if (!currentFile || recognizing) return;
  if (!modelReady) {
    pendingAutoRecognize = true;
    setStatus('模型仍在加载，加载完成后会自动识别。');
    return;
  }
  recognizing = true;
  recognizeBtn.disabled = true;
  setProgress(100);
  setStatus('正在预处理图片并识别公式…');
  try {
    const pixels = await preprocessImage(currentFile);
    worker.postMessage({ type: 'predict', pixels: pixels.buffer }, [pixels.buffer]);
  } catch (err) {
    recognizing = false;
    recognizeBtn.disabled = !currentFile;
    setStatus('图片处理失败：' + (err?.message || String(err)), 'error');
  }
}

worker.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data.type === 'progress') {
    const p = Number(data.progress);
    if (Number.isFinite(p)) setProgress(p);
    const file = data.file ? `：${String(data.file).split('/').pop()}` : '';
    setStatus(`正在加载本地公式识别模型${file}${Number.isFinite(p) ? `（${Math.round(p)}%）` : ''}。${MODEL_SIZE_HINT}`);
  } else if (data.type === 'ready') {
    modelReady = true;
    modelFailed = false;
    setProgress(100);
    recognizeBtn.disabled = !currentFile;
    setStatus('模型已就绪。粘贴截图或上传公式图片即可识别。', 'ok');
    if (pendingAutoRecognize && currentFile) {
      pendingAutoRecognize = false;
      await recognize();
    }
  } else if (data.type === 'result') {
    recognizing = false;
    const text = stripDelimiters(data.text || '');
    latexEl.value = text;
    renderFormula();
    recognizeBtn.disabled = !currentFile;
    setStatus(text ? '识别完成。可直接复制到 Word / MathType，也可以先修改 LaTeX。' : '识别完成，但没有得到公式，请换一张更清晰、裁剪更紧的截图。', text ? 'ok' : 'warn');
    showToast(text ? '识别完成' : '未识别到公式');
  } else if (data.type === 'error') {
    recognizing = false;
    if (!modelReady) modelFailed = true;
    recognizeBtn.disabled = !currentFile || !modelReady;
    setStatus('识别模型发生错误：' + (data.message || '未知错误') + '。请刷新页面后重试。', 'error');
  }
});

worker.addEventListener('error', (e) => {
  modelFailed = true;
  recognizing = false;
  setStatus('模型线程加载失败：' + (e.message || '未知错误') + '。请刷新页面重试。', 'error');
});

worker.postMessage({ type: 'init' });

fileInput.addEventListener('change', () => loadImage(fileInput.files?.[0]));
clearBtn.addEventListener('click', clearAll);
recognizeBtn.addEventListener('click', recognize);
latexEl.addEventListener('input', renderFormula);

drop.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) { e.preventDefault(); fileInput.click(); }
});
for (const ev of ['dragenter','dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); });
for (const ev of ['dragleave','drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); });
drop.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) loadImage(f);
});

document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find(x => x.type.startsWith('image/'));
  if (item) {
    const file = item.getAsFile();
    if (file) { e.preventDefault(); loadImage(file); }
  }
});

async function copyPlain(text, success) {
  await navigator.clipboard.writeText(text);
  showToast(success);
}

copyLatexBtn.addEventListener('click', async () => {
  try { await copyPlain(stripDelimiters(latexEl.value), 'LaTeX 已复制'); }
  catch { setStatus('浏览器拒绝访问剪贴板，请手动选中 LaTeX 复制。', 'warn'); }
});

copyMathmlBtn.addEventListener('click', async () => {
  try { await copyPlain(getMathML(), 'MathML 已复制'); }
  catch (err) { setStatus('MathML 复制失败：' + (err?.message || String(err)), 'warn'); }
});

copyWordBtn.addEventListener('click', async () => {
  try {
    const latex = stripDelimiters(latexEl.value);
    const mathml = getMathML();
    if (navigator.clipboard?.write && window.ClipboardItem) {
      const html = `<div>${mathml}</div>`;
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([latex], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      showToast('已复制，可到 Word 直接 Ctrl+V');
      setStatus('已复制。现在切到 Word / MathType，按 Ctrl+V 粘贴。若个别 Word 版本粘贴成纯文本，可用“复制 MathML”作为备用。', 'ok');
    } else {
      await navigator.clipboard.writeText(mathml);
      showToast('已复制 MathML');
    }
  } catch (err) {
    setStatus('复制失败：' + (err?.message || String(err)) + '。可以改用“复制 LaTeX”或“复制 MathML”。', 'warn');
  }
});

renderFormula();
