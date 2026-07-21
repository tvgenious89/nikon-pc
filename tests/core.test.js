// Node unit tests for assets/js/core.js — run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../assets/js/core.js');

const FIXTURES = path.join(__dirname, 'fixtures');

const neutralState = (over = {}) => Object.assign({
  name: 'TEST', base: 'Neutral', reserved02: '0',
  customCurve: false,
  sharpening: 3, autoSharpening: false,
  contrast: 0, autoContrast: false,
  brightness: 0,
  saturation: 0, autoSaturation: false,
  hue: 0, filterEffect: 0, toningType: 0, toning: 4,
  clarity: 0, midSharp: 0,
  curve: { points: [[0, 0], [255, 255]], gamma: 1, minInput: 0, maxInput: 255, minOutput: 0, maxOutput: 255 },
}, over);

test('identity curve LUT is identity', () => {
  const lut = core.buildLUT(neutralState().curve);
  for (const i of [0, 1, 64, 128, 200, 255]) {
    assert.ok(Math.abs(lut[i] - i) < 0.6, `lut[${i}] = ${lut[i]}`);
  }
});

test('spline passes through its points', () => {
  const curve = {
    points: [[0, 0], [64, 40], [128, 140], [192, 210], [255, 255]],
    gamma: 1, minInput: 0, maxInput: 255, minOutput: 0, maxOutput: 255,
  };
  const lut = core.buildLUT(curve);
  for (const [x, y] of curve.points) {
    assert.ok(Math.abs(lut[x] - y) < 1, `lut[${x}] = ${lut[x]}, want ~${y}`);
  }
});

test('gamma lifts midtones, endpoints fixed', () => {
  const curve = neutralState().curve;
  curve.gamma = 1.5;
  const lut = core.buildLUT(curve);
  assert.equal(Math.round(lut[0]), 0);
  assert.equal(Math.round(lut[255]), 255);
  assert.ok(lut[128] > 145, `midtone ${lut[128]}`);
});

test('levels ranges clamp output', () => {
  const curve = { points: [[0, 0], [255, 255]], gamma: 1, minInput: 0, maxInput: 255, minOutput: 20, maxOutput: 235 };
  const lut = core.buildLUT(curve);
  assert.ok(lut[0] >= 20 && lut[255] <= 235);
});

test('NCP encode: structure and golden fields', () => {
  const s = neutralState({
    name: 'BeatLogII MaxDR', customCurve: true, sharpening: 0, saturation: -1,
    curve: {
      points: [[0, 0], [2, 19], [5, 31], [9, 39], [17, 47], [32, 58], [62, 79],
               [128, 118], [192, 165], [229, 200], [247, 229], [255, 255]],
      gamma: 1.18, minInput: 0, maxInput: 255, minOutput: 0, maxOutput: 255,
    },
  });
  const b = core.encodeNCP(s);
  assert.equal(b.length, 638);
  assert.deepEqual([...b.slice(0, 4)], [0x4E, 0x43, 0x50, 0x00]);
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(4), 1);
  assert.equal(dv.getUint32(8), 36);
  assert.equal(dv.getUint16(36), 0x03C2);               // Neutral
  assert.deepEqual([...b.slice(40, 48)], [0x80, 0x01, 0x01, 0x7F, 0x80, 0xFF, 0xFF, 0xFF]);
  assert.deepEqual([...b.slice(56, 65)], [0x49, 0x30, 0, 255, 0, 255, 1, 18, 12]); // levels, gamma 1.18, 12 pts
  assert.equal(dv.getUint16(122 + 255 * 2), 32767);      // LUT ends at max
  assert.equal(dv.getUint32(634), 0);                    // terminator
});

test('NCP round-trip', () => {
  const s = neutralState({
    name: 'RT', base: 'Monochrome', customCurve: true, sharpening: 5,
    filterEffect: 2, toningType: 1, toning: 6,
    curve: { points: [[0, 10], [90, 80], [255, 250]], gamma: 1.3, minInput: 5, maxInput: 250, minOutput: 3, maxOutput: 240 },
  });
  const d = core.decodePictureControl(core.encodeNCP(s));
  assert.equal(d.format, 'NCP');
  assert.equal(d.name, 'RT');
  assert.equal(d.base, 'Monochrome');
  assert.equal(d.sharpening, 5);
  assert.equal(d.contrast, 'curve');
  assert.equal(d.filterEffect, 2);
  assert.equal(d.toningType, 1);
  assert.equal(d.toning, 6);
  assert.equal(d.curve.gamma, 1.3);
  assert.deepEqual(d.curve.points, s.curve.points);
  assert.equal(d.curve.minInput, 5);
  assert.equal(d.curve.maxOutput, 240);
});

test('decode real third-party NCP (Horshack Linear)', () => {
  const b = fs.readFileSync(path.join(FIXTURES, 'Horshack_Linear.NCP'));
  const d = core.decodePictureControl(new Uint8Array(b));
  assert.equal(d.format, 'NCP');
  assert.equal(d.name, 'HS Linear v01');
  assert.equal(d.base, 'Neutral');
  assert.equal(d.sharpening, 2);
  assert.equal(d.contrast, 'curve');
  assert.equal(d.customCurve, true);
  assert.deepEqual(d.curve.points, [[0, 0], [255, 255]]);
});

test('NP3 encode: tagged structure matches spec', () => {
  const s = neutralState({ name: 'ZTEST', customCurve: true, sharpening: 2, clarity: 0.5, midSharp: 1 });
  const b = core.encodeNP3(s, '0310');
  assert.deepEqual([...b.slice(0, 4)], [0x4E, 0x43, 0x50, 0x00]);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // first record: 0x0100 version "0310"
  assert.equal(dv.getUint32(4), 0x0100);
  assert.equal(dv.getUint32(8), 4);
  assert.equal(String.fromCharCode(...b.slice(12, 16)), '0310');
  const d = core.decodePictureControl(b);
  assert.equal(d.format, 'NP3');
  assert.equal(d.name, 'ZTEST');
  assert.equal(d.sharpening, 2);        // quarter-step: 8/4
  assert.equal(d.clarity, 0.5);
  assert.equal(d.midSharp, 1);
  assert.equal(d.contrast, 'curve');
  assert.equal(d.customCurve, true);
});

test('NP3 0300 omits 0310-only records', () => {
  const b300 = core.encodeNP3(neutralState(), '0300');
  const b310 = core.encodeNP3(neutralState(), '0310');
  assert.ok(b310.length > b300.length);
  const d = core.decodePictureControl(b300);
  assert.equal(d.version, '0300');
});

test('decode real Nikon-generated NP3 (ClrMode_Bu_01a)', () => {
  const b = fs.readFileSync(path.join(FIXTURES, 'ClrMode_Bu_01a.NP3'));
  const d = core.decodePictureControl(new Uint8Array(b));
  assert.equal(d.format, 'NP3');
  assert.equal(d.version, '0310');
  assert.equal(d.name, 'ClrMode_Bu_01a');
  assert.equal(d.sharpening, 2);        // 0x88 -> 8 quarter-steps
  assert.equal(d.clarity, 0.5);         // 0x82 -> 2 quarter-steps
  assert.equal(d.midSharp, 1);          // 0x84 -> 4 quarter-steps
});

test('NP3 custom curve round-trips via LUT simplification', () => {
  const s = neutralState({
    customCurve: true,
    curve: {
      points: [[0, 12], [60, 45], [128, 150], [200, 225], [255, 245]],
      gamma: 1, minInput: 0, maxInput: 255, minOutput: 0, maxOutput: 255,
    },
  });
  const want = core.buildLUT(s.curve);
  const d = core.decodePictureControl(core.encodeNP3(s, '0310'));
  assert.ok(d.customCurve);
  assert.ok(d.curve.points.length >= 3 && d.curve.points.length <= 20);
  const got = core.buildLUT(d.curve);
  let worst = 0;
  for (let i = 0; i < 256; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  assert.ok(worst < 6, `reconstructed curve deviates by ${worst}`);
});

test('simplifyLut on identity gives endpoints', () => {
  const lut = [];
  for (let i = 0; i < 256; i++) lut.push(Math.round(i * 32767 / 255));
  const pts = core.simplifyLut(lut);
  assert.equal(pts[0][0], 0);
  assert.equal(pts[pts.length - 1][0], 255);
  assert.ok(pts.length <= 4, `got ${pts.length} points`);
});

test('processImageData: identity settings leave pixels unchanged', () => {
  const w = 4, h = 4;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = 10 + i; d[i + 1] = 100; d[i + 2] = 200; d[i + 3] = 255; }
  const before = [...d];
  core.processImageData(d, w, h, neutralState({ sharpening: 0 }));
  assert.deepEqual([...d], before);
});

test('processImageData: monochrome removes color', () => {
  const w = 2, h = 2;
  const d = new Uint8ClampedArray([200, 30, 40, 255, 10, 240, 50, 255, 1, 2, 3, 255, 250, 250, 0, 255]);
  core.processImageData(d, w, h, neutralState({ base: 'Monochrome', sharpening: 0, toningType: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    assert.equal(d[i], d[i + 1]);
    assert.equal(d[i + 1], d[i + 2]);
  }
});

test('base look emulation changes preview but not Neutral', () => {
  const mk = () => new Uint8ClampedArray([100, 120, 90, 255]);
  const dN = mk(), dV = mk();
  core.processImageData(dN, 1, 1, neutralState({ sharpening: 0 }));
  core.processImageData(dV, 1, 1, neutralState({ sharpening: 0, base: 'Vivid' }));
  assert.deepEqual([...dN], [100, 120, 90, 255]);
  assert.notDeepEqual([...dV], [100, 120, 90, 255]);
});

test('extractNefJpeg finds preview in synthetic NEF', () => {
  // minimal little-endian TIFF: IFD0 with SubIFD -> preview IFD carrying JPEG tags
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, ...new Array(1200).fill(0x11), 0xFF, 0xD9]);
  const buf = new Uint8Array(4096 + jpeg.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 0x2A, 0x00], 0);
  dv.setUint32(4, 8, true);              // IFD0 at 8
  // IFD0: 1 entry (SubIFD tag 0x14A -> offset 64), next = 0
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 0x014A, true); dv.setUint16(12, 4, true);
  dv.setUint32(14, 1, true); dv.setUint32(18, 64, true);
  dv.setUint32(22, 0, true);
  // SubIFD at 64: 2 entries: JPEGInterchangeFormat(0x201)=4096, Length(0x202)
  dv.setUint16(64, 2, true);
  dv.setUint16(66, 0x0201, true); dv.setUint16(68, 4, true);
  dv.setUint32(70, 1, true); dv.setUint32(74, 4096, true);
  dv.setUint16(78, 0x0202, true); dv.setUint16(80, 4, true);
  dv.setUint32(82, 1, true); dv.setUint32(86, jpeg.length, true);
  dv.setUint32(90, 0, true);
  buf.set(jpeg, 4096);
  const got = core.extractNefJpeg(buf);
  assert.equal(got.length, jpeg.length);
  assert.equal(got[0], 0xFF);
  assert.equal(got[1], 0xD8);
});
