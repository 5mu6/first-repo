'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SF = Object.assign({}, require('../js/sizefit-core.js'), require('../js/sizefit-render.js'));

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const ME = { height: 178, weight: 75, chest: 100, waist: 84, hip: 100, shoulder: 46, armLength: 61, inseam: 81, footLength: 26 };
const val = (chart, size, key) => {
  const s = chart.sizes.find((x) => x.label === size);
  return s && s.values[key] ? SF.round1(s.values[key].min) : undefined;
};

test('header-row table (sizes in rows)', () => {
  const { chart, type } = SF.analyze(fx('tee-rows.txt'), ME);
  assert.equal(type, 'tee');
  assert.deepEqual(chart.sizes.map((s) => s.label), ['S', 'M', 'L', 'XL', '2XL']);
  assert.equal(val(chart, '2XL', 'chest'), 116);
  assert.equal(val(chart, 'M', 'sleeve'), 20);
});

test('transposed table with 平铺 chest is doubled', () => {
  const { chart } = SF.analyze(fx('hoodie-flat-columns.txt'), ME);
  assert.deepEqual(chart.sizes.map((s) => s.label), ['M', 'L', 'XL', '2XL']);
  assert.equal(val(chart, 'M', 'chest'), 116);
  assert.ok(chart.doubled.includes('chest'));
});

test('inline per-size text with Chinese 尺/寸 waist', () => {
  const { chart, type } = SF.analyze(fx('jeans-inline.txt'), ME);
  assert.equal(type, 'pants');
  assert.equal(val(chart, '28', 'waist'), 70); // 2尺1 = 21 市寸 = 70 cm
  assert.equal(val(chart, '32', 'outseam'), 104);
});

test('height / weight only chart converts 斤 to kg', () => {
  const r = SF.analyze(fx('height-weight.txt'), ME);
  assert.equal(val(r.chart, 'L', 'weight'), 60);
  assert.equal(r.result.best.label, 'XL');
});

test('English flat-lay pants are detected as half measurements', () => {
  const { chart, type } = SF.analyze(fx('pants-english-flat.txt'), ME);
  assert.equal(type, 'pants');
  assert.equal(val(chart, 'M', 'waist'), 72);
  assert.equal(val(chart, 'M', 'outseam'), 100); // "Length" becomes pant length, not doubled
});

test('shoes: foot length in mm', () => {
  const r = SF.analyze(fx('shoes.txt'), ME);
  assert.equal(r.type, 'shoes');
  assert.equal(r.result.best.label, '43');
});

test('OCR noise: spaced CJK, 围 misread, split digits, "X L"', () => {
  const { chart, parsed } = SF.analyze(fx('ocr-noisy.txt'), ME);
  assert.deepEqual(chart.sizes.map((s) => s.label), ['S', 'M', 'L', 'XL']);
  assert.equal(val(chart, 'S', 'chest'), 100);
  assert.equal(val(chart, 'S', 'sleeve'), 19);
  assert.ok(parsed.warnings.some((w) => /repaired/.test(w)));
});

test('unreadable header: columns guessed from values', () => {
  const text = 'M 68 112 50 21 100-120\nL 70 116 52 22 120-140\nXL 72 120 54 23 140-160\n2XL 74 124 56 24 160-180';
  const { chart, parsed } = SF.analyze(text, ME);
  assert.ok(parsed.guessed);
  assert.equal(val(chart, 'L', 'chest'), 116);
  assert.equal(val(chart, 'L', 'shoulder'), 52);
  assert.equal(val(chart, 'L', 'weight'), 60);
});

test('one size and per-measurement inline formats', () => {
  assert.equal(SF.analyze(fx('one-size.txt'), ME).chart.sizes[0].label, 'One size');
  const { chart } = SF.analyze(fx('per-measure-inline.txt'), ME);
  assert.deepEqual(chart.sizes.map((s) => s.label), ['S', 'M', 'L', 'XL']);
});

test('elastic waist range is treated as stretch', () => {
  const r = SF.analyze(fx('elastic-joggers.txt'), ME);
  const w = r.result.best.items.find((i) => i.key === 'waist');
  assert.equal(w.kind, 'elastic');
  assert.equal(w.status, 'ok');
});

test('fit engine: bigger body picks a bigger size', () => {
  const small = SF.analyze(fx('tee-rows.txt'), Object.assign({}, ME, { chest: 90, shoulder: 43 })).result.best.label;
  const big = SF.analyze(fx('tee-rows.txt'), Object.assign({}, ME, { chest: 106, shoulder: 48 })).result.best.label;
  assert.equal(small, 'S'); // +10 cm chest ease, regular fit
  assert.equal(big, '2XL');
});

test('fit preference shifts the pick', () => {
  const slim = SF.analyze(fx('tee-rows.txt'), Object.assign({}, ME, { fitTop: 'slim' })).result.best.label;
  const over = SF.analyze(fx('tee-rows.txt'), Object.assign({}, ME, { fitTop: 'oversized' })).result.best.label;
  assert.equal(slim, 'L');
  assert.equal(over, '2XL');
});

test('renderer produces an SVG for every fixture', () => {
  for (const f of fs.readdirSync(path.join(__dirname, 'fixtures'))) {
    const r = SF.analyze(fx(f), ME);
    for (const e of r.result.evals) {
      const svg = SF.renderFit(r.result, r.chart, e.label, { units: 'in' });
      assert.match(svg, /^<svg[\s\S]*<\/svg>$/, f);
      assert.doesNotMatch(svg, /NaN|undefined/, f + ' ' + e.label);
    }
  }
});
