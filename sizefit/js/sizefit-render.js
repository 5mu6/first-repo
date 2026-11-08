/*
 * SizeFit renderer: draws a front-view figure built from the user's
 * measurements and dresses it in one size of a garment, as an SVG string.
 *
 * Coordinates are centimetres: x = 0 is the body's centre line, y grows
 * downward from the top of the head (svgY = height − heightFromFloor).
 */
(function (root, factory) {
  const core = (typeof module === 'object' && module.exports) ? require('./sizefit-core.js') : root.SizeFit;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SizeFit = Object.assign(root.SizeFit || {}, api);
})(typeof self !== 'undefined' ? self : this, function (SF) {
  'use strict';

  const STATUS = {
    tight: { color: '#c8372d', mark: '✕', word: 'tight' },
    snug:  { color: '#d98a1c', mark: '!', word: 'snug' },
    ok:    { color: '#23875a', mark: '✓', word: 'good' },
    loose: { color: '#2f6fc0', mark: '↔', word: 'loose' },
    big:   { color: '#6c45b8', mark: '↔', word: 'big' },
    info:  { color: '#6b6b6b', mark: 'i', word: '' },
  };

  const SKIN_TONES = {
    mannequin: ['#e4ddd3', '#a89a8a'],
    light: ['#f3d9c4', '#c39a7d'],
    medium: ['#d9a77f', '#a8764f'],
    tan: ['#b9835a', '#8a5a36'],
    deep: ['#7d5034', '#553220'],
  };

  const GARMENT_COLORS = {
    top: ['#4f7cac', '#2f557f'],
    dress: ['#9a5b8a', '#6c3a60'],
    bottom: ['#3d4f66', '#253244'],
  };

  const f = (n) => (Math.round(n * 100) / 100).toString();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Catmull-Rom spline through points; a point with p[2] === 'c' is a sharp corner.
  function smoothPath(points, closed) {
    const n = points.length;
    if (n < 2) return '';
    const get = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
    let d = 'M' + f(points[0][0]) + ',' + f(points[0][1]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const c1 = p1[2] === 'c' ? p1 : [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = p2[2] === 'c' ? p2 : [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += 'C' + f(c1[0]) + ',' + f(c1[1]) + ' ' + f(c2[0]) + ',' + f(c2[1]) + ' ' + f(p2[0]) + ',' + f(p2[1]);
    }
    return d + (closed ? 'Z' : '');
  }

  // Right-half outline (from centre top, around, back to centre bottom) → full closed outline.
  function mirrorOutline(right) {
    const left = right.slice().reverse().map((p) => [-p[0], p[1], p[2]]);
    return right.concat(left);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------------------------------------------------------------------
  // Body geometry
  // ---------------------------------------------------------------------------
  function bodyGeometry(body) {
    const { p, L, H, fem } = body;
    const Y = (h) => H - h;
    const g = {};
    g.Y = Y;
    g.neckHalf = (p.neck / Math.PI) * 0.55;
    g.shoulderHalf = (p.shoulder * 0.93) / 2;
    g.chestHalf = (p.chest * (fem ? 0.335 : 0.35)) / 2;
    g.waistHalf = (p.waist * (fem ? 0.34 : 0.345)) / 2;
    g.pantWaistHalf = (p.pantWaist * 0.35) / 2;
    g.hipHalf = (p.hip * (fem ? 0.37 : 0.36)) / 2;
    g.thighW = p.thigh * 0.33;
    const outerAtCrotch = g.hipHalf * 0.97;
    g.thighOuter = outerAtCrotch;
    g.thighW = Math.min(g.thighW, outerAtCrotch - 0.4);
    g.thighCenter = outerAtCrotch - g.thighW / 2;
    g.kneeW = p.thigh * 0.65 * 0.33;
    g.calfW = p.thigh * 0.64 * 0.33;
    g.ankleW = p.thigh * 0.4 * 0.33;
    g.kneeCenter = g.thighCenter * 0.82;
    g.ankleCenter = g.thighCenter * 0.78;
    g.bicepW = p.bicep * 0.32;
    g.armAngle = (12 * Math.PI) / 180;
    g.handLen = 0.108 * H;
    g.headRx = 0.044 * H;
    g.headRy = 0.066 * H;
    g.headCy = Y(H - g.headRy);

    // arm axis
    g.armStart = [g.shoulderHalf - g.bicepW * 0.32, Y(L.shoulder) + 1.2];
    g.armDir = [Math.sin(g.armAngle), Math.cos(g.armAngle)];
    g.armNorm = [Math.cos(g.armAngle), -Math.sin(g.armAngle)];
    g.armPoint = (t) => [g.armStart[0] + g.armDir[0] * t, g.armStart[1] + g.armDir[1] * t];
    const arm = p.armLength;
    g.armWidthAt = (t) => {
      const e = arm * 0.55;
      const pts = [[0, g.bicepW * 1.08], [arm * 0.22, g.bicepW], [e, g.bicepW * 0.74], [arm * 0.72, g.bicepW * 0.78], [arm, g.bicepW * 0.56], [arm + g.handLen * 0.45, g.bicepW * 0.72], [arm + g.handLen, g.bicepW * 0.35]];
      if (t <= 0) return pts[0][1];
      for (let i = 0; i < pts.length - 1; i++) {
        if (t <= pts[i + 1][0]) return lerp(pts[i][1], pts[i + 1][1], (t - pts[i][0]) / (pts[i + 1][0] - pts[i][0]));
      }
      return pts[pts.length - 1][1];
    };

    // Half width of the torso / outer leg at a height above the floor.
    g.halfAt = (h) => {
      const lv = [
        [L.armpit, g.chestHalf], [L.chest, g.chestHalf * (fem ? 1.02 : 1)], [L.waist, g.waistHalf],
        [L.pantWaist, Math.max(g.pantWaistHalf, g.waistHalf)], [L.hip, g.hipHalf], [L.crotch, outerAtCrotch],
        [L.crotch - 6, g.thighCenter + g.thighW / 2 * 0.98], [L.knee, g.kneeCenter + g.kneeW / 2], [L.calf, g.kneeCenter * 0.9 + g.calfW / 2],
        [L.ankle, g.ankleCenter + g.ankleW / 2], [0, g.ankleCenter + g.ankleW / 2 + 2],
      ];
      if (h >= lv[0][0]) return g.chestHalf;
      for (let i = 0; i < lv.length - 1; i++) {
        const [h1, w1] = lv[i];
        const [h2, w2] = lv[i + 1];
        if (h <= h1 && h >= h2) return lerp(w1, w2, (h1 - h) / (h1 - h2 || 1));
      }
      return lv[lv.length - 1][1];
    };
    return g;
  }

  function bodyOutline(body, g) {
    const { L, H } = body;
    const Y = g.Y;
    const shoulderMidX = lerp(g.neckHalf, g.shoulderHalf, 0.55);
    const right = [
      [0, Y(L.chin + 2)],
      [g.neckHalf, Y(L.chin + 1)],
      [g.neckHalf * 1.08, Y(L.hps + 1.5)],
      [shoulderMidX, Y(lerp(L.hps, L.shoulder, 0.55))],
      [g.shoulderHalf, Y(L.shoulder - 1)],
      [g.chestHalf + 0.3, Y(L.armpit)],
      [g.halfAt(L.chest), Y(L.chest)],
      [g.waistHalf, Y(L.waist)],
      [g.halfAt(L.pantWaist), Y(L.pantWaist)],
      [g.hipHalf, Y(L.hip)],
      [g.thighOuter, Y(L.crotch)],
      [g.thighCenter + g.thighW / 2 * 0.98, Y(L.crotch - 6)],
      [g.kneeCenter + g.kneeW / 2, Y(L.knee)],
      [g.kneeCenter * 0.9 + g.calfW / 2, Y(L.calf)],
      [g.ankleCenter + g.ankleW / 2, Y(L.ankle)],
      [g.ankleCenter + g.ankleW / 2 + 2.2, Y(1.6)],
      [g.ankleCenter + g.ankleW / 2 + 1.8, Y(0), 'c'],
      [g.ankleCenter - g.ankleW / 2 - 1.2, Y(0), 'c'],
      [g.ankleCenter - g.ankleW / 2 - 0.6, Y(2)],
      [g.ankleCenter - g.ankleW / 2, Y(L.ankle)],
      [g.kneeCenter * 0.95 - g.calfW / 2, Y(L.calf)],
      [g.kneeCenter - g.kneeW / 2, Y(L.knee)],
      [Math.max(0.5, g.thighCenter - g.thighW / 2), Y(L.crotch - 6)],
      [0.4, Y(L.crotch - 0.5), 'c'],
    ];
    return smoothPath(mirrorOutline(right), true);
  }

  function armPath(g, side, tEnd) {
    const n = 9;
    const outer = [], inner = [];
    for (let i = 0; i <= n; i++) {
      const t = lerp(2.5, tEnd, i / n);
      const c = g.armPoint(t);
      const w = g.armWidthAt(t) / 2;
      outer.push([c[0] + g.armNorm[0] * w, c[1] + g.armNorm[1] * w]);
      inner.push([c[0] - g.armNorm[0] * w, c[1] - g.armNorm[1] * w]);
    }
    let pts = outer.concat(inner.reverse());
    if (side < 0) pts = pts.map((q) => [-q[0], q[1], q[2]]);
    return smoothPath(pts, true);
  }

  // ---------------------------------------------------------------------------
  // Garment geometry
  // ---------------------------------------------------------------------------
  const mid = SF.mid;
  const WIDTH_PER_EASE = 0.165; // half-width gained per cm of circumference ease

  function topGeometry(body, g, values, type) {
    const { p, L } = body;
    const Y = g.Y;
    const gv = (k) => mid(values[k]);
    const chestEase = gv('chest') != null ? gv('chest') - p.chest : type === 'tee' ? 10 : 16;
    const cw = g.chestHalf + Math.max(0, chestEase) * WIDTH_PER_EASE + 0.4;
    const gShoulder = gv('shoulder') != null ? gv('shoulder') : p.shoulder + Math.max(0, chestEase) * 0.15;
    const gsh = Math.max((gShoulder * 0.93) / 2, g.neckHalf + 3);
    const drop = Math.max(0, gsh - g.shoulderHalf);
    const seam = [Math.max(gsh, g.neckHalf + 3), Y(L.shoulder) + (gsh < g.shoulderHalf ? -(g.shoulderHalf - gsh) * 0.35 : drop * 0.85) - 0.4];
    const armholeY = Y(L.armpit) + Math.max(0, chestEase) * 0.1 + drop * 0.55;
    const length = gv('length') != null ? gv('length') : 0.4 * body.H;
    const hemH = SF.hemHeightTop(body, length);
    const hemY = Y(hemH);
    // Hem width: given, or a straight drop from the chest (never narrower than the body)
    let hemHalf;
    if (gv('hem') != null) hemHalf = g.halfAt(hemH) + Math.max(0, gv('hem') - SF.bodyCircAt(body, hemH)) * WIDTH_PER_EASE + 0.4;
    else hemHalf = Math.max(cw - (type === 'tee' || type === 'shirt' ? 0.6 : 0), g.halfAt(hemH) + 0.8);
    if (type === 'dress' || type === 'coat') {
      const hipEase = gv('hip') != null ? gv('hip') - p.hip : 10;
      hemHalf = Math.max(hemHalf, g.halfAt(Math.max(hemH, L.knee)) + Math.max(4, hipEase * WIDTH_PER_EASE * 1.6));
    }

    const right = [[0, Y(L.hps) + 2.8], [g.neckHalf + 0.9, Y(L.hps + 0.8)]];
    right.push([lerp(g.neckHalf, g.shoulderHalf, 0.55), Y(lerp(L.hps, L.shoulder, 0.55)) - 0.5]);
    right.push([seam[0], seam[1], 'c']);
    right.push([cw, armholeY]);
    const armholeH = body.H - armholeY;
    const levels = [L.chest, L.waist, L.pantWaist, L.hip, L.crotch, (L.crotch + L.knee) / 2, L.knee].filter((h) => h < armholeH - 2 && h > hemH + 2);
    const span = armholeH - hemH;
    levels.forEach((h) => {
      const t = span > 0 ? (armholeH - h) / span : 0;
      let w = lerp(cw, hemHalf, Math.pow(t, type === 'dress' ? 1.6 : 1));
      // fitted styles follow the waist a little
      if ((type === 'dress' || type === 'shirt') && gv('waist') != null && Math.abs(h - L.waist) < 1) {
        w = g.waistHalf + Math.max(0, gv('waist') - p.waist) * WIDTH_PER_EASE + 0.4;
      }
      right.push([Math.max(w, g.halfAt(h) + 0.4), Y(h)]);
    });
    right.push([hemHalf, hemY, 'c']);
    right.push([0, hemY + 0.3]);
    return { outline: smoothPath(mirrorOutline(right), true), cw, seam, armholeY, hemY, hemH, hemHalf, drop, chestEase };
  }

  function sleeveGeometry(body, g, values, top) {
    const { p } = body;
    const gv = (k) => mid(values[k]);
    let eff = null;
    if (gv('sleeve') != null) eff = gv('sleeve') + Math.max(0, ((gv('shoulder') != null ? gv('shoulder') : p.shoulder) - p.shoulder) / 2);
    else if (gv('fullSleeve') != null) eff = gv('fullSleeve') / 2 - p.shoulder / 2;
    else if (gv('neckSleeve') != null) eff = gv('neckSleeve') - p.shoulder / 2 + 2;
    if (eff == null) return null;
    const arm = p.armLength;
    const tEnd = Math.min(eff, arm + g.handLen * 0.7);
    const tStart = Math.max(0, top.drop * 0.9);
    if (tEnd <= tStart + 2) return null;
    const sleeveEase = gv('bicep') != null ? gv('bicep') - p.bicep : Math.max(2, top.chestEase * 0.3);
    const wTop = Math.max(g.armWidthAt(tStart) + 1.4, g.bicepW + sleeveEase * 0.33);
    const cuffW = gv('cuff') != null ? Math.max(g.armWidthAt(tEnd) + 0.8, gv('cuff') * 0.33) : g.armWidthAt(tEnd) + (eff < arm * 0.6 ? Math.max(1.6, sleeveEase * 0.25) : 1.4);
    const n = 6;
    const outer = [], inner = [];
    for (let i = 0; i <= n; i++) {
      const t = lerp(tStart, tEnd, i / n);
      const c = g.armPoint(t);
      const w = Math.max(lerp(wTop, cuffW, i / n), g.armWidthAt(t) + 0.8) / 2;
      outer.push([c[0] + g.armNorm[0] * w, c[1] + g.armNorm[1] * w, i === n ? 'c' : undefined]);
      inner.push([c[0] - g.armNorm[0] * w, c[1] - g.armNorm[1] * w, i === n ? 'c' : undefined]);
    }
    outer[0] = [top.seam[0] + 0.3, top.seam[1], 'c'];
    inner[0] = [Math.min(top.cw, inner[0][0]), top.armholeY + 0.5, 'c'];
    outer.splice(1, 0, [top.seam[0] + 1.2, top.seam[1] + 2.5]);
    const right = outer.concat(inner.reverse());
    const end = g.armPoint(tEnd);
    return {
      right: smoothPath(right, true),
      left: smoothPath(right.map((q) => [-q[0], q[1], q[2]]), true),
      end, eff, tEnd,
    };
  }

  function bottomGeometry(body, g, values, type) {
    const { p, L, H } = body;
    const Y = g.Y;
    const gv = (k) => mid(values[k]);
    const w = values.waist;
    const waistTop = Y(L.pantWaist) - 0.5;
    const elastic = w && w.elastic;
    let waistHalf = g.halfAt(L.pantWaist) + 0.4;
    if (gv('waist') != null && !elastic) waistHalf += Math.max(0, gv('waist') - p.pantWaist) * WIDTH_PER_EASE;
    const hipEase = gv('hip') != null ? gv('hip') - p.hip : 6;
    const hipHalf = g.hipHalf + Math.max(0, hipEase) * WIDTH_PER_EASE + 0.4;

    let hemH;
    if (gv('inseam') != null) hemH = L.crotch - gv('inseam');
    else if (gv('outseam') != null) hemH = L.pantWaist - gv('outseam');
    else if (gv('skirtLength') != null) hemH = L.pantWaist - gv('skirtLength');
    else hemH = type === 'shorts' ? L.knee + 8 : type === 'skirt' ? L.knee : 3;
    const extra = hemH < 0 ? -hemH : 0; // fabric that would go past the floor
    const hemHc = Math.max(hemH, 0.3);

    if (type === 'skirt') {
      const hemHalf = Math.max(hipHalf + 2, g.halfAt(hemHc) + 3) + Math.max(0, hipEase) * 0.1;
      const right = [[0, waistTop], [waistHalf, waistTop, 'c'], [hipHalf, Y(L.hip)], [hemHalf, Y(hemHc), 'c'], [0, Y(hemHc) + 0.4]];
      return { outline: smoothPath(mirrorOutline(right), true), waistTop, hemY: Y(hemHc), hemH, extra, waistHalf, hipHalf };
    }

    let crotchH = L.crotch - 1;
    if (gv('rise') != null) crotchH = Math.min(L.crotch - 0.5, L.pantWaist - (gv('rise') - 3));
    const thighEase = gv('thigh') != null ? gv('thigh') - p.thigh : Math.max(4, hipEase * 0.6);
    const legW = g.thighW + Math.max(0, thighEase) * 0.33 + 0.6;
    const outerAtCrotch = Math.max(hipHalf * 0.98, g.thighOuter + 0.5);
    const legCenter = outerAtCrotch - legW / 2;
    const tAt = (h) => Math.max(0, Math.min(1, (crotchH - h) / Math.max(crotchH - hemHc, 1)));
    let openW;
    if (gv('legOpening') != null) openW = gv('legOpening') * 0.47;
    else openW = type === 'shorts' ? legW * 0.92 : Math.max(legW * 0.62, g.ankleW + 6);
    const centerAt = (h) => {
      if (h >= L.knee) return lerp(legCenter, g.kneeCenter, (crotchH - h) / Math.max(crotchH - L.knee, 1));
      return lerp(g.kneeCenter, g.ankleCenter, (L.knee - h) / Math.max(L.knee, 1));
    };
    const widthAt = (h) => {
      const bodyW = (g.halfAt(h) - centerAt(h)) * 2 + 0.8;
      let wv;
      if (gv('knee') != null && Math.abs(h - L.knee) < 1) wv = gv('knee') * 0.47;
      else wv = lerp(legW, openW, Math.pow(tAt(h), 0.9));
      return Math.max(wv, bodyW);
    };
    const levels = [crotchH - 4, (crotchH + L.knee) / 2, L.knee, L.calf, L.ankle + 4].filter((h) => h > hemHc + 2 && h < crotchH - 1);
    const outer = [[0, waistTop], [waistHalf, waistTop, 'c'], [Math.max(hipHalf, waistHalf), Y(L.hip)], [outerAtCrotch, Y(crotchH)]];
    levels.forEach((h) => outer.push([centerAt(h) + widthAt(h) / 2, Y(h)]));
    const hemCenter = centerAt(hemHc);
    const hemW = Math.max(openW, (g.halfAt(hemHc) - hemCenter) * 2 + 0.8);
    outer.push([hemCenter + hemW / 2, Y(hemHc), 'c']);
    outer.push([hemCenter - hemW / 2, Y(hemHc), 'c']);
    levels.slice().reverse().forEach((h) => outer.push([Math.max(0.2, centerAt(h) - widthAt(h) / 2), Y(h)]));
    outer.push([0, Y(crotchH), 'c']);
    // Build a closed outline: right leg + mirrored left leg sharing the waistband
    const right = outer;
    const left = right.slice(1, -1).reverse().map((q) => [-q[0], q[1], q[2]]);
    const outline = smoothPath(right.concat(left), true);
    return { outline, waistTop, hemY: Y(hemHc), hemH, extra, waistHalf, hipHalf, crotchY: Y(crotchH), legW, hemCenter, hemW, elastic };
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------
  function itemLabel(item, units) {
    const def = SF.MEASURE_DEFS[item.key] || { label: item.key, zh: '' };
    const st = STATUS[item.status] || STATUS.info;
    let detail = '';
    if (item.kind === 'ease' && item.diff != null) detail = (item.diff >= 0 ? '+' : '−') + SF.fmtLen(Math.abs(item.diff), units) + ' vs you';
    else if (item.kind === 'elastic') detail = 'stretches ' + SF.fmtLen(item.garment, units) + '–' + SF.fmtLen(item.garmentMax, units);
    else if (item.kind === 'landing' || item.kind === 'info') detail = SF.fmtLen(item.garment, units);
    else if (item.kind === 'shoe') detail = (item.diff >= 0 ? '+' : '−') + Math.round(Math.abs(item.diff) * 10) + ' mm';
    else if (item.kind === 'range') detail = '';
    return { title: def.label + (def.zh ? ' ' + def.zh : ''), detail, verdict: item.verdict, color: st.color, mark: st.mark };
  }

  function layoutLabels(labels, minGap, top, bottom) {
    labels.sort((a, b) => a.y - b.y);
    for (let i = 0; i < labels.length; i++) {
      labels[i].ly = Math.max(labels[i].y, i ? labels[i - 1].ly + minGap : top);
    }
    const overflow = labels.length ? labels[labels.length - 1].ly - bottom : 0;
    if (overflow > 0) {
      for (let i = labels.length - 1; i >= 0; i--) {
        labels[i].ly = Math.min(labels[i].ly, i === labels.length - 1 ? bottom : labels[i + 1].ly - minGap);
      }
    }
    return labels;
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------
  /**
   * renderFit(result, sizeLabel, opts) → SVG string
   *   result: output of SizeFit.recommend()
   *   opts: { units: 'in'|'cm', compact: bool, skin: key, title: string }
   */
  function renderFit(result, chart, sizeLabel, opts) {
    opts = opts || {};
    const units = opts.units || 'in';
    const body = result.body;
    const ev = result.evals.find((e) => e.label === sizeLabel) || result.best;
    if (!ev) return '';
    const type = chart.type;
    const group = (SF.GARMENT_TYPES[type] || {}).group;
    if (group === 'shoes') return renderShoe(result, ev, opts);

    const H = body.H;
    const g = bodyGeometry(body);
    const Y = g.Y;
    const skin = SKIN_TONES[opts.skin] || SKIN_TONES.mannequin;
    const compact = !!opts.compact;

    const parts = [];
    const defs = [];
    const uid = 'sf' + Math.random().toString(36).slice(2, 8);

    // Body
    const bodyD = bodyOutline(body, g);
    const armTEnd = body.p.armLength + g.handLen;
    const armR = armPath(g, 1, armTEnd);
    const armL = armPath(g, -1, armTEnd);
    const bodyParts = [];
    bodyParts.push(`<path d="${bodyD}" fill="${skin[0]}" stroke="${skin[1]}" stroke-width="0.35"/>`);
    bodyParts.push(`<ellipse cx="0" cy="${f(g.headCy)}" rx="${f(g.headRx)}" ry="${f(g.headRy)}" fill="${skin[0]}" stroke="${skin[1]}" stroke-width="0.35"/>`);

    let top = null, sleeves = null, bottom = null;
    const garmentParts = [];
    const overParts = []; // sleeves drawn over the arms
    const v = ev.values;

    if (group === 'bottom') {
      bottom = bottomGeometry(body, g, v, type);
      const [fill, stroke] = GARMENT_COLORS.bottom;
      garmentParts.push(`<path d="${bottom.outline}" fill="${fill}" stroke="${stroke}" stroke-width="0.4" fill-opacity="0.94"/>`);
      if (type !== 'skirt') {
        garmentParts.push(`<path d="M${f(-bottom.waistHalf)},${f(bottom.waistTop + 4)} L${f(bottom.waistHalf)},${f(bottom.waistTop + 4)}" stroke="${stroke}" stroke-width="0.35" opacity="0.8"/>`);
        garmentParts.push(`<path d="M0,${f(bottom.waistTop + 4)} L0,${f(bottom.waistTop + 17)}" stroke="${stroke}" stroke-width="0.3" opacity="0.6"/>`);
        if (bottom.elastic) {
          for (let x = -bottom.waistHalf + 1.5; x < bottom.waistHalf - 1; x += 1.6) garmentParts.push(`<path d="M${f(x)},${f(bottom.waistTop + 0.6)} l0,3" stroke="${stroke}" stroke-width="0.2" opacity="0.6"/>`);
        }
      }
      if (bottom.extra > 0.5) {
        // fabric that would land past the floor stacks at the ankle
        const n = Math.min(4, Math.ceil(bottom.extra / 2.5));
        [-1, 1].forEach((s) => {
          for (let i = 0; i < n; i++) {
            const yy = bottom.hemY - 2 - i * 2.4;
            const cx = s * bottom.hemCenter;
            garmentParts.push(`<path d="M${f(cx - bottom.hemW / 2)},${f(yy)} q${f(bottom.hemW / 2)},1.6 ${f(bottom.hemW)},0" fill="none" stroke="${stroke}" stroke-width="0.35" opacity="0.85"/>`);
          }
        });
      }
    } else {
      top = topGeometry(body, g, v, type);
      const [fill, stroke] = group === 'dress' ? GARMENT_COLORS.dress : GARMENT_COLORS.top;
      garmentParts.push(`<path d="${top.outline}" fill="${fill}" stroke="${stroke}" stroke-width="0.4" fill-opacity="0.95"/>`);
      // neckline
      garmentParts.push(`<path d="M${f(-g.neckHalf - 0.9)},${f(Y(body.L.hps + 0.8))} Q0,${f(Y(body.L.hps) + 6)} ${f(g.neckHalf + 0.9)},${f(Y(body.L.hps + 0.8))}" fill="${skin[0]}" stroke="${stroke}" stroke-width="0.4"/>`);
      sleeves = sleeveGeometry(body, g, v, top);
      if (sleeves) {
        overParts.push(`<path d="${sleeves.right}" fill="${fill}" stroke="${stroke}" stroke-width="0.4"/>`);
        overParts.push(`<path d="${sleeves.left}" fill="${fill}" stroke="${stroke}" stroke-width="0.4"/>`);
      }
    }

    // Body outline under the garment (dashed), so the gap = ease is visible
    defs.push(`<clipPath id="${uid}-clip"><path d="${bottom ? bottom.outline : top.outline}"/></clipPath>`);
    const ghost = `<path d="${bodyD}" fill="none" stroke="#ffffff" stroke-width="0.35" stroke-dasharray="1.2 0.9" opacity="0.85" clip-path="url(#${uid}-clip)"/>`;

    // Fit markers and labels
    const markers = [];
    const labels = [];
    const items = ev.items;
    const sideX = (h) => g.halfAt(h);
    const addMarker = (item, y, x1, x2) => {
      const st = STATUS[item.status] || STATUS.info;
      if (x2 - x1 > 0.3) markers.push(`<path d="M${f(x1)},${f(y)} L${f(x2)},${f(y)}" stroke="${st.color}" stroke-width="0.9" stroke-linecap="round"/>`);
      markers.push(`<circle cx="${f(x2)}" cy="${f(y)}" r="0.9" fill="${st.color}" stroke="#fff" stroke-width="0.25"/>`);
      labels.push(Object.assign({ y, ax: x2 }, itemLabel(item, units)));
    };
    items.forEach((it) => {
      const L = body.L;
      if (top) {
        if (it.key === 'chest') addMarker(it, Y(L.chest), sideX(L.chest), top.cw);
        else if (it.key === 'shoulder') addMarker(it, top.seam[1], g.shoulderHalf, top.seam[0]);
        else if (it.key === 'length') addMarker(it, top.hemY, 0, top.hemHalf);
        else if (it.key === 'waist') addMarker(it, Y(L.waist), sideX(L.waist), Math.max(sideX(L.waist), top.cw - 1));
        else if (it.key === 'hip' || it.key === 'hem') addMarker(it, Math.min(Y(L.hip), top.hemY - 1), sideX(L.hip), top.hemHalf);
        else if ((it.key === 'sleeve' || it.key === 'bicep' || it.key === 'neck') && sleeves && it.key === 'sleeve') addMarker(it, sleeves.end[1], sleeves.end[0], sleeves.end[0] + 2.5);
        else if (it.key === 'neck') addMarker(it, Y(L.hps), g.neckHalf, g.neckHalf + 1.5);
        else if (it.key === 'bicep' && sleeves) { const c = g.armPoint(body.p.armLength * 0.25); addMarker(it, c[1], c[0], c[0] + g.bicepW / 2 + 1); }
      } else if (bottom) {
        if (it.key === 'waist') addMarker(it, bottom.waistTop + 1.5, sideX(L.pantWaist), bottom.waistHalf);
        else if (it.key === 'hip') addMarker(it, Y(L.hip), sideX(L.hip), bottom.hipHalf);
        else if (it.key === 'thigh') addMarker(it, Y(L.crotch - 4), g.thighOuter - 0.5, Math.max(g.thighOuter, bottom.hipHalf * 0.98) - 0.2);
        else if (it.key === 'outseam' || it.key === 'inseam' || it.key === 'skirtLength') addMarker(it, bottom.hemY, bottom.hemCenter, bottom.hemCenter + bottom.hemW / 2);
        else if (it.key === 'rise' && bottom.crotchY) addMarker(it, bottom.crotchY, 0, 1);
      }
      if (it.key === 'height' || it.key === 'weight') labels.push(Object.assign({ y: it.key === 'height' ? 2 : 8, ax: null }, itemLabel(it, units)));
    });

    // Layout
    const maxHalf = Math.max(g.shoulderHalf, g.hipHalf, top ? top.cw : 0, top ? top.hemHalf : 0, bottom ? bottom.hipHalf : 0) + 14;
    const labelX = maxHalf + 3;
    const labelW = compact ? 0 : 68;
    const rulerW = compact ? 2 : 13;
    const vbX = -maxHalf - rulerW;
    const vbW = maxHalf * 2 + rulerW + labelW + (compact ? 2 : 0);
    const headerH = compact ? 0 : 16;
    const vbY = -4 - headerH;
    const vbH = H + 10 + headerH;

    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vbX)} ${f(vbY)} ${f(vbW)} ${f(vbH)}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif" role="img" aria-label="${esc('Size ' + ev.label + ' on your body')}">`);
    out.push(`<defs>${defs.join('')}</defs>`);
    out.push(`<rect x="${f(vbX)}" y="${f(vbY)}" width="${f(vbW)}" height="${f(vbH)}" fill="#fbfaf8"/>`);
    // floor
    out.push(`<rect x="${f(vbX)}" y="${f(H)}" width="${f(vbW)}" height="6" fill="#ece8e1"/>`);
    out.push(`<path d="M${f(vbX)},${f(H)} L${f(vbX + vbW)},${f(H)}" stroke="#cfc8bd" stroke-width="0.3"/>`);

    if (!compact) {
      // ruler
      const rx = vbX + 7;
      out.push(`<path d="M${f(rx)},0 L${f(rx)},${f(H)}" stroke="#b9b2a7" stroke-width="0.3"/>`);
      if (units === 'in') {
        for (let inch = 0; inch * 2.54 <= H + 0.01; inch += 6) {
          const yy = H - inch * 2.54;
          const major = inch % 12 === 0;
          out.push(`<path d="M${f(rx - (major ? 2.4 : 1.4))},${f(yy)} L${f(rx)},${f(yy)}" stroke="#b9b2a7" stroke-width="0.3"/>`);
          if (major) out.push(`<text x="${f(rx - 3)}" y="${f(yy + 1)}" font-size="2.6" text-anchor="end" fill="#8a8378">${inch / 12}′</text>`);
        }
      } else {
        for (let c = 0; c <= H + 0.01; c += 10) {
          const yy = H - c;
          const major = c % 50 === 0;
          out.push(`<path d="M${f(rx - (major ? 2.4 : 1.4))},${f(yy)} L${f(rx)},${f(yy)}" stroke="#b9b2a7" stroke-width="0.3"/>`);
          if (major) out.push(`<text x="${f(rx - 3)}" y="${f(yy + 1)}" font-size="2.6" text-anchor="end" fill="#8a8378">${c}</text>`);
        }
      }
      out.push(`<text x="${f(rx)}" y="${f(H + 4.4)}" font-size="2.6" text-anchor="middle" fill="#8a8378">${units === 'in' ? SF.fmtHeightImperial(H) : Math.round(H) + ' cm'}</text>`);
    }

    // figure: body, (base tee), garment, ghost outline, arms, sleeves, markers
    out.push(bodyParts.join(''));
    // arms go behind the garment; sleeves are drawn over them afterwards
    out.push(`<path d="${armR}" fill="${skin[0]}" stroke="${skin[1]}" stroke-width="0.35"/>`);
    out.push(`<path d="${armL}" fill="${skin[0]}" stroke="${skin[1]}" stroke-width="0.35"/>`);
    let baseSleeves = '';
    if (group === 'bottom') {
      // a plain base-layer tee so the figure isn't bare above the pants
      const teeVals = { length: { min: 0.4 * H, max: 0.4 * H }, chest: { min: body.p.chest + 10, max: body.p.chest + 10 }, shoulder: { min: body.p.shoulder, max: body.p.shoulder }, sleeve: { min: 20, max: 20 } };
      const tee = topGeometry(body, g, teeVals, 'tee');
      const teeBottom = Math.min(tee.hemY, bottom.waistTop + 3);
      out.push(`<clipPath id="${uid}-tee"><rect x="-200" y="-50" width="400" height="${f(teeBottom + 50)}"/></clipPath>`);
      out.push(`<path d="${tee.outline}" fill="#d9dde3" stroke="#a7aeb8" stroke-width="0.35" clip-path="url(#${uid}-tee)"/>`);
      const ts = sleeveGeometry(body, g, teeVals, tee);
      if (ts) baseSleeves = `<path d="${ts.right}" fill="#d9dde3" stroke="#a7aeb8" stroke-width="0.35"/><path d="${ts.left}" fill="#d9dde3" stroke="#a7aeb8" stroke-width="0.35"/>`;
    }
    out.push(garmentParts.join(''));
    out.push(ghost);
    out.push(baseSleeves);
    out.push(overParts.join(''));
    if (!compact) out.push(markers.join(''));

    // header + labels
    if (!compact) {
      const scoreCol = ev.score >= 85 ? STATUS.ok.color : ev.score >= 70 ? '#3f8f4f' : ev.score >= 50 ? STATUS.snug.color : STATUS.tight.color;
      out.push(`<text x="${f(vbX + 2)}" y="${f(vbY + 6.5)}" font-size="5" font-weight="700" fill="#24211d">Size ${esc(ev.label)}</text>`);
      out.push(`<text x="${f(vbX + 2)}" y="${f(vbY + 11.5)}" font-size="2.9" fill="#6b655c">${esc((opts.title || SF.GARMENT_TYPES[type].label).slice(0, 60))}</text>`);
      out.push(`<rect x="${f(vbX + vbW - 30)}" y="${f(vbY + 2)}" width="28" height="9" rx="4.5" fill="${scoreCol}"/>`);
      out.push(`<text x="${f(vbX + vbW - 16)}" y="${f(vbY + 8)}" font-size="3.6" font-weight="700" text-anchor="middle" fill="#fff">Fit ${ev.score}/100</text>`);

      layoutLabels(labels, 10.5, 2, H - 4).forEach((lb) => {
        if (lb.ax != null) out.push(`<path d="M${f(lb.ax + 1)},${f(lb.y)} L${f(labelX - 2)},${f(lb.ly)}" stroke="${lb.color}" stroke-width="0.25" fill="none" opacity="0.8"/>`);
        out.push(`<circle cx="${f(labelX + 1.6)}" cy="${f(lb.ly - 1)}" r="1.9" fill="${lb.color}"/>`);
        out.push(`<text x="${f(labelX + 1.6)}" y="${f(lb.ly)}" font-size="2.6" font-weight="700" text-anchor="middle" fill="#fff">${esc(lb.mark)}</text>`);
        out.push(`<text x="${f(labelX + 4.8)}" y="${f(lb.ly - 0.2)}" font-size="3" font-weight="650" fill="#24211d">${esc(lb.title)}${lb.detail ? `<tspan font-weight="400" fill="#6b655c">  ${esc(lb.detail)}</tspan>` : ''}</text>`);
        out.push(`<text x="${f(labelX + 4.8)}" y="${f(lb.ly + 3.6)}" font-size="2.7" fill="${lb.color}">${esc(lb.verdict.length > 44 ? lb.verdict.slice(0, 43) + '…' : lb.verdict)}</text>`);
      });
      // legend
      const lgY = H + 4.4;
      let lx = labelX;
      [['ok', 'good'], ['snug', 'snug'], ['tight', 'tight'], ['loose', 'loose']].forEach(([k, word]) => {
        out.push(`<circle cx="${f(lx + 1)}" cy="${f(lgY - 0.9)}" r="1.1" fill="${STATUS[k].color}"/><text x="${f(lx + 3)}" y="${f(lgY)}" font-size="2.5" fill="#6b655c">${word}</text>`);
        lx += 11;
      });
      out.push(`<text x="${f(vbX + vbW / 2 - labelW / 2 + rulerW / 2)}" y="${f(H + 4.4)}" font-size="2.3" text-anchor="middle" fill="#9a9387">dashed line = your body under the garment</text>`);
    }
    out.push('</svg>');
    return out.join('');
  }

  // Shoes: top-down foot inside the shoe outline
  function renderShoe(result, ev, opts) {
    const p = result.body.p;
    const item = ev.items.find((i) => i.kind === 'shoe');
    const footL = p.footLength;
    const shoeL = item ? footL + item.diff + 1.2 : footL + 1.2;
    const footW = p.footWidth || footL * 0.38;
    const st = STATUS[item ? item.status : 'info'];
    const W = 70, Hh = 40;
    const sx = 8, cy = 20;
    const foot = (len, wid, x0) => {
      const pts = [[x0, cy], [x0 + len * 0.05, cy - wid * 0.32], [x0 + len * 0.35, cy - wid * 0.4], [x0 + len * 0.72, cy - wid * 0.5], [x0 + len * 0.92, cy - wid * 0.38], [x0 + len, cy - wid * 0.05], [x0 + len * 0.96, cy + wid * 0.3], [x0 + len * 0.72, cy + wid * 0.48], [x0 + len * 0.4, cy + wid * 0.32], [x0 + len * 0.06, cy + wid * 0.3]];
      return smoothPath(pts, true);
    };
    const skin = SKIN_TONES[opts.skin] || SKIN_TONES.mannequin;
    const gap = item ? Math.round(item.diff * 10) : 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" font-family="system-ui, sans-serif" role="img" aria-label="Shoe size ${esc(ev.label)}">
<rect width="${W}" height="${Hh}" fill="#fbfaf8"/>
<text x="3" y="5" font-size="3.4" font-weight="700" fill="#24211d">Size ${esc(ev.label)} — top view</text>
<path d="${foot(shoeL, footW * 1.12, sx - 0.6)}" fill="#3d4f66" stroke="#253244" stroke-width="0.4"/>
<path d="${foot(shoeL - 0.8, footW * 1.02, sx)}" fill="#f4f1ec"/>
<path d="${foot(footL, footW, sx)}" fill="${skin[0]}" stroke="${skin[1]}" stroke-width="0.3"/>
<path d="M${f(sx + footL)},${cy + 9} L${f(sx + shoeL - 0.8)},${cy + 9}" stroke="${st.color}" stroke-width="0.8"/>
<text x="${f(sx + footL)}" y="${cy + 13}" font-size="2.6" fill="${st.color}">${gap >= 0 ? '+' : '−'}${Math.abs(gap)} mm toe room — ${esc(item ? item.verdict : '')}</text>
<text x="3" y="${Hh - 3}" font-size="2.4" fill="#6b655c">Your foot ${Math.round(footL * 10)} mm · shoe ≈ ${Math.round((shoeL - 0.8) * 10)} mm inside</text>
</svg>`;
  }

  return { renderFit, bodyGeometry, smoothPath, STATUS, SKIN_TONES };
});
