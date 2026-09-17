const FAST_HINT = '快速模型约 80 MB，仅在普通公式需要时加载。';
const ACCURATE_HINT = '高精度 Texify2 约 250–300 MB，仅在复杂公式需要时加载；支持 WebGPU 时优先用显卡。';
const $ = (id) => document.getElementById(id);

const drop = $('drop');
const fileInput = $('fileInput');
const dropEmpty = $('dropEmpty');
const previewImg = $('previewImg');
const recognizeBtn = $('recognizeBtn');
const accurateBtn = $('accurateBtn');
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
let recognizing = false;
let lastEngine = '';
let renderTimer = null;
let analysisCache = null;

const worker = new Worker('./ocr-worker.js?v=20260917-lazy3', { type: 'module' });

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setProgress(value) {
  const n = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  bar.style.width = `${n}%`;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 1800);
}

function formatBytes(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return '';
  const mb = Number(n) / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function stripDelimiters(s) {
  let t = String(s || '').trim();
  for (const [a, b] of [['\\[', '\\]'], ['\\(', '\\)'], ['$$', '$$']]) {
    if (t.startsWith(a) && t.endsWith(b)) t = t.slice(a.length, -b.length).trim();
  }
  if (t.startsWith('$') && t.endsWith('$') && !t.startsWith('$$') && t.length > 1) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function normalizeOcrText(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```$/i, '').trim();
  const display = [...t.matchAll(/\$\$([\s\S]*?)\$\$/g)].map(m => m[1].trim()).filter(Boolean);
  if (display.length) return stripDelimiters(display.sort((a, b) => b.length - a.length)[0]);
  const bracket = t.match(/\\\[([\s\S]*?)\\\]/);
  if (bracket?.[1]) return stripDelimiters(bracket[1]);
  return stripDelimiters(t);
}

function looksRunaway(text) {
  const t = String(text || '');
  if (!t) return false;
  const bangCount = (t.match(/\\!/g) || []).length;
  return /(\\!\s*){10,}|(\\,\s*){14,}|(\\;\s*){14,}/.test(t) || /(.{2,12})\1{8,}/.test(t) || bangCount > 24 || t.length > 2200;
}

function updateButtons() {
  const hasImage = !!currentFile;
  recognizeBtn.disabled = !hasImage || recognizing;
  accurateBtn.disabled = !hasImage || recognizing;
  clearBtn.disabled = !hasImage || recognizing;
  const hasText = !!latexEl.value.trim();
  copyWordBtn.disabled = !hasText;
  copyLatexBtn.disabled = !hasText;
  copyMathmlBtn.disabled = !hasText;
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
    updateButtons();
    const latex = stripDelimiters(latexEl.value);
    if (!latex) {
      formulaPreview.className = 'preview empty';
      formulaPreview.textContent = '识别结果会显示在这里';
      return;
    }
    try {
      formulaPreview.className = 'preview';
      formulaPreview.innerHTML = getMathML();
    } catch (err) {
      formulaPreview.className = 'preview empty';
      formulaPreview.textContent = '预览失败：' + (err?.message || String(err));
    }
  }, 80);
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

async function analyzeAndPreprocess(file) {
  if (analysisCache?.file === file) return analysisCache.value;
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
    const g = Math.round(0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2]);
    gray[p] = g;
    g < 200 ? dark++ : light++;
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
      for (let x = 0; x < src.width; x++) {
        const norm = ((gray[y * src.width + x] - min) / span) * 255;
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
  const mx = Math.max(3, Math.round((maxX - minX + 1) * 0.035));
  const my = Math.max(3, Math.round((maxY - minY + 1) * 0.09));
  minX = Math.max(0, minX - mx); minY = Math.max(0, minY - my);
  maxX = Math.min(src.width - 1, maxX + mx); maxY = Math.min(src.height - 1, maxY + my);

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const aspect = cw / Math.max(1, ch);
  const crop = document.createElement('canvas');
  crop.width = cw; crop.height = ch;
  const cctx = crop.getContext('2d');
  const cropData = cctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const g = gray[(minY + y) * src.width + (minX + x)];
      const k = (y * cw + x) * 4;
      cropData.data[k] = g; cropData.data[k + 1] = g; cropData.data[k + 2] = g; cropData.data[k + 3] = 255;
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
  octx.drawImage(crop, Math.floor((target - nw) / 2), Math.floor((target - nh) / 2), nw, nh);

  const d = octx.getImageData(0, 0, target, target).data;
  const pixels = new Float32Array(target * target);
  const mean = 0.7931, std = 0.1738;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) pixels[p] = (d[i] / 255 - mean) / std;

  const value = { pixels, aspect, contentWidth: cw, contentHeight: ch };
  analysisCache = { file, value };
  return value;
}

async function loadImage(file, auto = true) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('请选择图片文件。', 'warn');
    return;
  }
  currentFile = file;
  analysisCache = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  previewImg.src = currentUrl;
  previewImg.hidden = false;
  dropEmpty.hidden = true;
  drop.classList.add('has-image');
  latexEl.value = '';
  setProgress(0);
  updateButtons();
  renderFormula();
  setStatus('图片已就绪。正在判断公式复杂度；只会加载真正需要的识别模型。');
  if (auto) await recognizeSmart();
}

function clearAll() {
  if (recognizing) return;
  currentFile = null;
  analysisCache = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  previewImg.hidden = true;
  previewImg.removeAttribute('src');
  dropEmpty.hidden = false;
  drop.classList.remove('has-image');
  fileInput.value = '';
  latexEl.value = '';
  setProgress(0);
  renderFormula();
  updateButtons();
  setStatus('等待公式截图。模型不会预先下载；粘贴图片后再按需加载。', 'ok');
}

async function recognizeSmart() {
  if (!currentFile || recognizing) return;
  recognizing = true;
  lastEngine = '';
  updateButtons();
  setProgress(0);
  setStatus('正在分析公式尺寸…');
  try {
    const prep = await analyzeAndPreprocess(currentFile);
    if (prep.aspect >= 2.8) {
      recognizing = false;
      await recognizeAccurate(true, `检测到横向长公式（宽高比 ${prep.aspect.toFixed(1)}），跳过快速模型，直接使用高精度模型。`);
    } else {
      lastEngine = 'fast';
      setStatus(`普通公式：${FAST_HINT} 正在准备快速识别…`);
      worker.postMessage({ type: 'predict-fast', pixels: prep.pixels.buffer }, [prep.pixels.buffer]);
    }
  } catch (err) {
    recognizing = false;
    updateButtons();
    setStatus('图片分析失败：' + (err?.message || String(err)), 'error');
  }
}

async function recognizeAccurate(auto = false, reason = '') {
  if (!currentFile || recognizing) return;
  recognizing = true;
  lastEngine = 'accurate';
  updateButtons();
  setProgress(0);
  setStatus(`${reason || (auto ? '自动切换高精度模型。' : '使用高精度模型。')} ${ACCURATE_HINT}`, 'warn');
  worker.postMessage({ type: 'predict-accurate', image: currentFile });
}

worker.addEventListener('message', async (event) => {
  const data = event.data || {};
  const engine = data.engine || lastEngine;
  const name = engine === 'accurate' ? '高精度' : '快速';

  if (data.type === 'progress') {
    const p = Number(data.progress);
    if (Number.isFinite(p)) setProgress(p);
    const file = data.file ? String(data.file).split('/').pop() : '';
    const size = data.total ? ` / ${formatBytes(data.total)}` : '';
    const pct = Number.isFinite(p) ? ` ${Math.round(p)}%` : '';
    setStatus(`${name}模型正在下载/读取缓存${file ? `：${file}` : ''}${pct}${size}。首次会慢，后续会直接使用浏览器缓存。`);
  } else if (data.type === 'phase') {
    if (data.phase === 'loading') {
      setStatus(`${name}模型正在初始化。${engine === 'accurate' ? ACCURATE_HINT : FAST_HINT}`);
    } else if (data.phase === 'infer') {
      setProgress(100);
      setStatus(`${name}模型已加载，正在识别公式…${data.backend ? `（${data.backend}）` : ''}`);
    }
  } else if (data.type === 'ready') {
    setProgress(100);
    setStatus(`${name}模型已就绪${data.backend ? `（${data.backend}）` : ''}，正在识别…`);
  } else if (data.type === 'backend-fallback') {
    setStatus(data.message || '显卡不可用，已切换 CPU。', 'warn');
  } else if (data.type === 'result') {
    recognizing = false;
    const text = normalizeOcrText(data.text || '');
    if (engine === 'fast' && looksRunaway(text) && currentFile) {
      latexEl.value = '';
      renderFormula();
      updateButtons();
      await recognizeAccurate(true, '快速模型输出异常，已自动改用高精度模型。');
      return;
    }

    latexEl.value = text;
    renderFormula();
    updateButtons();
    const sec = Number.isFinite(data.elapsed_ms) ? (data.elapsed_ms / 1000).toFixed(1) : null;
    const suffix = `${data.backend ? ` · ${data.backend}` : ''}${sec ? ` · ${sec}s` : ''}`;
    if (!text) {
      setStatus(`${name}识别没有得到有效公式${suffix}。建议把截图裁剪得更紧一些后重试。`, 'warn');
    } else if (looksRunaway(text)) {
      setStatus(`${name}模型仍出现异常重复输出${suffix}。建议缩小白边或拆成两段识别。`, 'warn');
    } else {
      setStatus(`${name}识别完成${suffix}。可以直接复制到 Word / MathType。`, 'ok');
    }
    showToast(text ? '识别完成' : '未识别到公式');
  } else if (data.type === 'error') {
    recognizing = false;
    updateButtons();
    setStatus(`${name}模型发生错误：${data.message || '未知错误'}`, 'error');
  }
});

worker.addEventListener('error', (e) => {
  recognizing = false;
  updateButtons();
  setStatus('模型线程加载失败：' + (e.message || '未知错误') + '。请刷新页面重试。', 'error');
});

fileInput.addEventListener('change', () => loadImage(fileInput.files?.[0]));
clearBtn.addEventListener('click', clearAll);
recognizeBtn.addEventListener('click', recognizeSmart);
accurateBtn.addEventListener('click', () => recognizeAccurate(false));
latexEl.addEventListener('input', renderFormula);

drop.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) {
    e.preventDefault();
    fileInput.click();
  }
});
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); });
}
drop.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) loadImage(f);
});

document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/'));
  if (item) {
    const file = item.getAsFile();
    if (file) {
      e.preventDefault();
      loadImage(file);
    }
  }
});

async function copyPlain(text, success) {
  await navigator.clipboard.writeText(text);
  showToast(success);
}

copyLatexBtn.addEventListener('click', async () => {
  try { await copyPlain(stripDelimiters(latexEl.value), 'LaTeX 已复制'); }
  catch { setStatus('浏览器拒绝访问剪贴板，请手动复制。', 'warn'); }
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
      const item = new ClipboardItem({
        'text/html': new Blob([`<div>${mathml}</div>`], { type: 'text/html' }),
        'text/plain': new Blob([latex], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      showToast('已复制，可到 Word 直接 Ctrl+V');
      setStatus('已复制。切到 Word / MathType，按 Ctrl+V 粘贴。', 'ok');
    } else {
      await navigator.clipboard.writeText(mathml);
      showToast('已复制 MathML');
    }
  } catch (err) {
    setStatus('复制失败：' + (err?.message || String(err)) + '。可改用“复制 LaTeX”或“复制 MathML”。', 'warn');
  }
});

updateButtons();
renderFormula();
setStatus('等待公式截图。模型不会预先下载；粘贴图片后再按需加载。', 'ok');
