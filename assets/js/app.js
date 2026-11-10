/* Nikon Picture Control Editor — UI layer.
   Pure logic (curve math, pixel pipeline, NCP/NP3 codecs, NEF preview
   extraction) lives in core.js; heavy pixel work runs in worker.js when
   workers are available (falls back to inline processing on file://). */
(() => {
'use strict';

const C = window.NPCCore;
const $ = id => document.getElementById(id);
const clamp = C.clamp;
const MAX_POINTS = C.MAX_POINTS;

const PREVIEW_SIZES = [386, 480, 640, 800, 1280, 2400];
const USER_LIB_KEY = 'npcUserPresets';

// ---------------------------------------------------------------- state

const defaultCurve = () => ({
  points: [[0, 0], [255, 255]],
  gamma: 1, minInput: 0, maxInput: 255, minOutput: 0, maxOutput: 255,
});

const state = {
  name: 'CUSTOM 01', slot: '01', base: 'Neutral', reserved02: '0',
  customCurve: false, showHistogram: true, showOutHistogram: false,
  sharpening: 3, autoSharpening: false,
  contrast: 0, autoContrast: false,
  brightness: 0,
  saturation: 0, autoSaturation: false,
  hue: 0,
  filterEffect: 0, toningType: 0, toning: 4,
  clarity: 0, midSharp: 0,
  format: 'ncp',
  curve: defaultCurve(),
  selPoint: -1,
  previewWidth: 480,
  splitCompare: false, splitPos: 0.5, splitVertical: false,
  image: null, imageLabel: '',
  histogram: null, outHistogram: null,
};

const SETTING_KEYS = [
  'name', 'slot', 'base', 'reserved02', 'customCurve', 'sharpening', 'autoSharpening',
  'contrast', 'autoContrast', 'brightness', 'saturation', 'autoSaturation', 'hue',
  'filterEffect', 'toningType', 'toning', 'clarity', 'midSharp', 'format',
];

function pickSettings() {
  const s = {};
  SETTING_KEYS.forEach(k => { s[k] = state[k]; });
  s.curve = {
    points: state.curve.points.map(p => [p[0], p[1]]),
    gamma: state.curve.gamma,
    minInput: state.curve.minInput, maxInput: state.curve.maxInput,
    minOutput: state.curve.minOutput, maxOutput: state.curve.maxOutput,
  };
  return s;
}

function applySettings(s) {
  SETTING_KEYS.forEach(k => { if (k in s) state[k] = s[k]; });
  state.curve = {
    points: (s.curve.points || [[0, 0], [255, 255]]).map(p => [p[0], p[1]]),
    gamma: s.curve.gamma || 1,
    minInput: s.curve.minInput || 0, maxInput: s.curve.maxInput ?? 255,
    minOutput: s.curve.minOutput || 0, maxOutput: s.curve.maxOutput ?? 255,
  };
  state.selPoint = -1;
}

// ---------------------------------------------------------------- undo / redo

const past = [], future = [];

function pushHistory() {
  const snap = JSON.stringify(pickSettings());
  if (past.length && past[past.length - 1] === snap) return;
  past.push(snap);
  if (past.length > 100) past.shift();
  future.length = 0;
}

function undo() {
  if (!past.length) return;
  const cur = JSON.stringify(pickSettings());
  let snap = past.pop();
  if (snap === cur && past.length) snap = past.pop();
  if (snap === cur) return;
  future.push(cur);
  applySettings(JSON.parse(snap));
  syncUI();
  requestRender(true);
}

function redo() {
  if (!future.length) return;
  past.push(JSON.stringify(pickSettings()));
  applySettings(JSON.parse(future.pop()));
  syncUI();
  requestRender(true);
}

// ---------------------------------------------------------------- sample images

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const SAMPLES = [
  { label: 'Color checker', draw: (ctx, w, h) => {
    const patches = [
      [115,82,68],[194,150,130],[98,122,157],[87,108,67],[133,128,177],[103,189,170],
      [214,126,44],[80,91,166],[193,90,99],[94,60,108],[157,188,64],[224,163,46],
      [56,61,150],[70,148,73],[175,54,60],[231,199,31],[187,86,149],[8,133,161],
      [243,243,242],[200,200,200],[160,160,160],[122,122,122],[85,85,85],[52,52,52],
    ];
    ctx.fillStyle = '#1c1c1c'; ctx.fillRect(0, 0, w, h);
    const cols = 6, rows = 4, gap = w * 0.012;
    const pw = (w - gap * (cols + 1)) / cols, ph = (h - gap * (rows + 1)) / rows;
    patches.forEach((p, i) => {
      const x = gap + (i % cols) * (pw + gap), y = gap + Math.floor(i / cols) * (ph + gap);
      ctx.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`;
      ctx.fillRect(x, y, pw, ph);
    });
  }},
  { label: 'Gradients', draw: (ctx, w, h) => {
    const bands = [
      ['#000', '#fff'], ['#000', '#f00'], ['#000', '#0f0'], ['#000', '#00f'],
      ['#000', '#0ff'], ['#000', '#f0f'], ['#000', '#ff0'],
    ];
    const bh = h / (bands.length + 1);
    bands.forEach((b, i) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, b[0]); g.addColorStop(1, b[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, i * bh, w, bh + 1);
    });
    const hue = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 12; i++) hue.addColorStop(i / 12, `hsl(${i * 30},100%,50%)`);
    ctx.fillStyle = hue;
    ctx.fillRect(0, bands.length * bh, w, bh + 1);
  }},
  { label: 'Landscape', draw: (ctx, w, h) => {
    const horizon = h * 0.62;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#27437a'); sky.addColorStop(0.55, '#7d9cc4');
    sky.addColorStop(0.85, '#e8b87c'); sky.addColorStop(1, '#f6d9a0');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, horizon);
    const sun = ctx.createRadialGradient(w * 0.7, horizon * 0.88, 0, w * 0.7, horizon * 0.88, w * 0.13);
    sun.addColorStop(0, 'rgba(255,244,214,1)'); sun.addColorStop(0.25, 'rgba(255,220,150,0.85)');
    sun.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, w, horizon);
    const ridge = (base, amp, color) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(0, base);
      for (let x = 0; x <= w; x += w / 40) {
        ctx.lineTo(x, base - amp * (0.5 + 0.5 * Math.sin(x / w * 9 + base) * Math.sin(x / w * 23)));
      }
      ctx.lineTo(w, horizon); ctx.lineTo(0, horizon); ctx.closePath(); ctx.fill();
    };
    ridge(horizon * 0.78, h * 0.13, '#8fa0b8');
    ridge(horizon * 0.90, h * 0.15, '#5c718e');
    ridge(horizon * 1.00, h * 0.17, '#33455c');
    const water = ctx.createLinearGradient(0, horizon, 0, h);
    water.addColorStop(0, '#d8b586'); water.addColorStop(0.25, '#7d92ac');
    water.addColorStop(1, '#22364e');
    ctx.fillStyle = water; ctx.fillRect(0, horizon, w, h - horizon);
    ctx.globalAlpha = 0.25; ctx.fillStyle = '#fff3cf';
    for (let i = 0; i < 26; i++) {
      const y = horizon + (h - horizon) * Math.pow(i / 26, 1.6);
      const lw = w * 0.16 * (1 - i / 30);
      ctx.fillRect(w * 0.7 - lw / 2, y, lw, Math.max(1.5, h * 0.004));
    }
    ctx.globalAlpha = 1;
  }},
  { label: 'Skin tones', draw: (ctx, w, h) => {
    ctx.fillStyle = '#6f6f6f'; ctx.fillRect(0, 0, w, h);
    const tones = [
      [244,208,177],[231,180,143],[213,158,122],[188,131,95],[156,101,69],[96,64,45],
    ];
    const cols = 3, rows = 2, gap = w * 0.02;
    const pw = (w - gap * (cols + 1)) / cols, ph = (h - gap * (rows + 1)) / rows;
    tones.forEach((t, i) => {
      const x = gap + (i % cols) * (pw + gap), y = gap + Math.floor(i / cols) * (ph + gap);
      const g = ctx.createRadialGradient(x + pw * 0.42, y + ph * 0.4, pw * 0.05, x + pw / 2, y + ph / 2, pw * 0.75);
      g.addColorStop(0, `rgb(${Math.min(255, t[0] + 24)},${Math.min(255, t[1] + 24)},${Math.min(255, t[2] + 24)})`);
      g.addColorStop(0.6, `rgb(${t[0]},${t[1]},${t[2]})`);
      g.addColorStop(1, `rgb(${Math.round(t[0] * 0.55)},${Math.round(t[1] * 0.55)},${Math.round(t[2] * 0.55)})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, pw, ph);
    });
  }},
  { label: 'Hue wheel', draw: (ctx, w, h) => {
    ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, w, h);
    const cx = w * 0.38, cy = h / 2, R = Math.min(w, h) * 0.42;
    if (ctx.createConicGradient) {
      const g = ctx.createConicGradient(0, cx, cy);
      for (let i = 0; i <= 24; i++) g.addColorStop(i / 24, `hsl(${i * 15},95%,55%)`);
      ctx.fillStyle = g;
    } else ctx.fillStyle = '#888';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    const wash = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    wash.addColorStop(0, 'rgba(255,255,255,1)'); wash.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = wash;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    const bar = ctx.createLinearGradient(0, h * 0.08, 0, h * 0.92);
    bar.addColorStop(0, '#fff'); bar.addColorStop(1, '#000');
    ctx.fillStyle = bar;
    ctx.fillRect(w * 0.78, h * 0.08, w * 0.14, h * 0.84);
  }},
];

// ---------------------------------------------------------------- curve canvas

const PLOT = { x0: 5, y0: 5, x1: 316, y1: 316 };

function xToPx(x) { return PLOT.x0 + x / 255 * (PLOT.x1 - PLOT.x0); }
function yToPx(y) { return PLOT.y1 - y / 255 * (PLOT.y1 - PLOT.y0); }

function scalePoint(p, c) {
  return [
    p[0] * (c.maxInput - c.minInput) / 255 + c.minInput,
    p[1] * (c.maxOutput - c.minOutput) / 255 + c.minOutput,
  ];
}

function drawHistogramBars(ctx, hist, color) {
  ctx.fillStyle = color;
  const bw = (PLOT.x1 - PLOT.x0) / 256;
  for (let i = 0; i < 256; i++) {
    const v = hist[i];
    if (!v) continue;
    const hh = v * (PLOT.y1 - PLOT.y0);
    ctx.fillRect(PLOT.x0 + i * bw, PLOT.y1 - hh, Math.max(1, bw), hh);
  }
}

function drawCurve() {
  const cv = $('cCurve'), ctx = cv.getContext('2d');
  const c = state.curve;
  ctx.clearRect(0, 0, cv.width, cv.height);

  ctx.strokeStyle = '#b7b7b7'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const gx = PLOT.x0 + (PLOT.x1 - PLOT.x0) * i / 4 + 0.5 | 0;
    const gy = PLOT.y0 + (PLOT.y1 - PLOT.y0) * i / 4 + 0.5 | 0;
    ctx.moveTo(gx + 0.5, PLOT.y0); ctx.lineTo(gx + 0.5, PLOT.y1);
    ctx.moveTo(PLOT.x0, gy + 0.5); ctx.lineTo(PLOT.x1, gy + 0.5);
  }
  ctx.stroke();

  if (state.showHistogram && state.histogram) drawHistogramBars(ctx, state.histogram, '#cfcfcf');
  if (state.showOutHistogram && state.outHistogram) drawHistogramBars(ctx, state.outHistogram, 'rgba(212,64,64,0.35)');

  if (!state.customCurve) return;

  const lut = C.buildLUT(c);
  ctx.strokeStyle = '#d40000'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let x = 0; x < 256; x++) {
    const px = xToPx(x), py = yToPx(lut[x]);
    if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  const pts = c.points;
  for (let i = 0; i < pts.length; i++) {
    const sp = scalePoint(pts[i], c);
    ctx.fillStyle = i === state.selPoint ? '#d40000' : '#111';
    ctx.fillRect(xToPx(sp[0]) - 3, yToPx(sp[1]) - 3, 7, 7);
    if (i === state.selPoint) {
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
      ctx.strokeRect(xToPx(sp[0]) - 4.5, yToPx(sp[1]) - 4.5, 10, 10);
    }
  }
}

function eventToCurveXY(e) {
  const cv = $('cCurve');
  const r = cv.getBoundingClientRect();
  const ix = (e.clientX - r.left) / r.width * cv.width;
  const iy = (e.clientY - r.top) / r.height * cv.height;
  const x = clamp((ix - PLOT.x0) / (PLOT.x1 - PLOT.x0) * 255, 0, 255);
  const y = clamp((PLOT.y1 - iy) / (PLOT.y1 - PLOT.y0) * 255, 0, 255);
  return [x, y];
}

function unscaleX(x, c) { return clamp((x - c.minInput) * 255 / ((c.maxInput - c.minInput) || 1e-6), 0, 255); }
function unscaleY(y, c) { return clamp((y - c.minOutput) * 255 / ((c.maxOutput - c.minOutput) || 1e-6), 0, 255); }

function nearestPoint(x, y) {
  const c = state.curve;
  let best = -1, bestD = 12;
  c.points.forEach((p, i) => {
    const sp = scalePoint(p, c);
    const d = Math.max(Math.abs(sp[0] - x), Math.abs(sp[1] - y));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

let dragIdx = -1;

function updateReadout(x, y, isPoint) {
  const el = $('curveReadout');
  if (x == null) { el.textContent = ''; return; }
  el.textContent = isPoint
    ? `point ${Math.round(x)} : ${Math.round(y)}`
    : `${Math.round(x)} : ${Math.round(C.buildLUT(state.curve)[Math.round(x)])}`;
}

function curvePointerDown(e) {
  if (!state.customCurve) return;
  $('cCurve').focus();
  const [x, y] = eventToCurveXY(e);
  const c = state.curve;
  pushHistory();
  if (e.ctrlKey || e.metaKey) {
    if (c.points.length >= MAX_POINTS) return;
    const rawX = Math.round(unscaleX(x, c));
    if (c.points.some(p => Math.abs(p[0] - rawX) < 1)) return;
    const lut = C.buildLUT(c);
    const rawY = Math.round(unscaleY(lut[Math.round(x)], c));
    c.points.push([rawX, rawY]);
    c.points.sort((a, b) => a[0] - b[0]);
    state.selPoint = c.points.findIndex(p => p[0] === rawX);
    dragIdx = state.selPoint;
    onCurveChanged();
    e.preventDefault();
    return;
  }
  const idx = nearestPoint(x, y);
  state.selPoint = idx;
  dragIdx = idx;
  refreshPointsTable();
  requestRender(false);
  e.preventDefault();
}

function curvePointerMove(e) {
  const [mx, my] = eventToCurveXY(e);
  if (dragIdx < 0) {
    if (state.customCurve) updateReadout(mx, null);
    return;
  }
  const c = state.curve;
  const p = c.points[dragIdx];
  if (!p) { dragIdx = -1; return; }
  const lo = dragIdx > 0 ? c.points[dragIdx - 1][0] + 1 : 0;
  const hi = dragIdx < c.points.length - 1 ? c.points[dragIdx + 1][0] - 1 : 255;
  p[0] = clamp(Math.round(unscaleX(mx, c)), lo, hi);
  p[1] = Math.round(unscaleY(my, c));
  updateReadout(p[0], p[1], true);
  onCurveChanged();
}

function curveKeyDown(e) {
  if (!state.customCurve) return;
  const c = state.curve, i = state.selPoint;
  if (i < 0 || !c.points[i]) return;
  const p = c.points[i];
  const lo = i > 0 ? c.points[i - 1][0] + 1 : 0;
  const hi = i < c.points.length - 1 ? c.points[i + 1][0] - 1 : 255;
  pushHistory();
  switch (e.key) {
    case 'ArrowLeft':  p[0] = clamp(p[0] - 1, lo, hi); break;
    case 'ArrowRight': p[0] = clamp(p[0] + 1, lo, hi); break;
    case 'ArrowUp':    p[1] = clamp(p[1] + 1, 0, 255); break;
    case 'ArrowDown':  p[1] = clamp(p[1] - 1, 0, 255); break;
    case 'Backspace': case 'Delete':
      if (c.points.length > 2) { c.points.splice(i, 1); state.selPoint = -1; }
      break;
    default: return;
  }
  e.preventDefault();
  updateReadout(p[0], p[1], true);
  onCurveChanged();
}

// ---------------------------------------------------------------- points table

function buildPointsTable() {
  const box = $('pointsTable');
  box.innerHTML = '';
  for (let i = 0; i < MAX_POINTS; i++) {
    const cell = document.createElement('span');
    cell.className = 'pt';
    cell.innerHTML = `<span class="num" data-i="${i}">${i + 1}</span>` +
      `<input data-i="${i}" data-axis="0"><input data-i="${i}" data-axis="1">`;
    box.appendChild(cell);
  }
  box.addEventListener('click', e => {
    if (!e.target.classList.contains('num')) return;
    const i = +e.target.dataset.i;
    if (i < state.curve.points.length) {
      state.selPoint = i;
      refreshPointsTable();
      requestRender(false);
    }
  });
  box.addEventListener('change', e => {
    const t = e.target;
    if (t.tagName !== 'INPUT') return;
    const i = +t.dataset.i, axis = +t.dataset.axis;
    const c = state.curve;
    pushHistory();
    if (i >= c.points.length) {
      const other = t.parentElement.querySelector(`input[data-axis="${1 - axis}"]`);
      const x = axis === 0 ? parseInt(t.value, 10) : parseInt(other.value, 10);
      const y = axis === 1 ? parseInt(t.value, 10) : parseInt(other.value, 10);
      if (isNaN(x) || isNaN(y) || c.points.length >= MAX_POINTS) return;
      c.points.push([clamp(x, 0, 255), clamp(y, 0, 255)]);
    } else {
      const v = parseInt(t.value, 10);
      if (isNaN(v)) {
        if (c.points.length > 2) { c.points.splice(i, 1); state.selPoint = -1; }
      } else {
        c.points[i][axis] = clamp(v, 0, 255);
      }
    }
    c.points.sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < c.points.length; k++) {
      if (c.points[k][0] <= c.points[k - 1][0]) c.points[k][0] = c.points[k - 1][0] + 1;
    }
    onCurveChanged();
  });
}

function refreshPointsTable() {
  const c = state.curve;
  document.querySelectorAll('#pointsTable .pt').forEach((cell, i) => {
    const [xi, yi] = cell.querySelectorAll('input');
    if (i < c.points.length) {
      if (document.activeElement !== xi) xi.value = Math.round(c.points[i][0]);
      if (document.activeElement !== yi) yi.value = Math.round(c.points[i][1]);
    } else {
      if (document.activeElement !== xi) xi.value = '';
      if (document.activeElement !== yi) yi.value = '';
    }
    cell.classList.toggle('sel', i === state.selPoint);
  });
}

// ---------------------------------------------------------------- preview

let worker = null, workerSeq = 0;
try {
  if (location.protocol.startsWith('http')) {
    worker = new Worker('assets/js/worker.js');
    worker.onmessage = e => {
      const { seq, buffer, width, height } = e.data;
      if (seq !== workerSeq) return; // stale result
      lastProcessed = new ImageData(new Uint8ClampedArray(buffer), width, height);
      paintPreview();
      schedulePresetBrowser();
    };
    worker.onerror = err => { console.warn('worker failed, falling back', err); worker = null; };
  }
} catch (e) { worker = null; }

const srcCanvas = makeCanvas(1, 1);
let lastProcessed = null;

let renderQueued = false, renderImageToo = false;

function requestRender(withImage) {
  if (withImage) renderImageToo = true;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    updateHistograms();
    drawCurve();
    refreshPointsTable();
    if (renderImageToo) { renderImageToo = false; renderPreview(); }
  });
}

function computeHistogram(imgData) {
  const h = new Float32Array(256);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    h[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  }
  return h;
}

let rawHistogram = null; // unnormalized input histogram

function updateHistograms() {
  if (!rawHistogram) { state.histogram = state.outHistogram = null; return; }
  let max = 0;
  for (let i = 0; i < 256; i++) if (rawHistogram[i] > max) max = rawHistogram[i];
  if (!max) return;
  const norm = new Float32Array(256);
  for (let i = 0; i < 256; i++) norm[i] = Math.sqrt(rawHistogram[i] / max);
  state.histogram = norm;
  // output histogram: input luminance pushed through the channel LUT
  const lut = C.buildChannelLUT(pickSettings());
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) out[lut ? lut[i] : i] += rawHistogram[i];
  let omax = 0;
  for (let i = 0; i < 256; i++) if (out[i] > omax) omax = out[i];
  for (let i = 0; i < 256; i++) out[i] = omax ? Math.sqrt(out[i] / omax) : 0;
  state.outHistogram = out;
}

function renderPreview() {
  const img = state.image;
  const msg = $('previewMsg');
  if (!img) { msg.textContent = 'no image loaded'; return; }
  msg.textContent = '';
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  const w = state.previewWidth;
  const h = Math.max(1, Math.round(ih * w / iw));
  srcCanvas.width = w; srcCanvas.height = h;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = sctx.getImageData(0, 0, w, h);
  } catch (err) {
    msg.textContent = 'cannot process this image: the source blocks cross-origin use. ' +
                      'Download it and use "open file…" instead.';
    return;
  }
  rawHistogram = computeHistogram(data);
  updateHistograms();

  const co = $('cOriginal');
  co.width = w; co.height = h;
  co.getContext('2d').drawImage(srcCanvas, 0, 0);

  const settings = pickSettings();
  workerSeq++;
  if (worker) {
    worker.postMessage(
      { seq: workerSeq, buffer: data.data.buffer, width: w, height: h, settings },
      [data.data.buffer]
    );
  } else {
    C.processImageData(data.data, w, h, settings);
    lastProcessed = data;
    paintPreview();
    schedulePresetBrowser();
  }
  drawCurve();
}

function paintPreview() {
  if (!lastProcessed) return;
  const cv = $('cPreview');
  const w = lastProcessed.width, h = lastProcessed.height;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.putImageData(lastProcessed, 0, 0);
  placeOriginalPanel();
  if (state.splitCompare && state.splitVertical) {
    // original on top, processed below
    const sy = Math.round(clamp(state.splitPos, 0.02, 0.98) * h);
    ctx.drawImage(srcCanvas, 0, 0, w, sy, 0, 0, w, sy);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, sy - 1, w, 2);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, sy, w, 1);
    ctx.font = 'bold 11px Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('original', 6, 14);
    ctx.fillText('processed', 6, h - 6);
  } else if (state.splitCompare) {
    const sx = Math.round(clamp(state.splitPos, 0.02, 0.98) * w);
    ctx.drawImage(srcCanvas, 0, 0, sx, h, 0, 0, sx, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(sx - 1, 0, 2, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(sx, 0, 1, h);
    ctx.font = 'bold 11px Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('original', 6, 14);
    const label = 'processed';
    ctx.fillText(label, w - ctx.measureText(label).width - 6, 14);
  }
}

// ---------------------------------------------------------------- preset browser

const THUMB_W = 132, THUMB_H = 88;
let browserToken = 0;

function presetBrowserVisible() {
  return $('viewPresetBrowser').checked;
}

function schedulePresetBrowser() {
  if (!presetBrowserVisible()) return;
  buildPresetBrowser();
}

function buildPresetBrowser() {
  const box = $('presetBrowser');
  const token = ++browserToken;
  box.innerHTML = '';
  if (!state.image) return;
  const iw = state.image.width || state.image.naturalWidth;
  const ih = state.image.height || state.image.naturalHeight;
  const th = Math.max(1, Math.round(ih * THUMB_W / iw));
  const base = makeCanvas(THUMB_W, th);
  base.getContext('2d').drawImage(state.image, 0, 0, THUMB_W, th);
  let baseData;
  try {
    baseData = base.getContext('2d').getImageData(0, 0, THUMB_W, th);
  } catch (e) { return; }

  const entries = allPresets();
  let idx = 0;
  const step = () => {
    if (token !== browserToken) return;
    const t0 = performance.now();
    while (idx < entries.length && performance.now() - t0 < 12) {
      const { preset, ref } = entries[idx++];
      const cell = document.createElement('span');
      cell.className = 'pb-item';
      const cv = makeCanvas(THUMB_W, th);
      const copy = new ImageData(new Uint8ClampedArray(baseData.data), THUMB_W, th);
      const s = presetToSettings(preset);
      C.processImageData(copy.data, THUMB_W, th, s);
      cv.getContext('2d').putImageData(copy, 0, 0);
      cv.title = preset.label || preset.name;
      const cap = document.createElement('span');
      cap.className = 'pb-cap';
      cap.textContent = preset.label || preset.name;
      cell.appendChild(cv);
      cell.appendChild(cap);
      cell.addEventListener('click', () => {
        pushHistory();
        loadPreset(preset);
        selectListEntry(ref);
      });
      box.appendChild(cell);
    }
    if (idx < entries.length) setTimeout(step, 0);
  };
  step();
}

function presetToSettings(p) {
  return {
    customCurve: !!p.customCurve,
    base: C.BASE_ENUM[p.picCtrl] != null ? p.picCtrl : 'Neutral',
    sharpening: typeof p.sharpening === 'number' ? p.sharpening : 3,
    autoSharpening: p.sharpening === 'auto',
    contrast: typeof p.contrast === 'number' ? p.contrast : 0,
    autoContrast: p.contrast === 'auto',
    brightness: typeof p.brightness === 'number' ? p.brightness : 0,
    saturation: typeof p.saturation === 'number' ? p.saturation : 0,
    autoSaturation: p.saturation === 'auto',
    hue: typeof p.hue === 'number' ? p.hue : 0,
    filterEffect: p.filterEffect ?? 0,
    toningType: p.toningType ?? 0,
    toning: p.toning,
    clarity: p.clarity || 0, midSharp: p.midSharp || 0,
    curve: {
      points: (p.curve.points && p.curve.points.length > 1 ? p.curve.points : [[0, 0], [255, 255]]).map(q => [q[0], q[1]]),
      gamma: p.curve.gamma || 1,
      minInput: p.curve.minInput || 0, maxInput: p.curve.maxInput ?? 255,
      minOutput: p.curve.minOutput || 0, maxOutput: p.curve.maxOutput ?? 255,
    },
  };
}

// ---------------------------------------------------------------- presets & user library

function loadUserLib() {
  try { return JSON.parse(localStorage.getItem(USER_LIB_KEY)) || []; }
  catch (e) { return []; }
}

function saveUserLib(lib) {
  localStorage.setItem(USER_LIB_KEY, JSON.stringify(lib));
}

// entries: { preset, ref } where ref = 'u:i' or 'c:i'
function allPresets() {
  const out = [];
  loadUserLib().forEach((p, i) => out.push({ preset: p, ref: 'u:' + i }));
  (window.NPC_PRESETS || []).forEach((p, i) => out.push({ preset: p, ref: 'c:' + i }));
  return out;
}

function presetByRef(ref) {
  const [kind, i] = ref.split(':');
  return kind === 'u' ? loadUserLib()[+i] : (window.NPC_PRESETS || [])[+i];
}

function buildPresetList() {
  const sel = $('selFileList');
  const q = $('presetSearch').value.trim().toLowerCase();
  const keep = sel.value;
  sel.innerHTML = '';
  const user = loadUserLib();
  const match = p => !q || (p.label || p.name || '').toLowerCase().includes(q);
  if (user.length) {
    const og = document.createElement('optgroup');
    og.label = '— My presets —';
    user.forEach((p, i) => {
      if (!match(p)) return;
      const o = document.createElement('option');
      o.value = 'u:' + i;
      o.textContent = `[${p.slot || '--'}] ${p.label || p.name}`;
      og.appendChild(o);
    });
    if (og.children.length) sel.appendChild(og);
  }
  (window.NPC_PRESETS || []).forEach((p, i) => {
    if (!match(p)) return;
    const o = document.createElement('option');
    o.value = 'c:' + i;
    o.textContent = `[${p.slot}] ${p.label}`;
    o.title = `${p.label} — base: ${p.picCtrl}`;
    sel.appendChild(o);
  });
  if (keep) sel.value = keep;
  updatePresetButtons();
}

function selectListEntry(ref) {
  $('selFileList').value = ref;
  updatePresetButtons();
}

function updatePresetButtons() {
  $('btnDeletePreset').disabled = !String($('selFileList').value).startsWith('u:');
}

function loadPreset(p) {
  state.name = p.name || p.label;
  state.slot = (p.filename || '').replace(/[^0-9]/g, '') || p.slot || '01';
  state.base = C.BASE_ENUM[p.picCtrl] != null ? p.picCtrl : 'Neutral';
  state.reserved02 = p.reserved02 || '0';
  state.customCurve = !!p.customCurve;
  state.autoSharpening = p.sharpening === 'auto';
  state.sharpening = typeof p.sharpening === 'number' ? p.sharpening : 3;
  state.autoContrast = p.contrast === 'auto';
  state.contrast = typeof p.contrast === 'number' ? p.contrast : 0;
  state.brightness = typeof p.brightness === 'number' ? p.brightness : 0;
  state.autoSaturation = p.saturation === 'auto';
  state.saturation = typeof p.saturation === 'number' ? p.saturation : 0;
  state.hue = typeof p.hue === 'number' ? p.hue : 0;
  state.filterEffect = p.filterEffect ?? 0;
  state.toningType = p.toningType ?? 0;
  state.toning = p.toning;
  state.clarity = p.clarity || 0;
  state.midSharp = p.midSharp || 0;
  if (p.format) state.format = p.format;
  state.curve = {
    points: (p.curve.points || []).map(q => [q[0], q[1]]),
    gamma: p.curve.gamma || 1,
    minInput: p.curve.minInput || 0,
    maxInput: p.curve.maxInput ?? 255,
    minOutput: p.curve.minOutput || 0,
    maxOutput: p.curve.maxOutput ?? 255,
  };
  if (state.curve.points.length < 2) state.curve.points = [[0, 0], [255, 255]];
  state.selPoint = -1;
  syncUI();
  requestRender(true);
}

function currentAsPreset() {
  return {
    label: state.name, slot: normSlot(state.slot), name: state.name,
    filename: `PICCON${normSlot(state.slot)}.NCP`,
    picCtrl: state.base, reserved02: state.reserved02,
    customCurve: state.customCurve,
    sharpening: state.autoSharpening ? 'auto' : state.sharpening,
    contrast: state.autoContrast ? 'auto' : state.contrast,
    brightness: state.brightness,
    saturation: state.autoSaturation ? 'auto' : state.saturation,
    hue: state.hue,
    filterEffect: state.filterEffect, toningType: state.toningType, toning: state.toning,
    clarity: state.clarity, midSharp: state.midSharp, format: state.format,
    curve: pickSettings().curve,
    user: true,
  };
}

function savePresetToLib() {
  const lib = loadUserLib();
  const p = currentAsPreset();
  const existing = lib.findIndex(x => (x.name || x.label) === p.name);
  if (existing >= 0) lib[existing] = p; else lib.push(p);
  lib.sort((a, b) => (a.label || '').toLowerCase() < (b.label || '').toLowerCase() ? -1 : 1);
  saveUserLib(lib);
  buildPresetList();
  const i = lib.findIndex(x => (x.name || x.label) === p.name);
  selectListEntry('u:' + i);
  schedulePresetBrowser();
  flash(`saved "${p.name}" to my presets`);
}

function deleteSelectedPreset() {
  const ref = $('selFileList').value;
  if (!ref.startsWith('u:')) return;
  const lib = loadUserLib();
  const idx = +ref.split(':')[1];
  const name = lib[idx] && (lib[idx].label || lib[idx].name);
  lib.splice(idx, 1);
  saveUserLib(lib);
  buildPresetList();
  schedulePresetBrowser();
  flash(`deleted "${name}"`);
}

function flash(text) {
  $('dlName').textContent = text;
  setTimeout(() => syncUI(), 2500);
}

// ---------------------------------------------------------------- share url

function stateToHash() {
  const c = state.curve;
  const o = {
    n: state.name, s: state.slot, b: state.base, r: state.reserved02,
    cc: state.customCurve ? 1 : 0,
    sh: state.autoSharpening ? 'a' : state.sharpening,
    co: state.autoContrast ? 'a' : state.contrast,
    br: state.brightness,
    sa: state.autoSaturation ? 'a' : state.saturation,
    hu: state.hue, fe: state.filterEffect, tt: state.toningType, tn: state.toning,
    cl: state.clarity, ms: state.midSharp, f: state.format,
    g: c.gamma, mi: c.minInput, ma: c.maxInput, mo: c.minOutput, mx: c.maxOutput,
    p: c.points.map(p => p.join(':')).join(','),
  };
  return '#s=' + btoa(unescape(encodeURIComponent(JSON.stringify(o))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadHash() {
  const m = location.hash.match(/#s=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
    state.name = String(o.n || 'CUSTOM');
    state.slot = String(o.s || '01');
    state.base = C.BASE_ENUM[o.b] != null ? o.b : 'Neutral';
    state.reserved02 = String(o.r || '0');
    state.customCurve = !!o.cc;
    state.autoSharpening = o.sh === 'a'; state.sharpening = o.sh === 'a' ? 3 : +o.sh || 0;
    state.autoContrast = o.co === 'a';   state.contrast = o.co === 'a' ? 0 : +o.co || 0;
    state.brightness = +o.br || 0;
    state.autoSaturation = o.sa === 'a'; state.saturation = o.sa === 'a' ? 0 : +o.sa || 0;
    state.hue = +o.hu || 0;
    state.filterEffect = +o.fe || 0; state.toningType = +o.tt || 0;
    state.toning = o.tn == null ? null : +o.tn;
    state.clarity = +o.cl || 0; state.midSharp = +o.ms || 0;
    if (o.f) state.format = o.f;
    state.curve = {
      gamma: +o.g || 1,
      minInput: +o.mi || 0, maxInput: o.ma != null ? +o.ma : 255,
      minOutput: +o.mo || 0, maxOutput: o.mx != null ? +o.mx : 255,
      points: String(o.p || '0:0,255:255').split(',').map(s => s.split(':').map(Number)),
    };
    return true;
  } catch (e) {
    console.warn('bad settings hash', e);
    return false;
  }
}

// ---------------------------------------------------------------- image loading

let sourceImage = null; // image as loaded, before rotation
let imageRotation = 0;  // clockwise degrees: 0, 90, 180 or 270

// EXIF orientation -> clockwise rotation (mirrored variants are not handled)
const ORIENTATION_ROTATION = { 3: 180, 6: 90, 8: 270 };

function applyRotation() {
  const src = sourceImage;
  if (!imageRotation) { state.image = src; return; }
  const iw = src.width || src.naturalWidth, ih = src.height || src.naturalHeight;
  const quarter = imageRotation % 180 !== 0;
  const c = makeCanvas(quarter ? ih : iw, quarter ? iw : ih);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(imageRotation * Math.PI / 180);
  ctx.drawImage(src, -iw / 2, -ih / 2);
  state.image = c;
}

function rotateImage() {
  if (!sourceImage) return;
  imageRotation = (imageRotation + 90) % 360;
  applyRotation();
  requestRender(true);
  schedulePresetBrowser();
}

function setImage(src, label, rotation = 0) {
  sourceImage = src;
  imageRotation = rotation;
  applyRotation();
  state.imageLabel = label || '';
  document.querySelectorAll('#gallery canvas').forEach(t => {
    t.classList.toggle('active', t.dataset.label === state.imageLabel);
  });
  requestRender(true);
  schedulePresetBrowser();
}

function loadImageURL(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => setImage(img, url);
  img.onerror = () => { $('previewMsg').textContent = 'could not load image: ' + url; };
  img.src = url;
}

function loadImageBlob(blob, label, rotation) {
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(img.src); setImage(img, label, rotation); };
  img.onerror = () => { URL.revokeObjectURL(img.src); $('previewMsg').textContent = 'could not decode image'; };
  img.src = URL.createObjectURL(blob);
}

function loadImageFile(file) {
  if (!file) return;
  if (/\.nef$/i.test(file.name)) {
    file.arrayBuffer().then(buf => {
      const bytes = new Uint8Array(buf);
      const jpeg = C.extractNefJpeg(bytes);
      const rotation = ORIENTATION_ROTATION[C.nefOrientation(bytes)] || 0;
      loadImageBlob(new Blob([jpeg], { type: 'image/jpeg' }), file.name, rotation);
    }).catch(err => { $('previewMsg').textContent = 'NEF: ' + err.message; });
    return;
  }
  if (!file.type.startsWith('image/')) return;
  loadImageBlob(file, file.name);
}

function buildGallery() {
  const box = $('gallery');
  SAMPLES.forEach(s => {
    const full = makeCanvas(1620, 1080);
    s.draw(full.getContext('2d'), full.width, full.height);
    s.canvas = full;
    const thumb = makeCanvas(66, 44);
    thumb.getContext('2d').drawImage(full, 0, 0, 66, 44);
    thumb.title = s.label;
    thumb.dataset.label = s.label;
    thumb.addEventListener('click', () => setImage(full, s.label));
    box.appendChild(thumb);
  });
}

// ---------------------------------------------------------------- file io

function normSlot(s) {
  const n = clamp(parseInt(s, 10) || 1, 1, 99);
  return String(n).padStart(2, '0');
}

function currentFileName() {
  const ext = state.format === 'ncp' ? 'NCP' : 'NP3';
  return `PICCON${normSlot(state.slot)}.${ext}`;
}

function download() {
  const bytes = state.format === 'ncp'
    ? C.encodeNCP(pickSettings())
    : C.encodeNP3(pickSettings(), state.format === 'np3-0300' ? '0300' : '0310');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = currentFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importNCP(file) {
  file.arrayBuffer().then(buf => {
    const d = C.decodePictureControl(buf);
    pushHistory();
    state.name = d.name || file.name.replace(/\.(ncp|np2|np3)$/i, '');
    state.base = d.base || 'Neutral';
    state.reserved02 = d.reserved02 || '0';
    state.customCurve = d.customCurve;
    state.autoSharpening = d.sharpening === 'auto';
    state.sharpening = typeof d.sharpening === 'number' ? d.sharpening : 3;
    state.autoContrast = d.contrast === 'auto';
    state.contrast = typeof d.contrast === 'number' ? d.contrast : 0;
    state.brightness = typeof d.brightness === 'number' ? d.brightness : 0;
    state.autoSaturation = d.saturation === 'auto';
    state.saturation = typeof d.saturation === 'number' ? d.saturation : 0;
    state.hue = typeof d.hue === 'number' ? d.hue : 0;
    state.filterEffect = typeof d.filterEffect === 'number' ? d.filterEffect : 0;
    state.toningType = typeof d.toningType === 'number' ? d.toningType : 0;
    state.toning = typeof d.toning === 'number' ? d.toning : null;
    state.clarity = d.clarity || 0;
    state.midSharp = d.midSharp || 0;
    if (d.format === 'NP3') state.format = d.version === '0300' ? 'np3-0300' : 'np3-0310';
    else state.format = 'ncp';
    state.curve = d.curve;
    const m = file.name.match(/(\d{2})/);
    if (m) state.slot = m[1];
    state.selPoint = -1;
    $('selFileList').selectedIndex = -1;
    updatePresetButtons();
    syncUI();
    requestRender(true);
    flash(`loaded ${d.format} "${state.name}"`);
  }).catch(err => alert('Could not read picture control file: ' + err.message));
}

function exportLibrary() {
  const lib = loadUserLib();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(
    [JSON.stringify({ schema: 'nikon-pc-editor/1', presets: lib }, null, 1)],
    { type: 'application/json' }
  ));
  a.download = 'my-picture-controls.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importLibrary(file) {
  file.text().then(text => {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data.presets;
    if (!Array.isArray(incoming)) throw new Error('no presets array found');
    const lib = loadUserLib();
    let added = 0;
    incoming.forEach(p => {
      if (!p || !p.curve || !(p.name || p.label)) return;
      const name = p.name || p.label;
      const i = lib.findIndex(x => (x.name || x.label) === name);
      if (i >= 0) lib[i] = p; else lib.push(p);
      added++;
    });
    lib.sort((a, b) => (a.label || '').toLowerCase() < (b.label || '').toLowerCase() ? -1 : 1);
    saveUserLib(lib);
    buildPresetList();
    schedulePresetBrowser();
    flash(`imported ${added} preset(s)`);
  }).catch(err => alert('Could not import library: ' + err.message));
}

function resetState() {
  pushHistory();
  applySettings({
    name: 'CUSTOM 01', slot: '01', base: 'Neutral', reserved02: '0',
    customCurve: false,
    sharpening: 3, autoSharpening: false,
    contrast: 0, autoContrast: false,
    brightness: 0,
    saturation: 0, autoSaturation: false,
    hue: 0, filterEffect: 0, toningType: 0, toning: 4,
    clarity: 0, midSharp: 0, format: state.format,
    curve: defaultCurve(),
  });
  $('selFileList').selectedIndex = -1;
  updatePresetButtons();
  syncUI();
  requestRender(true);
}

// ---------------------------------------------------------------- UI sync

function isMono() { return state.base === 'Monochrome'; }

function syncUI() {
  $('baseNpc').textContent = state.name ? `${state.name} (${state.base})` : `(${state.base})`;
  $('customCurveFlag').checked = state.customCurve;
  $('showHistogram').checked = state.showHistogram;
  $('showOutHistogram').checked = state.showOutHistogram;

  $('curveArea').classList.toggle('disabled', !state.customCurve);
  $('pointsTable').style.opacity = state.customCurve ? '' : '.45';
  $('pointsTable').style.pointerEvents = state.customCurve ? '' : 'none';

  $('minInput').value = state.curve.minInput;
  $('maxInput').value = state.curve.maxInput;
  $('minOutput').value = state.curve.minOutput;
  $('maxOutput').value = state.curve.maxOutput;
  $('gamma').value = state.curve.gamma;
  $('gammaVal').textContent = Number(state.curve.gamma).toFixed(2);

  $('sharpening').value = state.sharpening;
  $('autoSharpening').checked = state.autoSharpening;
  $('sharpening').disabled = state.autoSharpening;
  $('contrast').value = state.contrast;
  $('autoContrast').checked = state.autoContrast;
  $('contrast').disabled = state.customCurve || state.autoContrast;
  $('autoContrast').disabled = state.customCurve;
  $('brightness').value = state.brightness;
  $('brightness').disabled = state.customCurve;
  $('saturation').value = state.saturation;
  $('autoSaturation').checked = state.autoSaturation;
  $('saturation').disabled = state.autoSaturation;
  $('hue').value = state.hue;
  $('clarity').value = state.clarity;
  $('midSharp').value = state.midSharp;
  const np3 = state.format !== 'ncp';
  $('np3AdjustContainer').classList.toggle('np3-off', !np3);
  $('clarity').disabled = !np3;
  $('midSharp').disabled = !np3;

  $('colorAdjustContainer').style.display = isMono() ? 'none' : '';
  $('monochromeAdjustContainer').style.display = isMono() ? '' : 'none';
  $('selFilterEffects').value = state.filterEffect;
  $('selToningType').value = state.toningType;
  $('toning').value = state.toning == null ? '' : state.toning;
  $('toning').disabled = state.toningType === 0;

  $('PicCtrlItem').value = state.base;
  $('fileFormat').value = state.format;
  $('fileName').value = state.slot;
  $('RegistrationName').value = state.name;
  $('dlName').textContent = '→ ' + currentFileName();
  $('splitCompare').checked = state.splitCompare;
  $('splitDirection').value = state.splitVertical ? 'v' : 'h';

  refreshPointsTable();
}

function onCurveChanged() {
  syncUI();
  requestRender(true);
}

// ---------------------------------------------------------------- wiring

function bindAdjust(id, key, opts = {}) {
  $(id).addEventListener('change', e => {
    let v = parseFloat(e.target.value);
    if (isNaN(v)) v = 0;
    v = Math.round(v * 4) / 4; // quarter steps (NP3); NCP export rounds to whole
    if (opts.min != null) v = clamp(v, opts.min, opts.max);
    pushHistory();
    state[key] = v;
    syncUI();
    requestRender(true);
  });
}

function bindCurveField(id, key, lo, hi) {
  $(id).addEventListener('change', e => {
    let v = parseInt(e.target.value, 10);
    if (isNaN(v)) v = key.startsWith('min') ? 0 : 255;
    pushHistory();
    state.curve[key] = clamp(v, lo, hi);
    onCurveChanged();
  });
}

function buildPreviewSizes() {
  const box = $('previewSizes');
  PREVIEW_SIZES.forEach(s => {
    const el = document.createElement('span');
    el.textContent = s + 'px';
    el.classList.toggle('active', s === state.previewWidth);
    el.addEventListener('click', () => {
      state.previewWidth = s;
      box.querySelectorAll('span').forEach(x => x.classList.toggle('active', x === el));
      requestRender(true);
    });
    box.appendChild(el);
  });
}

let originalMoved = false;
const ORIGINAL_LAYOUT_KEY = 'npc-original-layout';

function originalDocked() {
  return $('originalPanel').parentNode === $('compareBox');
}

// layout: 'float' (draggable panel), 'side' (right of the preview) or 'stack' (below it)
function setOriginalLayout(layout) {
  const panel = $('originalPanel'), box = $('compareBox');
  box.classList.toggle('side', layout === 'side');
  box.classList.toggle('stack', layout === 'stack');
  if (layout === 'float') {
    if (originalDocked()) document.body.insertBefore(panel, $('helpSection'));
    placeOriginalPanel();
  } else {
    box.appendChild(panel);
  }
  $('originalLayout').value = layout;
  try { localStorage.setItem(ORIGINAL_LAYOUT_KEY, layout); } catch (e) {}
}

function placeOriginalPanel() {
  if (originalMoved || originalDocked()) return;
  const panel = $('originalPanel');
  const pv = $('cPreview').getBoundingClientRect();
  panel.style.left = (window.scrollX + pv.left) + 'px';
  panel.style.top = (window.scrollY + pv.bottom + 8) + 'px';
}

function initOriginalPanel() {
  const panel = $('originalPanel');
  const handle = $('originalDragHandle');
  placeOriginalPanel();
  let sx = 0, sy = 0, px = 0, py = 0, dragging = false;
  handle.addEventListener('pointerdown', e => {
    if (originalDocked()) return;
    dragging = true;
    originalMoved = true;
    sx = e.clientX; sy = e.clientY;
    px = parseFloat(panel.style.left) || 0; py = parseFloat(panel.style.top) || 0;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    panel.style.left = (px + e.clientX - sx) + 'px';
    panel.style.top = Math.max(0, py + e.clientY - sy) + 'px';
  });
  handle.addEventListener('pointerup', () => { dragging = false; });
  $('originalLayout').addEventListener('change', e => setOriginalLayout(e.target.value));
  let saved = null;
  try { saved = localStorage.getItem(ORIGINAL_LAYOUT_KEY); } catch (e) {}
  if (saved === 'side' || saved === 'stack') setOriginalLayout(saved);
}

function initViewToggles() {
  const map = {
    viewHelp: 'helpSection',
    viewCustomPreview: 'customPreviewSection',
    viewPictureControls: 'pcSection',
    viewSettings: 'settingsSection',
    viewOriginalImage: 'originalPanel',
    viewPresetBrowser: 'presetBrowserSection',
  };
  Object.keys(map).forEach(id => {
    $(id).addEventListener('change', e => {
      $(map[id]).style.display = e.target.checked ? '' : 'none';
      if (id === 'viewPresetBrowser' && e.target.checked) buildPresetBrowser();
    });
  });
}

function initSplitCompare() {
  const cv = $('cPreview');
  let dragging = false;
  const setPos = e => {
    const r = cv.getBoundingClientRect();
    state.splitPos = state.splitVertical
      ? clamp((e.clientY - r.top) / r.height, 0, 1)
      : clamp((e.clientX - r.left) / r.width, 0, 1);
    paintPreview();
  };
  cv.addEventListener('pointerdown', e => {
    if (!state.splitCompare) return;
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    setPos(e);
  });
  cv.addEventListener('pointermove', e => { if (dragging) setPos(e); });
  cv.addEventListener('pointerup', () => { dragging = false; });
  $('splitCompare').addEventListener('change', e => {
    state.splitCompare = e.target.checked;
    paintPreview();
  });
  $('splitDirection').addEventListener('change', e => {
    state.splitVertical = e.target.value === 'v';
    state.splitPos = 0.5;
    if (!state.splitCompare) { state.splitCompare = true; $('splitCompare').checked = true; }
    paintPreview();
  });
}

function initPWA() {
  if (!location.protocol.startsWith('http')) return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      for (const h of params.files || []) {
        const f = await h.getFile();
        if (/\.(ncp|np2|np3)$/i.test(f.name)) importNCP(f);
        else loadImageFile(f);
      }
    });
  }
}

function init() {
  buildGallery();
  buildPresetList();
  buildPointsTable();
  buildPreviewSizes();
  initViewToggles();
  initOriginalPanel();
  initSplitCompare();
  initPWA();

  const cv = $('cCurve');
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); curvePointerDown(e); });
  cv.addEventListener('pointermove', curvePointerMove);
  cv.addEventListener('pointerup', () => { dragIdx = -1; });
  cv.addEventListener('pointerleave', () => { if (dragIdx < 0) updateReadout(null); });
  cv.addEventListener('keydown', curveKeyDown);

  $('customCurveFlag').addEventListener('change', e => {
    pushHistory();
    state.customCurve = e.target.checked;
    syncUI();
    requestRender(true);
  });
  $('showHistogram').addEventListener('change', e => {
    state.showHistogram = e.target.checked;
    requestRender(false);
  });
  $('showOutHistogram').addEventListener('change', e => {
    state.showOutHistogram = e.target.checked;
    requestRender(false);
  });

  bindCurveField('minInput', 'minInput', 0, 254);
  bindCurveField('maxInput', 'maxInput', 1, 255);
  bindCurveField('minOutput', 'minOutput', 0, 254);
  bindCurveField('maxOutput', 'maxOutput', 1, 255);
  let gammaGesture = false;
  $('gamma').addEventListener('input', e => {
    if (!gammaGesture) { gammaGesture = true; pushHistory(); }
    state.curve.gamma = Math.round(parseFloat(e.target.value) * 100) / 100;
    $('gammaVal').textContent = state.curve.gamma.toFixed(2);
    requestRender(true);
  });
  $('gamma').addEventListener('change', () => { gammaGesture = false; });

  bindAdjust('sharpening', 'sharpening', { min: -3, max: 9 });
  bindAdjust('contrast', 'contrast', { min: -3, max: 3 });
  bindAdjust('brightness', 'brightness', { min: -1.5, max: 1.5 });
  bindAdjust('saturation', 'saturation', { min: -3, max: 3 });
  bindAdjust('hue', 'hue', { min: -3, max: 3 });
  bindAdjust('clarity', 'clarity', { min: -5, max: 5 });
  bindAdjust('midSharp', 'midSharp', { min: -3, max: 3 });
  ['autoSharpening', 'autoContrast', 'autoSaturation'].forEach(id => {
    $(id).addEventListener('change', e => {
      pushHistory();
      state[id] = e.target.checked;
      syncUI();
      requestRender(true);
    });
  });
  $('selFilterEffects').addEventListener('change', e => {
    pushHistory();
    state.filterEffect = +e.target.value;
    requestRender(true);
  });
  $('selToningType').addEventListener('change', e => {
    pushHistory();
    state.toningType = +e.target.value;
    if (state.toningType > 0 && state.toning == null) state.toning = 4;
    syncUI();
    requestRender(true);
  });
  $('toning').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    pushHistory();
    state.toning = isNaN(v) ? null : clamp(v, 0, 7);
    syncUI();
    requestRender(true);
  });
  $('PicCtrlItem').addEventListener('change', e => {
    pushHistory();
    state.base = e.target.value;
    syncUI();
    requestRender(true);
  });
  $('fileFormat').addEventListener('change', e => {
    pushHistory();
    state.format = e.target.value;
    syncUI();
  });
  $('fileName').addEventListener('change', e => { state.slot = normSlot(e.target.value); syncUI(); });
  $('RegistrationName').addEventListener('change', e => {
    pushHistory();
    state.name = e.target.value.slice(0, 19);
    syncUI();
  });

  $('btnDownload').addEventListener('click', download);
  $('btnSavePreset').addEventListener('click', savePresetToLib);
  $('btnDeletePreset').addEventListener('click', deleteSelectedPreset);
  $('btnExportLib').addEventListener('click', exportLibrary);
  $('btnImportLib').addEventListener('click', () => $('fileLib').click());
  $('fileLib').addEventListener('change', e => {
    if (e.target.files[0]) importLibrary(e.target.files[0]);
    e.target.value = '';
  });
  $('btnLoadNcp').addEventListener('click', () => $('fileNcp').click());
  $('fileNcp').addEventListener('change', e => {
    if (e.target.files[0]) importNCP(e.target.files[0]);
    e.target.value = '';
  });
  $('btnReset').addEventListener('click', resetState);

  $('presetSearch').addEventListener('input', buildPresetList);
  $('selFileList').addEventListener('change', () => {
    const p = presetByRef($('selFileList').value);
    updatePresetButtons();
    if (p) { pushHistory(); loadPreset(p); }
  });

  $('btnMakeUrl').addEventListener('click', () => {
    const url = location.origin === 'null' || location.protocol === 'file:'
      ? location.pathname + stateToHash()
      : location.origin + location.pathname + stateToHash();
    history.replaceState(null, '', stateToHash());
    $('shareUrl').value = url;
    $('shareUrl').select();
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
  });

  $('btnUpdateImage').addEventListener('click', () => {
    const u = $('inpImageUrl').value.trim();
    if (u) loadImageURL(u);
  });
  $('inpImageUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btnUpdateImage').click();
  });
  $('btnOpenFile').addEventListener('click', () => $('fileImage').click());
  $('btnRotate').addEventListener('click', rotateImage);
  $('fileImage').addEventListener('change', e => {
    if (e.target.files[0]) loadImageFile(e.target.files[0]);
    e.target.value = '';
  });
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragover'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.(ncp|np2|np3)$/i.test(f.name)) importNCP(f);
    else loadImageFile(f);
  });

  document.addEventListener('keydown', e => {
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault(); redo();
    }
  });

  loadHash();
  setImage(SAMPLES[2].canvas, SAMPLES[2].label);
  pushHistory();
  syncUI();
  requestRender(true);
}

document.addEventListener('DOMContentLoaded', init);

// debug/testing surface
window.__npc = {
  state,
  encodeNCP: () => C.encodeNCP(pickSettings()),
  encodeNP3: v => C.encodeNP3(pickSettings(), v),
  decodeNCP: b => C.decodePictureControl(b),
  buildLUT: C.buildLUT,
  loadPreset, pickSettings, undo, redo,
};
})();
