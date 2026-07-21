/* Core logic for the Nikon Picture Control Editor: curve math, image pipeline,
   and NCP / NP3 codecs. Pure functions only — no DOM. Loaded from the page, the
   preview worker, and Node unit tests.

   Format sources (community reverse engineering):
   - https://github.com/horshack-dpreview/NikonPictureControlsDev
   - https://github.com/simeonpilgrim/nikon-firmware-tools (dumpncp.pl)
   - NP3 tag layout cross-checked against Nikon-generated .NP3 files
     (quarter-step values, type byte 0x04) and nikonpicturecontrol.com's
     open client-side parser. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.NPCCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

const BASE_ENUM = {
  Standard: 0x0001, Neutral: 0x03C2, Vivid: 0x00C3,
  D2XMode1: 0x0014, D2XMode2: 0x03D5, D2XMode3: 0x00D6,
  Portrait: 0x0486, Landscape: 0x04C7, Monochrome: 0x064D,
};
const ENUM_BASE = {};
Object.keys(BASE_ENUM).forEach(k => { ENUM_BASE[BASE_ENUM[k]] = k; });

const MAX_POINTS = 20;

const TONE_COLORS = {
  1: [162, 138, 101], 2: [84, 146, 190], 3: [190, 98, 98],
  4: [186, 176, 92], 5: [110, 165, 110], 6: [92, 162, 152],
  7: [96, 116, 184], 8: [134, 112, 184], 9: [172, 102, 152],
};
const MONO_WEIGHTS = [
  [0.299, 0.587, 0.114],
  [0.420, 0.520, 0.060],
  [0.520, 0.440, 0.040],
  [0.620, 0.340, 0.040],
  [0.220, 0.680, 0.100],
];

// Rough emulation of the in-camera base picture controls (preview only; the
// real TRCs live in camera firmware and are not published).
const BASE_LOOKS = {
  Standard:  { pts: [[0, 0], [48, 41], [128, 133], [208, 218], [255, 255]], sat: 1.08 },
  Vivid:     { pts: [[0, 0], [42, 30], [128, 136], [210, 227], [255, 255]], sat: 1.22 },
  Portrait:  { pts: [[0, 0], [52, 48], [128, 131], [212, 219], [255, 255]], sat: 1.02 },
  Landscape: { pts: [[0, 0], [45, 36], [128, 133], [209, 221], [255, 255]], sat: 1.14 },
};

// ---------------------------------------------------------------- curve math

function naturalSpline(pts) {
  const n = pts.length - 1;
  if (n < 1) return () => pts.length ? pts[0][1] : 0;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const h = [];
  for (let i = 0; i < n; i++) h[i] = xs[i + 1] - xs[i] || 1e-6;
  const m = new Array(n + 1).fill(0);
  if (n > 1) {
    const cp = [], dp = [];
    for (let i = 1; i < n; i++) {
      const a = h[i - 1], b = 2 * (h[i - 1] + h[i]), c = h[i];
      const d = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1]);
      const denom = b - (i > 1 ? a * cp[i - 1] : 0);
      cp[i] = c / denom;
      dp[i] = (d - (i > 1 ? a * dp[i - 1] : 0)) / denom;
    }
    for (let i = n - 1; i >= 1; i--) m[i] = dp[i] - (i < n - 1 ? cp[i] * m[i + 1] : 0);
  }
  return x => {
    let k = 0;
    while (k < n - 1 && x > xs[k + 1]) k++;
    const t = x - xs[k];
    const A = (m[k + 1] - m[k]) / (6 * h[k]);
    const B = m[k] / 2;
    const C = (ys[k + 1] - ys[k]) / h[k] - h[k] * (2 * m[k] + m[k + 1]) / 6;
    return ((A * t + B) * t + C) * t + ys[k];
  };
}

function buildLUT(c) {
  const lut = new Float64Array(256);
  const pts = c.points.slice().sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  const inRange = (c.maxInput - c.minInput) / 255 || 1e-6;
  const outRange = (c.maxOutput - c.minOutput) / 255 || 1e-6;
  const sp = pts.map(p => [p[0] * inRange + c.minInput, p[1] * outRange + c.minOutput]);
  for (let i = 1; i < sp.length; i++) if (sp[i][0] <= sp[i - 1][0]) sp[i][0] = sp[i - 1][0] + 1e-3;
  const f = naturalSpline(sp);
  const x0 = sp[0][0], xN = sp[sp.length - 1][0];
  const y0 = sp[0][1], yN = sp[sp.length - 1][1];
  const g = Number(c.gamma) || 1;
  const diffIn = (xN - x0) || 1e-6;
  const diffOut = c.maxOutput - c.minOutput;
  for (let x = 0; x < 256; x++) {
    let y;
    if (x <= x0) y = y0;
    else if (x >= xN) y = yN;
    else y = f(x);
    if (g !== 1 && x > x0 && x < xN) {
      const t = clamp((x - x0) / diffIn, 0, 1);
      y += (Math.pow(t, 1 / g) - t) * diffOut;
    }
    lut[x] = clamp(y, Math.max(0, c.minOutput), Math.min(255, c.maxOutput));
  }
  return lut;
}

// Reduce a 256-entry LUT (0..32767) to <= maxPts curve points (0..255) via
// Douglas-Peucker, so imported NP3 curves become editable again.
function simplifyLut(lut, maxPts = MAX_POINTS, tolerance = 1.2) {
  const ys = [];
  for (let i = 0; i < 256; i++) ys.push(lut[i] * 255 / 32767);
  const keep = new Array(256).fill(false);
  keep[0] = keep[255] = true;
  // split the worst segment repeatedly until tolerance met or point budget spent
  const pending = [[0, 255]];
  let count = 2;
  while (count < maxPts) {
    let bestSeg = -1, bestD = tolerance, bestI = -1;
    for (let s = 0; s < pending.length; s++) {
      const [a, b] = pending[s];
      if (b - a < 2) continue;
      const dy = ys[b] - ys[a], dx = b - a;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(ys[i] - (ys[a] + dy * (i - a) / dx));
        if (d > bestD) { bestD = d; bestSeg = s; bestI = i; }
      }
    }
    if (bestSeg < 0) break;
    const [a, b] = pending[bestSeg];
    keep[bestI] = true;
    count++;
    pending.splice(bestSeg, 1, [a, bestI], [bestI, b]);
  }
  const pts = [];
  for (let i = 0; i < 256; i++) if (keep[i]) pts.push([i, Math.round(clamp(ys[i], 0, 255))]);
  return pts;
}

// ---------------------------------------------------------------- pipeline

function colorMatrix(satFactor, hueSteps) {
  const s = clamp(satFactor, 0, 3);
  const lr = 0.213, lg = 0.715, lb = 0.072;
  const S = [
    lr + (1 - lr) * s, lg * (1 - s),      lb * (1 - s),
    lr * (1 - s),      lg + (1 - lg) * s, lb * (1 - s),
    lr * (1 - s),      lg * (1 - s),      lb + (1 - lb) * s,
  ];
  const a = hueSteps * 6 * Math.PI / 180;
  const c = Math.cos(a), n = Math.sin(a);
  const H = [
    lr + c * (1 - lr) - n * lr,  lg - c * lg - n * lg,          lb - c * lb + n * (1 - lb),
    lr - c * lr + n * 0.143,     lg + c * (1 - lg) + n * 0.140, lb - c * lb - n * 0.283,
    lr - c * lr - n * (1 - lr),  lg - c * lg + n * lg,          lb + c * (1 - lb) + n * lb,
  ];
  const M = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let col = 0; col < 3; col++)
      M[r * 3 + col] = H[r * 3] * S[col] + H[r * 3 + 1] * S[3 + col] + H[r * 3 + 2] * S[6 + col];
  return M;
}

// One combined per-channel LUT: base look -> custom curve (or contrast/brightness).
function buildChannelLUT(s) {
  const look = BASE_LOOKS[s.base];
  let baseLut = null;
  if (look) {
    const f = naturalSpline(look.pts);
    baseLut = new Float64Array(256);
    for (let i = 0; i < 256; i++) baseLut[i] = clamp(f(i), 0, 255);
  }
  let main = null;
  if (s.customCurve) {
    main = buildLUT(s.curve);
  } else {
    const con = s.autoContrast ? 0 : (s.contrast || 0);
    const bri = s.brightness || 0;
    if (con || bri) {
      main = new Float64Array(256);
      const f = 1 + con * 0.15, off = bri * 20;
      for (let i = 0; i < 256; i++) main[i] = clamp((i - 128) * f + 128 + off, 0, 255);
    }
  }
  if (!baseLut && !main) return null;
  const out = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const b = baseLut ? baseLut[i] : i;
    out[i] = Math.round(main ? interpLut(main, b) : b);
  }
  return out;
}

function interpLut(lut, x) {
  const i = Math.floor(x);
  if (i >= 255) return lut[255];
  return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
}

// separable box blur (returns new array, RGB only)
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const size = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1) * 4 + ch];
      for (let x = 0; x < w; x++) {
        tmp[row + x * 4 + ch] = acc / size;
        const add = clamp(x + r + 1, 0, w - 1), sub = clamp(x - r, 0, w - 1);
        acc += src[row + add * 4 + ch] - src[row + sub * 4 + ch];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[(clamp(y, 0, h - 1) * w + x) * 4 + ch];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + ch] = acc / size;
        const add = (clamp(y + r + 1, 0, h - 1) * w + x) * 4 + ch;
        const sub = (clamp(y - r, 0, h - 1) * w + x) * 4 + ch;
        acc += tmp[add] - tmp[sub];
      }
    }
  }
  return out;
}

function unsharp(d, w, h, r, amount) {
  const blur = boxBlur(d, w, h, r);
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = clamp(d[i]     + amount * (d[i]     - blur[i]), 0, 255);
    d[i + 1] = clamp(d[i + 1] + amount * (d[i + 1] - blur[i + 1]), 0, 255);
    d[i + 2] = clamp(d[i + 2] + amount * (d[i + 2] - blur[i + 2]), 0, 255);
  }
}

// s: plain settings object (see app state). Mutates d in place.
function processImageData(d, w, h, s) {
  const mono = s.base === 'Monochrome';
  const lut = buildChannelLUT(s);
  if (lut) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
  }

  if (mono) {
    const wts = MONO_WEIGHTS[s.filterEffect] || MONO_WEIGHTS[0];
    const tone = s.toningType > 0 ? TONE_COLORS[s.toningType] : null;
    const a = tone ? clamp((s.toning == null ? 4 : s.toning) / 7, 0, 1) : 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = clamp(Math.round(wts[0] * d[i] + wts[1] * d[i + 1] + wts[2] * d[i + 2]), 0, 255);
      let r = g, gr = g, b = g;
      if (a > 0) {
        for (let ch = 0; ch < 3; ch++) {
          const t = tone[ch];
          const duo = g <= 128 ? t * g / 128 : t + (255 - t) * (g - 128) / 127;
          const v = g + (duo - g) * a;
          if (ch === 0) r = v; else if (ch === 1) gr = v; else b = v;
        }
      }
      d[i] = r; d[i + 1] = gr; d[i + 2] = b;
    }
  } else {
    const look = BASE_LOOKS[s.base];
    const baseSat = look ? look.sat : 1;
    const sat = (s.autoSaturation ? 0 : (s.saturation || 0));
    const satFactor = baseSat * (1 + sat * 0.25);
    if (Math.abs(satFactor - 1) > 1e-3 || s.hue) {
      const M = colorMatrix(satFactor, s.hue || 0);
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i]     = clamp(M[0] * r + M[1] * g + M[2] * b, 0, 255);
        d[i + 1] = clamp(M[3] * r + M[4] * g + M[5] * b, 0, 255);
        d[i + 2] = clamp(M[6] * r + M[7] * g + M[8] * b, 0, 255);
      }
    }
  }

  const clarity = s.clarity || 0;
  if (clarity) unsharp(d, w, h, Math.max(6, Math.round(Math.min(w, h) / 60)), clarity * 0.12);
  const mid = s.midSharp || 0;
  if (mid) unsharp(d, w, h, 3, mid * 0.25);
  const sharp = s.autoSharpening ? 3 : (s.sharpening || 0);
  if (sharp > 0) unsharp(d, w, h, 1, sharp * 0.3);
}

// ---------------------------------------------------------------- NCP codec

function pushU32(a, v) { a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function pushU16(a, v) { a.push((v >> 8) & 255, v & 255); }
function pushStr(a, s, len) { for (let i = 0; i < len; i++) a.push(i < s.length ? s.charCodeAt(i) & 0x7F : 0); }

function curveRecordBody(s, withPoints) {
  const a = [];
  a.push(0x49);
  a.push((s.reserved02 || '0').charCodeAt(0));
  const c = s.curve;
  if (withPoints) {
    a.push(clamp(Math.round(c.minInput), 0, 255), clamp(Math.round(c.maxInput), 0, 255));
    a.push(clamp(Math.round(c.minOutput), 0, 255), clamp(Math.round(c.maxOutput), 0, 255));
    const g = Number(c.gamma) || 1;
    a.push(clamp(Math.floor(g), 0, 9), clamp(Math.round((g - Math.floor(g)) * 100), 0, 99));
    const pts = c.points.slice().sort((x, y) => x[0] - y[0]).slice(0, MAX_POINTS);
    a.push(pts.length);
    for (let i = 0; i < 57; i++) {
      const p = pts[Math.floor(i / 2)];
      a.push(Math.floor(i / 2) < pts.length ? clamp(Math.round(p[i % 2]), 0, 255) : 0);
    }
  } else {
    // NP3 fixture layout: fixed header, no stored points
    a.push(0x00, 0xFF, 0x00, 0xFF, 0x01, 0x00, 0x00);
    for (let i = 0; i < 57; i++) a.push(0);
  }
  const lut = buildLUT(s.curve);
  for (let i = 0; i < 256; i++) pushU16(a, Math.round(lut[i] * 32767 / 255));
  return a;
}

function encodeNCP(s) {
  const a = [];
  const mono = s.base === 'Monochrome';
  pushStr(a, 'NCP\0', 4);
  pushU32(a, 1); pushU32(a, 36);
  pushStr(a, '0100', 4);
  pushStr(a, String(s.name || '').slice(0, 19), 20);
  pushU16(a, BASE_ENUM[s.base] || BASE_ENUM.Neutral);
  a.push(2, 0xFF);
  a.push(s.autoSharpening ? 0x00 : clamp(Math.round(s.sharpening), 0, 9) + 0x80);
  a.push(s.customCurve ? 0x01 : s.autoContrast ? 0x00 : clamp(Math.round(s.contrast), -3, 3) + 0x80);
  a.push(s.customCurve ? 0x01 : clamp(Math.round(s.brightness), -1, 1) + 0x80);
  a.push(mono ? 0xFF : s.autoSaturation ? 0x00 : clamp(Math.round(s.saturation), -3, 3) + 0x80);
  a.push(mono ? 0xFF : clamp(Math.round(s.hue), -3, 3) + 0x80);
  a.push(mono ? clamp(s.filterEffect, 0, 4) + 0x80 : 0xFF);
  a.push(mono ? clamp(s.toningType, 0, 9) + 0x80 : 0xFF);
  a.push(mono && s.toningType > 0 && s.toning != null
    ? clamp(Math.round(s.toning), 0, 7) + 0x80 : 0xFF);
  if (s.customCurve) {
    pushU32(a, 2); pushU32(a, 578);
    curveRecordBody(s, true).forEach(b => a.push(b));
  }
  pushU32(a, 0);
  return new Uint8Array(a);
}

// ---------------------------------------------------------------- NP3 codec

function tagged(a, id, data) {
  pushU32(a, id); pushU32(a, data.length);
  data.forEach(b => a.push(b));
}
// quarter-step value (type 0x04), as in Nikon-generated NP3 files
const np3Q = (v, lo, hi) => [clamp(Math.round(v * 4), lo * 4, hi * 4) + 0x80, 0x04];
const np3Auto = [0x00, 0x04], np3Curve = [0x01, 0x04];

function encodeNP3(s, version) {
  version = version === '0300' ? '0300' : '0310';
  const a = [];
  const mono = s.base === 'Monochrome';
  pushStr(a, 'NCP\0', 4);
  const verBytes = []; pushStr(verBytes, version, 4);
  tagged(a, 0x0100, verBytes);
  const nameBytes = []; pushStr(nameBytes, String(s.name || '').slice(0, 19), 20);
  tagged(a, 0x0200, nameBytes);
  const base = BASE_ENUM[s.base] || BASE_ENUM.Neutral;
  tagged(a, 0x0300, [(base >> 8) & 255, base & 255]);
  tagged(a, 0x0400, [0x00, 0x00]);           // adjustment type
  tagged(a, 0x0500, [0xFF, 0x01]);           // quick sliders: individual values
  tagged(a, 0x0600, s.autoSharpening ? np3Auto : np3Q(s.sharpening, -3, 9));
  tagged(a, 0x0700, np3Q(s.clarity || 0, -5, 5));
  tagged(a, 0x0800, s.customCurve ? np3Curve : (s.autoContrast ? np3Auto : np3Q(s.contrast, -3, 3)));
  tagged(a, 0x0900, s.customCurve ? np3Curve : np3Q(s.brightness, -1.5, 1.5));
  tagged(a, 0x0A00, mono ? [0xFF, 0x04] : (s.autoSaturation ? np3Auto : np3Q(s.saturation, -3, 3)));
  tagged(a, 0x0B00, mono ? [0xFF, 0x04] : np3Q(s.hue, -3, 3));
  tagged(a, 0x0C00, mono ? [clamp(s.filterEffect, 0, 4) + 0x80, 0x00] : [0xFF, 0x00]);
  tagged(a, 0x0D00, mono ? [clamp(s.toningType, 0, 9) + 0x80, 0x00] : [0xFF, 0x00]);
  tagged(a, 0x0E00, mono && s.toningType > 0 && s.toning != null
    ? np3Q(s.toning, 0, 7) : [0xFF, 0x04]);
  for (let id = 0x0F00; id <= 0x1400; id += 0x0100) tagged(a, id, [0xFF, 0x01]);
  tagged(a, 0x1500, [0xFF, 0x0A]);
  tagged(a, 0x1600, np3Q(s.midSharp || 0, -3, 3));
  if (version === '0310') {
    tagged(a, 0x1700, [0xFF, 0x04]);         // highlight (not exposed)
    tagged(a, 0x1800, [0xFF, 0x04]);         // shadow (not exposed)
    for (let id = 0x1900; id <= 0x1E00; id += 0x0100) tagged(a, id, [0x80, 0x01]);
    tagged(a, 0x1F00, [                      // color blender: all hues neutral
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
      0x01, 0x01, 0x01, 0x00,
    ]);
    tagged(a, 0x2000, [                      // color grading: neutral
      0x80, 0x00, 0x80, 0x80, 0x80, 0x00, 0x80, 0x80, 0x80, 0x00, 0x80, 0x80,
      0x01, 0x01, 0x01, 0x00, 0xB2, 0x01, 0x80, 0x01,
    ]);
  }
  if (s.customCurve) {
    pushU32(a, 2); pushU32(a, 578);
    curveRecordBody(s, false).forEach(b => a.push(b));
  }
  pushU32(a, 0);
  return new Uint8Array(a);
}

// ---------------------------------------------------------------- decoder

function readU32(b, o) {
  return (((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
}

function decodeByte(byte, opts = {}) {
  const x = byte - 0x80;
  if (x === 127) return null;
  if (byte === 0x00 && opts.auto) return 'auto';
  if (byte === 0x01 && opts.curve) return 'curve';
  return x;
}

function decodeNP3Value(rec, quarter = true, opts = {}) {
  if (!rec || rec.data.length < 2) return null;
  const b = rec.data[0];
  if (b === 0x00) return opts.auto ? 'auto' : null;
  if (b === 0x01) return opts.curve ? 'curve' : null;
  if (b === 0xFF) return null;
  return quarter ? (b - 0x80) / 4 : b - 0x80;
}

// Accepts NCP / NP2 / NP3 buffers. Returns a normalized settings object.
function decodePictureControl(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sig = String.fromCharCode(b[0], b[1], b[2]);
  if (!['NCP', 'NP2', 'NP3'].includes(sig) || b[3] !== 0) {
    throw new Error('unsupported signature (expected NCP, NP2 or NP3)');
  }
  const records = [];
  let o = 4, terminated = false;
  while (o + 4 <= b.length) {
    const id = readU32(b, o); o += 4;
    if (id === 0) { terminated = true; break; }
    if (o + 4 > b.length) throw new Error('truncated record header');
    const size = readU32(b, o); o += 4;
    if (size > b.length - o) throw new Error('record extends beyond file');
    records.push({ id, size, data: b.slice(o, o + size) });
    o += size;
    if (records.length > 64) throw new Error('too many records');
  }
  if (!terminated) throw new Error('missing terminator');

  const byId = new Map(records.map(r => [r.id, r]));
  const verRec = byId.get(0x0100);
  const taggedVersion = verRec ? String.fromCharCode(...verRec.data.slice(0, 4)) : '';
  const isNP3 = /^03(00|01|02|10)$/.test(taggedVersion);

  const out = {
    format: isNP3 ? 'NP3' : sig,
    version: taggedVersion || undefined,
    customCurve: false,
    curve: { points: [[0, 0], [255, 255]], gamma: 1, minInput: 0, maxInput: 255, minOutput: 0, maxOutput: 255 },
    clarity: 0, midSharp: 0,
  };

  const curveRec = byId.get(2);
  if (curveRec && curveRec.size >= 578) {
    out.customCurve = true;
    out.reserved02 = String.fromCharCode(curveRec.data[1] || 0x30);
    const numPoints = curveRec.data[8];
    if (numPoints >= 2 && numPoints <= 28) {
      const c = out.curve;
      c.minInput = curveRec.data[2]; c.maxInput = curveRec.data[3];
      c.minOutput = curveRec.data[4]; c.maxOutput = curveRec.data[5];
      c.gamma = Math.round((curveRec.data[6] + curveRec.data[7] / 100) * 100) / 100 || 1;
      c.points = [];
      for (let i = 0; i < Math.min(numPoints, MAX_POINTS); i++) {
        c.points.push([curveRec.data[9 + i * 2], curveRec.data[10 + i * 2]]);
      }
    } else {
      // LUT-only curve (NP3): reconstruct editable points
      const lut = [];
      for (let i = 0; i < 256; i++) lut.push((curveRec.data[66 + i * 2] << 8) | curveRec.data[67 + i * 2]);
      out.curve.points = simplifyLut(lut);
    }
  }

  if (!isNP3) {
    const rec1 = byId.get(1);
    if (!rec1 || rec1.size < 36) throw new Error(sig + ' settings record missing');
    const d = rec1.data;
    let name = '';
    for (let i = 4; i < 24 && d[i]; i++) name += String.fromCharCode(d[i]);
    out.name = name;
    out.base = ENUM_BASE[(d[24] << 8) | d[25]] || 'Neutral';
    out.sharpening = decodeByte(d[28], { auto: true });
    out.contrast = decodeByte(d[29], { auto: true, curve: true });
    out.brightness = decodeByte(d[30], { curve: true });
    out.saturation = decodeByte(d[31], { auto: true });
    out.hue = decodeByte(d[32], {});
    out.filterEffect = decodeByte(d[33], {});
    out.toningType = decodeByte(d[34], {});
    out.toning = decodeByte(d[35], {});
  } else {
    const nameRec = byId.get(0x0200);
    let name = '';
    if (nameRec) for (let i = 0; i < nameRec.data.length && nameRec.data[i]; i++) name += String.fromCharCode(nameRec.data[i]);
    out.name = name;
    const baseRec = byId.get(0x0300);
    out.base = baseRec ? (ENUM_BASE[(baseRec.data[0] << 8) | baseRec.data[1]] || 'Neutral') : 'Neutral';
    out.sharpening = decodeNP3Value(byId.get(0x0600), true, { auto: true });
    out.clarity = decodeNP3Value(byId.get(0x0700)) || 0;
    out.contrast = decodeNP3Value(byId.get(0x0800), true, { auto: true, curve: true });
    out.brightness = decodeNP3Value(byId.get(0x0900), true, { curve: true });
    out.saturation = decodeNP3Value(byId.get(0x0A00), true, { auto: true });
    out.hue = decodeNP3Value(byId.get(0x0B00));
    out.filterEffect = decodeNP3Value(byId.get(0x0C00), false);
    out.toningType = decodeNP3Value(byId.get(0x0D00), false);
    out.toning = decodeNP3Value(byId.get(0x0E00));
    out.midSharp = decodeNP3Value(byId.get(0x1600)) || 0;
  }
  return out;
}

// ---------------------------------------------------------------- NEF preview

// Extract the largest embedded JPEG preview from a NEF (TIFF container).
function extractNefJpeg(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16) throw new Error('file too small');
  let le;
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) le = true;
  else if (b[0] === 0x4D && b[1] === 0x4D && b[3] === 0x2A) le = false;
  else throw new Error('not a TIFF/NEF file');
  const u16 = o => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
  const u32 = o => le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
    : ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

  const candidates = [];
  const visited = new Set();
  const walk = (off, depth) => {
    if (depth > 6 || visited.has(off) || off <= 0 || off + 2 > b.length) return;
    visited.add(off);
    const n = u16(off);
    if (n > 512) return;
    let jpegOff = 0, jpegLen = 0;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > b.length) return;
      const tag = u16(e), count = u32(e + 4), val = u32(e + 8);
      if (tag === 0x0201) jpegOff = val;
      else if (tag === 0x0202) jpegLen = val;
      else if (tag === 0x014A) { // SubIFDs
        if (count === 1) walk(val, depth + 1);
        else for (let k = 0; k < Math.min(count, 8); k++) walk(u32(val + k * 4), depth + 1);
      }
    }
    if (jpegOff > 0 && jpegLen > 1000 && jpegOff + jpegLen <= b.length
        && b[jpegOff] === 0xFF && b[jpegOff + 1] === 0xD8) {
      candidates.push({ off: jpegOff, len: jpegLen });
    }
    const next = u32(off + 2 + n * 12);
    if (next) walk(next, depth + 1);
  };
  walk(u32(4), 0);
  if (!candidates.length) throw new Error('no embedded JPEG preview found');
  candidates.sort((a, c) => c.len - a.len);
  const best = candidates[0];
  return b.slice(best.off, best.off + best.len);
}

return {
  clamp, BASE_ENUM, ENUM_BASE, MAX_POINTS, TONE_COLORS, MONO_WEIGHTS, BASE_LOOKS,
  naturalSpline, buildLUT, simplifyLut, colorMatrix, buildChannelLUT,
  processImageData, unsharp, boxBlur,
  encodeNCP, encodeNP3, decodePictureControl, extractNefJpeg,
};
});
