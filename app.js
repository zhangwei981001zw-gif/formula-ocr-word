const FAST_HINT = '快速模型首次约需下载 80 MB，之后通常读取浏览器缓存。';
const ACCURATE_HINT = '高精度 Texify2 模型首次约需下载 300 MB 左右，之后会缓存；专门用于长公式、复杂上下标和多行公式。';
const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('fileInput'), dropEmpty = $('dropEmpty'), previewImg = $('previewImg');
const recognizeBtn = $('recognizeBtn'), accurateBtn = $('accurateBtn'), clearBtn = $('clearBtn');
const statusEl = $('status'), bar = $('bar'), latexEl = $('latex'), formulaPreview = $('formulaPreview');
const copyWordBtn = $('copyWordBtn'), copyLatexBtn = $('copyLatexBtn'), copyMathmlBtn = $('copyMathmlBtn');
const charCount = $('charCount'), toast = $('toast');

let currentFile = null, currentUrl = null;
let fastReady = false, recognizing = false, pendingFast = false;
let lastEngine = 'fast', renderTimer = null;
const worker = new Worker('./ocr-worker.js?v=20260917-long2', { type: 'module' });

function setStatus(text, kind = '') { statusEl.textContent = text; statusEl.className = 'status' + (kind ? ' ' + kind : ''); }
function setProgress(value) { const n = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0; bar.style.width = n + '%'; }
function showToast(text) { toast.textContent = text; toast.classList.add('show'); clearTimeout(showToast.t); showToast.t = setTimeout(() => toast.classList.remove('show'), 1800); }

function stripDelimiters(s) {
  let t = String(s || '').trim();
  for (const [a,b] of [['\\[','\\]'], ['\\(','\\)'], ['$$','$$']]) {
    if (t.startsWith(a) && t.endsWith(b)) t = t.slice(a.length, -b.length).trim();
  }
  if (t.startsWith('$') && t.endsWith('$') && !t.startsWith('$$') && t.length > 1) t = t.slice(1,-1).trim();
  return t;
}

function normalizeOcrText(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```$/i, '').trim();

  const display = [...t.matchAll(/\$\$([\s\S]*?)\$\$/g)].map(m => m[1].trim()).filter(Boolean);
  if (display.length) t = display.sort((a,b) => b.length-a.length)[0];
  else {
    const bracket = t.match(/\\\[([\s\S]*?)\\\]/);
    if (bracket?.[1]) t = bracket[1].trim();
    else {
      const inline = [...t.matchAll(/(?<!\$)\$([^$]+?)\$(?!\$)/g)].map(m => m[1].trim()).filter(Boolean);
      if (inline.length) t = inline.sort((a,b) => b.length-a.length)[0];
    }
  }
  return stripDelimiters(t);
}

function looksRunaway(text) {
  const t = String(text || '');
  if (!t) return false;
  const bangCount = (t.match(/\\!/g) || []).length;
  const sameTokenRun = /(\\!\s*){10,}|(\\,\s*){14,}|(\\;\s*){14,}/.test(t);
  const repetitive = /(.{2,12})\1{8,}/.test(t);
  return sameTokenRun || repetitive || bangCount > 24 || t.length > 2200;
}

function updateCopyButtons() {
  const has = latexEl.value.trim().length > 0;
  copyWordBtn.disabled = !has; copyLatexBtn.disabled = !has; copyMathmlBtn.disabled = !has;
  charCount.textContent = `${latexEl.value.length} 字符`;
}
function getMathML() {
  const latex = stripDelimiters(latexEl.value); if (!latex) return '';
  if (!window.temml) throw new Error('MathML 转换组件仍在加载，请稍后重试。');
  return window.temml.renderToString(latex, { displayMode: true, trust: false });
}
function renderFormula() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    updateCopyButtons(); const latex = stripDelimiters(latexEl.value);
    if (!latex) { formulaPreview.className = 'preview empty'; formulaPreview.textContent = '识别结果会显示在这里'; return; }
    try { formulaPreview.className = 'preview'; formulaPreview.innerHTML = getMathML(); }
    catch (err) { formulaPreview.className = 'preview empty'; formulaPreview.textContent = '预览失败：' + (err?.message || String(err)); }
  }, 100);
}

async function loadImage(file, auto = true) {
  if (!file || !file.type.startsWith('image/')) { setStatus('请选择图片文件。', 'warn'); return; }
  currentFile = file;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file); previewImg.src = currentUrl; previewImg.hidden = false; dropEmpty.hidden = true; drop.classList.add('has-image');
  clearBtn.disabled = false; recognizeBtn.disabled = recognizing || !fastReady; accurateBtn.disabled = recognizing;
  latexEl.value = ''; renderFormula();
  if (auto) {
    if (fastReady) recognizeSmart();
    else { pendingFast = true; setStatus(`图片已就绪，模型加载完成后会自动判断公式复杂度并识别。${FAST_HINT}`); }
  }
}

function clearAll() {
  currentFile = null; pendingFast = false; recognizing = false;
  if (currentUrl) URL.revokeObjectURL(currentUrl); currentUrl = null;
  previewImg.hidden = true; previewImg.removeAttribute('src'); dropEmpty.hidden = false; drop.classList.remove('has-image'); fileInput.value = '';
  latexEl.value = ''; clearBtn.disabled = true; recognizeBtn.disabled = !fastReady; accurateBtn.disabled = true; renderFormula();
  setStatus(fastReady ? '模型已就绪。粘贴截图后会自动判断普通公式还是长公式。' : `正在加载快速模型。${FAST_HINT}`, fastReady ? 'ok' : '');
}

async function bitmapFromFile(file) {
  if ('createImageBitmap' in window) return await createImageBitmap(file);
  return await new Promise((resolve, reject) => { const img = new Image(), url = URL.createObjectURL(file); img.onload=()=>{URL.revokeObjectURL(url);resolve(img)}; img.onerror=(e)=>{URL.revokeObjectURL(url);reject(e)}; img.src=url; });
}

async function preprocessImage(file) {
  const img = await bitmapFromFile(file), src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
  const sctx = src.getContext('2d', { willReadFrequently: true }); sctx.fillStyle='#fff'; sctx.fillRect(0,0,src.width,src.height); sctx.drawImage(img,0,0); if (img.close) img.close();
  const id=sctx.getImageData(0,0,src.width,src.height), gray=new Uint8ClampedArray(src.width*src.height);
  let dark=0, light=0, min=255, max=0;
  for(let i=0,p=0;i<id.data.length;i+=4,p++){const g=Math.round(.299*id.data[i]+.587*id.data[i+1]+.114*id.data[i+2]);gray[p]=g;g<200?dark++:light++;if(g<min)min=g;if(g>max)max=g;}
  if(dark>=light){min=255;max=0;for(let i=0;i<gray.length;i++){gray[i]=255-gray[i];if(gray[i]<min)min=gray[i];if(gray[i]>max)max=gray[i];}}
  let minX=src.width,minY=src.height,maxX=-1,maxY=-1;
  if(max>min){const span=max-min;for(let y=0;y<src.height;y++){for(let x=0;x<src.width;x++){const norm=((gray[y*src.width+x]-min)/span)*255;if(norm<200){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}}}}
  if(maxX<minX||maxY<minY){minX=0;minY=0;maxX=src.width-1;maxY=src.height-1;}
  const mx=Math.max(3,Math.round((maxX-minX+1)*.035)), my=Math.max(3,Math.round((maxY-minY+1)*.09));
  minX=Math.max(0,minX-mx);minY=Math.max(0,minY-my);maxX=Math.min(src.width-1,maxX+mx);maxY=Math.min(src.height-1,maxY+my);
  const cw=maxX-minX+1,ch=maxY-minY+1,aspect=cw/Math.max(1,ch),crop=document.createElement('canvas');crop.width=cw;crop.height=ch;
  const cctx=crop.getContext('2d'),cropData=cctx.createImageData(cw,ch);
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const g=gray[(minY+y)*src.width+(minX+x)],k=(y*cw+x)*4;cropData.data[k]=g;cropData.data[k+1]=g;cropData.data[k+2]=g;cropData.data[k+3]=255;} cctx.putImageData(cropData,0,0);
  const target=384,scale=Math.min(target/cw,target/ch),nw=Math.max(1,Math.round(cw*scale)),nh=Math.max(1,Math.round(ch*scale));
  const out=document.createElement('canvas');out.width=target;out.height=target;const octx=out.getContext('2d',{willReadFrequently:true});octx.fillStyle='#000';octx.fillRect(0,0,target,target);octx.imageSmoothingEnabled=true;octx.imageSmoothingQuality='high';octx.drawImage(crop,Math.floor((target-nw)/2),Math.floor((target-nh)/2),nw,nh);
  const d=octx.getImageData(0,0,target,target).data,pixels=new Float32Array(target*target),mean=.7931,std=.1738;for(let i=0,p=0;i<d.length;i+=4,p++)pixels[p]=(d[i]/255-mean)/std;
  return { pixels, aspect, contentWidth: cw, contentHeight: ch };
}

async function recognizeSmart() {
  if (!currentFile || recognizing) return;
  if (!fastReady) { pendingFast = true; setStatus('快速模型仍在加载，加载完成后会自动识别。'); return; }
  recognizing = true; recognizeBtn.disabled=true; accurateBtn.disabled=true; setProgress(100); setStatus('正在分析公式长度和复杂度…');
  try {
    const prep = await preprocessImage(currentFile);
    if (prep.aspect >= 3.2 || prep.contentWidth >= prep.contentHeight * 3.2) {
      recognizing = false;
      recognizeAccurate(true, `检测到横向长公式（宽高比约 ${prep.aspect.toFixed(1)}），已自动使用高精度模型。`);
      return;
    }
    lastEngine='fast';
    setStatus('普通公式：正在用快速模型识别…');
    worker.postMessage({type:'predict-fast',pixels:prep.pixels.buffer},[prep.pixels.buffer]);
  } catch(err){recognizing=false;recognizeBtn.disabled=!currentFile;accurateBtn.disabled=!currentFile;setStatus('图片处理失败：'+(err?.message||String(err)),'error');}
}

function recognizeAccurate(autoFallback=false, reason='') {
  if (!currentFile || recognizing) return;
  recognizing=true; lastEngine='accurate'; recognizeBtn.disabled=true; accurateBtn.disabled=true; setProgress(0);
  const prefix = reason || (autoFallback ? '快速模型输出异常，已自动切换高精度模型。' : '正在使用高精度模型识别复杂公式。');
  setStatus(`${prefix} ${ACCURATE_HINT}`, 'warn');
  worker.postMessage({type:'predict-accurate',image:currentFile});
}

worker.addEventListener('message', (event) => {
  const data=event.data||{}, engine=data.engine||lastEngine;
  if(data.type==='progress'){
    const p=Number(data.progress); if(Number.isFinite(p))setProgress(p); const file=data.file?`：${String(data.file).split('/').pop()}`:'';
    setStatus(`${engine==='accurate'?'高精度':'快速'}模型正在加载${file}${Number.isFinite(p)?`（${Math.round(p)}%）`:''}。${engine==='accurate'?ACCURATE_HINT:FAST_HINT}`);
  } else if(data.type==='ready'){
    if(engine==='fast'){
      fastReady=true; recognizeBtn.disabled=!currentFile; setProgress(100); setStatus('模型已就绪。粘贴截图后会自动判断普通公式还是长公式。','ok');
      if(pendingFast&&currentFile){pendingFast=false;recognizeSmart();}
    } else {
      setStatus('高精度模型已加载，正在识别复杂公式…');
    }
  } else if(data.type==='result'){
    recognizing=false; const text=normalizeOcrText(data.text||'');
    if(engine==='fast' && looksRunaway(text) && currentFile){ latexEl.value=''; renderFormula(); recognizeAccurate(true); return; }
    latexEl.value=text; renderFormula(); recognizeBtn.disabled=!currentFile||!fastReady; accurateBtn.disabled=!currentFile;
    const label=engine==='accurate'?'高精度识别':'快速识别';
    if (engine==='accurate' && looksRunaway(text)) {
      setStatus('高精度模型仍检测到异常重复输出。建议把截图只保留公式本体、去掉大面积白边后再试。','warn');
    } else {
      setStatus(text?`${label}完成。可复制到 Word / MathType，也可以先修改 LaTeX。`:`${label}没有得到有效公式，建议裁剪紧一些后再试。`,text?'ok':'warn');
    }
    showToast(text?`${label}完成`:'未识别到公式');
  } else if(data.type==='error'){
    recognizing=false; recognizeBtn.disabled=!currentFile||!fastReady; accurateBtn.disabled=!currentFile;
    setStatus(`${engine==='accurate'?'高精度':'快速'}模型发生错误：${data.message||'未知错误'}。`, 'error');
  }
});
worker.addEventListener('error',(e)=>{recognizing=false;setStatus('模型线程加载失败：'+(e.message||'未知错误')+'。请刷新页面重试。','error');});
worker.postMessage({type:'init-fast'});

fileInput.addEventListener('change',()=>loadImage(fileInput.files?.[0]));
clearBtn.addEventListener('click',clearAll);
recognizeBtn.addEventListener('click',recognizeSmart);
accurateBtn.addEventListener('click',()=>recognizeAccurate(false));
latexEl.addEventListener('input',renderFormula);
drop.addEventListener('keydown',(e)=>{if((e.key==='Enter'||e.key===' ')&&e.target===drop){e.preventDefault();fileInput.click();}});
for(const ev of ['dragenter','dragover'])drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add('drag');});
for(const ev of ['dragleave','drop'])drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.remove('drag');});
drop.addEventListener('drop',(e)=>{const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/'));if(f)loadImage(f);});
document.addEventListener('paste',(e)=>{const item=[...(e.clipboardData?.items||[])].find(x=>x.type.startsWith('image/'));if(item){const file=item.getAsFile();if(file){e.preventDefault();loadImage(file);}}});

async function copyPlain(text,success){await navigator.clipboard.writeText(text);showToast(success);}
copyLatexBtn.addEventListener('click',async()=>{try{await copyPlain(stripDelimiters(latexEl.value),'LaTeX 已复制');}catch{setStatus('浏览器拒绝访问剪贴板，请手动复制。','warn');}});
copyMathmlBtn.addEventListener('click',async()=>{try{await copyPlain(getMathML(),'MathML 已复制');}catch(err){setStatus('MathML 复制失败：'+(err?.message||String(err)),'warn');}});
copyWordBtn.addEventListener('click',async()=>{try{const latex=stripDelimiters(latexEl.value),mathml=getMathML();if(navigator.clipboard?.write&&window.ClipboardItem){const item=new ClipboardItem({'text/html':new Blob([`<div>${mathml}</div>`],{type:'text/html'}),'text/plain':new Blob([latex],{type:'text/plain'})});await navigator.clipboard.write([item]);showToast('已复制，可到 Word 直接 Ctrl+V');setStatus('已复制。现在切到 Word / MathType，按 Ctrl+V 粘贴。','ok');}else{await navigator.clipboard.writeText(mathml);showToast('已复制 MathML');}}catch(err){setStatus('复制失败：'+(err?.message||String(err))+'。可改用“复制 LaTeX”或“复制 MathML”。','warn');}});
renderFormula();
