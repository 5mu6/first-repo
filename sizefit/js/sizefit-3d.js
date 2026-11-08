/*
 * SizeFit 3D — a high-resolution body scan built from the user's measurements,
 * wearing one size of a garment as a translucent shell coloured by fit.
 *
 * The body is a signed distance field (SDF): a torso lofted through the measured
 * chest / waist / hip cross-sections, smoothly blended with anatomically placed
 * limbs, muscles, hands, feet and head. It is meshed with surface nets at ~8 mm.
 * The garment is lofted from the size chart, draped so it never passes through
 * the body, and each point is coloured by its distance to the skin (a fit map).
 *
 *   buildFitModel(result, chart, size) → plain description, no WebGL (Node-testable)
 *   makeBodySDF(spec), polygonize(f, bounds, step), garmentMesh(tube, f)
 *   new Fit3D(container) → three.js viewer (window.THREE, r128+)
 *
 * Units are centimetres; y is height above the floor, z points forward.
 */
(function (root, factory) {
  const core = (typeof module === 'object' && module.exports) ? require('./sizefit-core.js') : root.SizeFit;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SizeFit = Object.assign(root.SizeFit || {}, api);
})(typeof self !== 'undefined' ? self : this, function (SF) {
  'use strict';

  const TAU = Math.PI * 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const STATUS_COLORS = { tight: '#ff4d5e', snug: '#ffad33', ok: '#3ee08f', loose: '#4fb3ff', big: '#a07bff', info: '#9fb3c8' };

  // ---------------------------------------------------------------------------
  // Small vector + SDF helpers
  // ---------------------------------------------------------------------------
  const v3 = (x, y, z) => [x, y, z];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  function smin(a, b, k) {
    if (k <= 0) return Math.min(a, b);
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
  }
  function smax(a, b, k) { return -smin(-a, -b, k); }

  // Ellipsoid (optionally rotated by an orthonormal basis), iq's bound.
  function ellipsoid(c, r, axes, k) {
    return { t: 'e', c, r, ax: axes || null, k: k == null ? 2 : k };
  }
  function sdEllipsoid(px, py, pz, e) {
    let x = px - e.c[0], y = py - e.c[1], z = pz - e.c[2];
    if (e.ax) {
      const a = e.ax;
      const lx = x * a[0][0] + y * a[0][1] + z * a[0][2];
      const ly = x * a[1][0] + y * a[1][1] + z * a[1][2];
      const lz = x * a[2][0] + y * a[2][1] + z * a[2][2];
      x = lx; y = ly; z = lz;
    }
    const rx = e.r[0], ry = e.r[1], rz = e.r[2];
    const k0 = Math.sqrt((x / rx) * (x / rx) + (y / ry) * (y / ry) + (z / rz) * (z / rz));
    const k1 = Math.sqrt((x / (rx * rx)) * (x / (rx * rx)) + (y / (ry * ry)) * (y / (ry * ry)) + (z / (rz * rz)) * (z / (rz * rz)));
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
  }
  // Tapered capsule between a and b.
  function cone(a, b, r1, r2, k) {
    const ba = sub(b, a);
    return { t: 'c', a, ba, bb: dot(ba, ba), r1, r2, k: k == null ? 2 : k };
  }
  function sdCone(px, py, pz, c) {
    const x = px - c.a[0], y = py - c.a[1], z = pz - c.a[2];
    const t = clamp((x * c.ba[0] + y * c.ba[1] + z * c.ba[2]) / c.bb, 0, 1);
    const dx = x - c.ba[0] * t, dy = y - c.ba[1] * t, dz = z - c.ba[2] * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - (c.r1 + (c.r2 - c.r1) * t);
  }
  // Orthonormal basis whose first row is `along` (used for limbs and hands).
  function basis(along, hint) {
    const a = norm(along);
    let b = norm(sub(hint, mul(a, dot(hint, a))));
    const c = cross(a, b);
    return [b, a, c]; // rows: local x (hint-ish), local y (along), local z
  }
  function rotY(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  }

  // Ellipse helpers shared with the garment.
  function ellipse(C, k) {
    const h = Math.pow((k - 1) / (k + 1), 2);
    const f = 1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h));
    const b = C / (Math.PI * (k + 1) * f);
    return { rx: k * b, rz: b };
  }
  function circumference(rx, rz) {
    const h = Math.pow((rx - rz) / (rx + rz), 2);
    return Math.PI * (rx + rz) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  }

  // ---------------------------------------------------------------------------
  // Body description from measurements
  // ---------------------------------------------------------------------------
  function bodySpec(body) {
    const { p, L, H, fem } = body;
    const hs = H / 178; // head / hand scale
    const kChest = fem ? 1.3 : 1.42, kWaist = 1.28, kHip = fem ? 1.4 : 1.32;
    const chestE = ellipse(p.chest, kChest);
    const waistE = ellipse(p.waist, kWaist);
    const pwE = ellipse(p.pantWaist, kWaist);
    const hipE = ellipse(p.hip, kHip);
    const shoulderHalf = (p.shoulder * 0.93) / 2;
    const bicepR = p.bicep / TAU;
    const neckR = p.neck / TAU;
    const thighR = p.thigh / TAU;
    const kneeR = (p.thigh * 0.64) / TAU;
    const calfR = (p.thigh * 0.66) / TAU;
    const ankleR = (p.thigh * 0.4) / TAU;
    const armAngle = (16 * Math.PI) / 180;
    const handLen = 0.108 * H;
    const F = p.footLength;

    // Torso cross-sections (bottom → top): y, half-width, front depth, back depth, centre z
    const ring = (y, rx, rzF, rzB, cz) => ({ y, rx, rzF, rzB, cz: cz || 0 });
    const torso = [
      ring(L.crotch - 1, hipE.rx * 0.62, hipE.rz * 0.55, hipE.rz * 0.62, -0.5),
      ring(L.crotch + 4, hipE.rx * 0.9, hipE.rz * 0.8, hipE.rz * 0.95, -0.6),
      ring(L.hip, hipE.rx * 0.98, hipE.rz * 0.86, hipE.rz * 0.88, -0.6),
      ring(L.pantWaist, pwE.rx, pwE.rz * 1.0, pwE.rz * 0.98, 0),
      ring(L.waist, waistE.rx, waistE.rz * 1.06, waistE.rz * 0.94, 0.2),
      ring(lerp(L.waist, L.chest, 0.55), lerp(waistE.rx, chestE.rx, 0.62), lerp(waistE.rz, chestE.rz, 0.62) * 1.04, lerp(waistE.rz, chestE.rz, 0.62) * 0.96, 0),
      ring(L.chest, chestE.rx, chestE.rz * 1.05, chestE.rz * 0.95, 0),
      ring(L.armpit + 2, chestE.rx * 1.0, chestE.rz * 0.97, chestE.rz * 0.97, -0.4),
      ring(L.shoulder - 2, Math.max(shoulderHalf - bicepR * 0.75, chestE.rx * 0.9), chestE.rz * 0.72, chestE.rz * 0.86, -1.2),
      ring(L.shoulder + 1.2, shoulderHalf * 0.78, chestE.rz * 0.5, chestE.rz * 0.66, -1.6),
      ring(lerp(L.shoulder, L.hps, 0.6), lerp(shoulderHalf * 0.7, neckR * 1.6, 0.6), neckR * 1.25, neckR * 1.5, -1.6),
      ring(L.hps + 0.6, neckR * 1.25, neckR * 1.05, neckR * 1.15, -1.4),
    ];

    const parts = { center: [], arm: [[], []], leg: [[], []] };
    const C = parts.center;
    // neck + head
    C.push(cone(v3(0, L.hps - 3, -1.4), v3(0, L.chin + 0.012 * H, -1.0), neckR * 0.98, neckR * 0.86, 3));
    C.push(ellipsoid(v3(0, H - 0.056 * H, -0.9), [0.041 * H, 0.058 * H, 0.052 * H], null, 4)); // cranium
    C.push(ellipsoid(v3(0, H - 0.094 * H, 0.012 * H), [0.031 * H, 0.04 * H, 0.04 * H], null, 3)); // face/jaw
    C.push(ellipsoid(v3(0, L.chin + 0.009 * H, 0.031 * H), [0.014 * H, 0.011 * H, 0.012 * H], null, 1.6)); // chin
    C.push(ellipsoid(v3(0, H - 0.079 * H, 0.05 * H), [0.0062 * H, 0.0145 * H, 0.0095 * H], basis([0, 1, -0.28], [1, 0, 0]), 1.0)); // nose
    C.push(ellipsoid(v3(0, H - 0.063 * H, 0.04 * H), [0.03 * H, 0.0075 * H, 0.0125 * H], null, 1.4)); // brow
    C.push(ellipsoid(v3(0, H - 0.103 * H, 0.046 * H), [0.013 * H, 0.0042 * H, 0.0062 * H], null, 0.8)); // lips
    [-1, 1].forEach((s) => {
      C.push(ellipsoid(v3(s * 0.0425 * H, H - 0.073 * H, -0.006 * H), [0.0062 * H, 0.0165 * H, 0.0105 * H], null, 1.0)); // ear
      C.push(ellipsoid(v3(s * 0.024 * H, H - 0.081 * H, 0.034 * H), [0.012 * H, 0.0095 * H, 0.0105 * H], null, 1.4)); // cheekbone
      C.push(Object.assign(ellipsoid(v3(s * 0.0165 * H, H - 0.069 * H, 0.0505 * H), [0.0085 * H, 0.0062 * H, 0.0062 * H], null, 0.9), { sub: true })); // eye socket
      // trapezius, clavicle, chest, glutes
      C.push(ellipsoid(v3(s * lerp(neckR, shoulderHalf, 0.45), lerp(L.shoulder, L.hps, 0.35), -2.4), [chestE.rz * 0.42, (shoulderHalf - neckR) * 0.55, 3.4], basis([s * 1, -0.35, 0], [0, 0, 1]), 3));
      C.push(cone(v3(s * neckR * 0.6, L.shoulder + 0.3, chestE.rz * 0.55), v3(s * (shoulderHalf - 2.6), L.shoulder + 0.9, chestE.rz * 0.18), 0.95 * hs, 0.85 * hs, 1.6));
      if (fem) C.push(ellipsoid(v3(s * chestE.rx * 0.42, L.chest - 0.5, chestE.rz * 0.58), [5.6 * hs, 5.5 * hs, 5.2 * hs], null, 4));
      else C.push(ellipsoid(v3(s * chestE.rx * 0.42, L.chest + 4.5, chestE.rz * 0.62), [chestE.rx * 0.46, 5.2 * hs, chestE.rz * 0.4], basis([s * 0.25, 1, 0], [1, 0, 0]), 4)); // pectorals: broad and flat
      C.push(ellipsoid(v3(s * hipE.rx * 0.42, L.hip - 1.5, -hipE.rz * 0.4), [hipE.rx * 0.48, 9.5 * hs, hipE.rz * 0.56], null, 3.5));
    });
    C.push(Object.assign(cone(v3(0, L.waist - 2, -waistE.rz * 0.97), v3(0, L.chest + 4, -chestE.rz * 0.96), 0.9, 0.9, 1.8), { sub: true })); // spine groove

    // arms
    // shoulder joint: inside the shoulder line, but far enough out that the arm clears the chest
    const jointY = L.shoulder - 2.8;
    const armX0 = Math.max(shoulderHalf - bicepR * 0.62, chestE.rx + bicepR * 1.05 + 2.2 - (jointY - L.chest) * Math.tan(armAngle));
    const arms = [];
    [1, -1].forEach((s, si) => {
      const P = parts.arm[si];
      const J = v3(s * armX0, jointY, -1.0);
      const dir = norm(v3(s * Math.sin(armAngle), -Math.cos(armAngle), 0));
      const upper = p.armLength * 0.55 - 1.5;
      const E = add(J, mul(dir, upper));
      const fdir = norm(add(mul(dir, Math.cos(0.2)), v3(0, 0, Math.sin(0.2))));
      const W = add(E, mul(fdir, p.armLength * 0.45));
      const hdir = norm(add(mul(fdir, Math.cos(0.08)), v3(0, 0, Math.sin(0.08))));
      const elbowR = bicepR * 0.7, wristR = bicepR * 0.5;
      P.push(cone(J, E, bicepR * 1.0, elbowR, 3));
      P.push(ellipsoid(add(J, v3(s * 1.2, 0.8, 0)), [bicepR * 1.18, bicepR * 1.42, bicepR * 1.22], basis(dir, [0, 0, 1]), 3.2)); // deltoid
      P.push(ellipsoid(add(add(J, mul(dir, upper * 0.5)), v3(0, 0, bicepR * 0.25)), [bicepR * 0.82, upper * 0.3, bicepR * 0.86], basis(dir, [0, 0, 1]), 2.4)); // biceps / triceps mass
      P.push(cone(E, W, elbowR * 1.04, wristR, 2.2));
      P.push(ellipsoid(add(E, mul(fdir, p.armLength * 0.12)), [bicepR * 0.84, p.armLength * 0.14, bicepR * 0.8], basis(fdir, [0, 0, 1]), 2.4)); // forearm muscle
      // hand: palm faces the thigh, thumb forward
      const hb = basis(hdir, [s, 0, 0]);
      const palmC = add(W, mul(hdir, handLen * 0.27));
      P.push(ellipsoid(palmC, [1.9 * hs, handLen * 0.28, 4.1 * hs], hb, 1.8));
      P.push(ellipsoid(add(add(W, mul(hdir, handLen * 0.48)), v3(0, 0, 0.3)), [1.7 * hs, 1.6 * hs, 4.0 * hs], hb, 1.2)); // knuckles
      P.push(ellipsoid(add(add(W, mul(hdir, handLen * 0.7)), v3(0, 0, 0.6)), [1.35 * hs, handLen * 0.24, 3.7 * hs], hb, 1.4));
      P.push(cone(add(add(W, mul(hdir, handLen * 0.12)), v3(-s * 0.4, 0, 2.6 * hs)), add(add(W, mul(hdir, handLen * 0.42)), v3(-s * 0.8, 0, 4.4 * hs)), 1.05 * hs, 0.85 * hs, 1.4));
      arms.push({ J, E, W, dir, fdir, hdir, upper, side: s });
    });

    // legs
    const hipJx = hipE.rx * 0.5;
    const legs = [];
    [1, -1].forEach((s, si) => {
      const P = parts.leg[si];
      const J = v3(s * hipJx, L.crotch + 0.042 * H, -0.4);
      const K = v3(s * hipJx * 0.86, L.knee + 1, 0.4);
      const A = v3(s * hipJx * 0.8, L.ankle, -0.8);
      const thighLen = J[1] - K[1];
      const tc = (J[1] - (L.crotch - 4)) / thighLen;
      const rTop = (thighR - kneeR * tc) / Math.max(1 - tc, 0.2);
      P.push(cone(J, K, rTop, kneeR, 3));
      P.push(ellipsoid(v3(s * hipJx * 0.95, L.midThigh + 3, thighR * 0.32), [thighR * 0.7, thighLen * 0.32, thighR * 0.58], null, 4)); // quadriceps
      P.push(ellipsoid(v3(s * hipJx * 0.93, L.midThigh + 4, -thighR * 0.3), [thighR * 0.68, thighLen * 0.3, thighR * 0.55], null, 4)); // hamstrings
      P.push(ellipsoid(v3(K[0], L.knee + 1.4, kneeR * 0.72), [2.4 * hs, 2.8 * hs, 1.6 * hs], null, 1.6)); // knee cap
      P.push(cone(K, A, kneeR * 0.94, ankleR, 2.5));
      P.push(ellipsoid(v3(K[0] * 0.98, L.calf + 0.045 * H, -calfR * 0.36), [calfR * 0.78, 0.068 * H, calfR * 0.72], null, 3)); // calf
      P.push(ellipsoid(v3(A[0] + s * 2.6 * hs, L.ankle, -0.6), [1.2, 1.4, 1.3], null, 1.0)); // ankle bones
      P.push(ellipsoid(v3(A[0] - s * 2.4 * hs, L.ankle + 0.5, -0.4), [1.2, 1.4, 1.3], null, 1.0));
      // foot, slightly turned out
      const out = s * 0.12;
      const heelZ = -2.6;
      const toeZ = heelZ - 3.6 + F;
      const fp = (x, y, z) => add(v3(A[0], 0, 0), rotY(v3(x, y, z), out));
      const fb = basis(rotY([0, 0, 1], out), [0, 1, 0]);
      const footAxes = [fb[2], fb[0], fb[1]]; // local x = across, y = up, z = along the foot
      P.push(ellipsoid(fp(0, 3.6, heelZ), [3.0 * hs, 3.7, 3.7], null, 2));
      P.push(ellipsoid(fp(s * 0.3, 3.9, (heelZ + toeZ) / 2 - 1), [F * 0.15, 4.4, F * 0.36], footAxes, 2.8)); // midfoot / instep
      P.push(ellipsoid(fp(s * 0.6, 2.6, toeZ - 6), [F * 0.17, 2.7, 5.2], footAxes, 2.2)); // ball of the foot
      P.push(ellipsoid(fp(s * 0.8, 1.9, toeZ - 2.4), [F * 0.155, 1.9, 2.6], footAxes, 1.6)); // toes
      legs.push({ J, K, A, side: s, toeZ });
    });

    // bounding boxes per group (for speed)
    const extent = (prims) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      const grow = (pt, r) => { for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], pt[i] - r); mx[i] = Math.max(mx[i], pt[i] + r); } };
      prims.forEach((q) => {
        if (q.t === 'e') grow(q.c, Math.max(q.r[0], q.r[1], q.r[2]) + q.k);
        else { grow(q.a, q.r1 + q.k); grow(add(q.a, q.ba), q.r2 + q.k); }
      });
      return { min: mn, max: mx };
    };
    const torsoBox = { min: [-Math.max(hipE.rx, chestE.rx, shoulderHalf) - 2, L.crotch - 3, -Math.max(hipE.rz, chestE.rz) * 1.2 - 2], max: [Math.max(hipE.rx, chestE.rx, shoulderHalf) + 2, L.hps + 3, Math.max(hipE.rz, chestE.rz) * 1.2 + 2] };
    const centerBox = extent(C);
    const unionBox = (a, b) => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) });
    const groups = [
      { box: unionBox(torsoBox, centerBox), prims: C, torso: true },
      { box: extent(parts.arm[0]), prims: parts.arm[0], blend: 3.2 },
      { box: extent(parts.arm[1]), prims: parts.arm[1], blend: 3.2 },
      { box: extent(parts.leg[0]), prims: parts.leg[0], blend: 4 },
      { box: extent(parts.leg[1]), prims: parts.leg[1], blend: 4 },
    ];
    let bounds = groups.reduce((acc, g) => unionBox(acc, g.box), groups[0].box);
    bounds = { min: [bounds.min[0] - 1, -0.6, bounds.min[2] - 1], max: [bounds.max[0] + 1, H + 1, bounds.max[2] + 1] };

    return { H, L, torso, groups, bounds, arms, legs, armAngle, chestE, waistE, hipE, pwE, shoulderHalf, bicepR, handLen, armX0, kChest, kWaist, kHip, fem };
  }

  // Torso loft lookup table (Catmull-Rom between cross-sections, every 0.5 cm)
  function torsoTable(rings) {
    const y0 = rings[0].y, y1 = rings[rings.length - 1].y;
    const step = 0.5;
    const n = Math.ceil((y1 - y0) / step) + 1;
    const tab = new Float32Array(n * 4);
    const keys = ['rx', 'rzF', 'rzB', 'cz'];
    const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    for (let i = 0; i < n; i++) {
      const y = Math.min(y0 + i * step, y1);
      let s = 0;
      while (s < rings.length - 2 && rings[s + 1].y < y) s++;
      const a = rings[Math.max(s - 1, 0)], b = rings[s], c = rings[s + 1], d = rings[Math.min(s + 2, rings.length - 1)];
      const t = clamp((y - b.y) / ((c.y - b.y) || 1), 0, 1);
      keys.forEach((k, ki) => {
        let v = cr(a[k], b[k], c[k], d[k], t);
        if (k !== 'cz') v = Math.max(v, Math.min(b[k], c[k]) * 0.85); // no overshoot pinches
        tab[i * 4 + ki] = v;
      });
    }
    return { y0, y1, step, n, tab };
  }

  function makeBodySDF(spec) {
    const T = torsoTable(spec.torso);
    const groups = spec.groups;
    function torsoD(x, y, z) {
      const yy = clamp(y, T.y0, T.y1);
      const fi = (yy - T.y0) / T.step;
      const i = Math.min(Math.floor(fi), T.n - 2), t = fi - i;
      const o = i * 4, o2 = o + 4, tb = T.tab;
      const rx = tb[o] + (tb[o2] - tb[o]) * t;
      const cz = tb[o + 3] + (tb[o2 + 3] - tb[o + 3]) * t;
      const zz = z - cz;
      const rz = zz >= 0 ? tb[o + 1] + (tb[o2 + 1] - tb[o + 1]) * t : tb[o + 2] + (tb[o2 + 2] - tb[o + 2]) * t;
      const k0 = Math.sqrt((x / rx) * (x / rx) + (zz / rz) * (zz / rz));
      const k1 = Math.sqrt((x / (rx * rx)) * (x / (rx * rx)) + (zz / (rz * rz)) * (zz / (rz * rz)));
      let d = k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, rz);
      const dy = y < T.y0 ? T.y0 - y : y > T.y1 ? y - T.y1 : 0;
      if (dy > 0) d = d > 0 ? Math.sqrt(d * d + dy * dy) : Math.max(d, dy);
      return d;
    }
    function prim(q, x, y, z) { return q.t === 'e' ? sdEllipsoid(x, y, z, q) : sdCone(x, y, z, q); }
    function evalPrims(prims, x, y, z, init) {
      let d = init;
      for (let i = 0; i < prims.length; i++) {
        const q = prims[i];
        const e = prim(q, x, y, z);
        d = q.sub ? smax(d, -e, q.k) : smin(d, e, q.k);
      }
      return d;
    }
    function boxDist(b, x, y, z) {
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
      const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
      const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const f = function (x, y, z) {
      let d = 1e9;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const bd = boxDist(g.box, x, y, z);
        if (bd > d + 6) continue;
        if (g.torso) {
          d = smin(d, evalPrims(g.prims, x, y, z, torsoD(x, y, z)), 2);
        } else {
          if (bd > 40) { d = Math.min(d, bd); continue; }
          d = smin(d, evalPrims(g.prims, x, y, z, 1e9), g.blend);
        }
      }
      return Math.max(d, -y); // flat soles
    };
    f.bounds = spec.bounds;
    return f;
  }

  // Circumference of the body's cross-section at height y around (cx, cz) — used by tests.
  function sliceCircumference(f, y, cx, cz, maxR) {
    const n = 180;
    let per = 0, prev = null, first = null;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const dx = Math.cos(a), dz = Math.sin(a);
      // first exit from the centre (ignores arms / the other leg further out)
      let lo = 0, hi = maxR || 60;
      for (let r = 0.25; r <= hi; r += 0.25) { if (f(cx + dx * r, y, cz + dz * r) >= 0) { hi = r; break; } lo = r; }
      for (let it = 0; it < 20; it++) {
        const m = (lo + hi) / 2;
        if (f(cx + dx * m, y, cz + dz * m) < 0) lo = m; else hi = m;
      }
      const pt = [cx + dx * lo, cz + dz * lo];
      if (prev) per += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
      else first = pt;
      prev = pt;
    }
    return per;
  }

  // ---------------------------------------------------------------------------
  // Surface nets polygoniser
  // ---------------------------------------------------------------------------
  const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const EDGES = [];
  for (let a = 0; a < 8; a++) for (let bit = 1; bit < 8; bit <<= 1) if (!(a & bit)) EDGES.push([a, a | bit]);

  function polygonize(f, bounds, step) {
    const mn = bounds.min;
    const nx = Math.ceil((bounds.max[0] - mn[0]) / step) + 1;
    const ny = Math.ceil((bounds.max[1] - mn[1]) / step) + 1;
    const nz = Math.ceil((bounds.max[2] - mn[2]) / step) + 1;
    const vals = new Float32Array(nx * ny * nz);
    const idx = (i, j, k) => i + nx * (j + ny * k);
    const B = 6;
    const half = (B * step * Math.sqrt(3)) / 2;
    let evals = 0;
    for (let bk = 0; bk < nz; bk += B) {
      for (let bj = 0; bj < ny; bj += B) {
        for (let bi = 0; bi < nx; bi += B) {
          const ie = Math.min(bi + B, nx), je = Math.min(bj + B, ny), ke = Math.min(bk + B, nz);
          const cx = mn[0] + ((bi + ie - 1) / 2) * step, cy = mn[1] + ((bj + je - 1) / 2) * step, cz = mn[2] + ((bk + ke - 1) / 2) * step;
          const dc = f(cx, cy, cz);
          evals++;
          const skip = Math.abs(dc) > half * 1.3 + step * 1.5;
          for (let k = bk; k < ke; k++) for (let j = bj; j < je; j++) for (let i = bi; i < ie; i++) {
            if (skip) vals[idx(i, j, k)] = dc;
            else { vals[idx(i, j, k)] = f(mn[0] + i * step, mn[1] + j * step, mn[2] + k * step); evals++; }
          }
        }
      }
    }
    // vertices
    const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
    const cellV = new Int32Array(cnx * cny * cnz).fill(-1);
    const pos = [];
    const cv = new Float32Array(8);
    for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const o = CORNERS[c];
        const v = vals[idx(i + o[0], j + o[1], k + o[2])];
        cv[c] = v;
        if (v < 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (let e = 0; e < 12; e++) {
        const a = EDGES[e][0], b = EDGES[e][1];
        const va = cv[a], vb = cv[b];
        if ((va < 0) === (vb < 0)) continue;
        const t = va / (va - vb);
        const A = CORNERS[a], Bc = CORNERS[b];
        sx += A[0] + (Bc[0] - A[0]) * t; sy += A[1] + (Bc[1] - A[1]) * t; sz += A[2] + (Bc[2] - A[2]) * t;
        cnt++;
      }
      cellV[i + cnx * (j + cny * k)] = pos.length / 3;
      pos.push(mn[0] + (i + sx / cnt) * step, mn[1] + (j + sy / cnt) * step, mn[2] + (k + sz / cnt) * step);
    }
    // faces
    const ind = [];
    const cell = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= cnx || j >= cny || k >= cnz ? -1 : cellV[i + cnx * (j + cny * k)]);
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) ind.push(a, c, b, a, d, c); else ind.push(a, b, c, a, c, d);
    };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v0 = vals[idx(i, j, k)] < 0;
      if (i < nx - 1 && (vals[idx(i + 1, j, k)] < 0) !== v0) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), v0);
      if (j < ny - 1 && (vals[idx(i, j + 1, k)] < 0) !== v0) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), v0);
      if (k < nz - 1 && (vals[idx(i, j, k + 1)] < 0) !== v0) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), v0);
    }
    // normals from the field gradient
    const positions = new Float32Array(pos);
    const normals = new Float32Array(pos.length);
    const e = step * 0.5;
    for (let v = 0; v < positions.length; v += 3) {
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      const gx = f(x + e, y, z) - f(x - e, y, z);
      const gy = f(x, y + e, z) - f(x, y - e, z);
      const gz = f(x, y, z + e) - f(x, y, z - e);
      const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      normals[v] = gx / l; normals[v + 1] = gy / l; normals[v + 2] = gz / l;
    }
    const indices = positions.length / 3 > 65535 ? new Uint32Array(ind) : new Uint16Array(ind);
    return { positions, normals, indices, evals, grid: [nx, ny, nz] };
  }

  // ---------------------------------------------------------------------------
  // Garment
  // ---------------------------------------------------------------------------
  // A ring: centre c, in-plane unit axes u, w and radii ru, rw.
  const H_U = [1, 0, 0], H_W = [0, 0, 1];
  const hring = (x, y, z, e) => ({ c: [x, y, z], u: H_U, w: H_W, ru: e.rx, rw: e.rz });
  function tubeRing(c, dir, r) {
    const u = norm(sub([1, 0, 0], mul(dir, dot([1, 0, 0], dir))));
    const w = norm(cross(u, dir));
    const wz = w[2] < 0 ? mul(w, -1) : w;
    return { c, u, w: wz, ru: r, rw: r };
  }

  function upsampleRings(rings, spacing) {
    const out = [];
    const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[Math.max(s - 1, 0)], b = rings[s], c = rings[s + 1], d = rings[Math.min(s + 2, rings.length - 1)];
      const n = Math.max(1, Math.ceil(len(sub(c.c, b.c)) / spacing));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const cc = [0, 1, 2].map((k) => cr(a.c[k], b.c[k], c.c[k], d.c[k], t));
        const u = norm(add(mul(b.u, 1 - t), mul(c.u, t)));
        let w = add(mul(b.w, 1 - t), mul(c.w, t));
        w = norm(sub(w, mul(u, dot(w, u))));
        const ru = Math.max(cr(a.ru, b.ru, c.ru, d.ru, t), Math.min(b.ru, c.ru) * 0.9);
        const rw = Math.max(cr(a.rw, b.rw, c.rw, d.rw, t), Math.min(b.rw, c.rw) * 0.9);
        out.push({ c: cc, u, w, ru, rw });
      }
    }
    out.push(rings[rings.length - 1]);
    return out;
  }

  // Sample a ring, drape it over the body (never closer than minGap), record the original gap.
  function drapeRing(r, f, segs, minGap) {
    const pts = new Float32Array(segs * 3);
    const gaps = new Float32Array(segs);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const o = norm(add(mul(r.u, ca * r.rw), mul(r.w, sa * r.ru))); // outward normal of the ellipse
      let p = add(r.c, add(mul(r.u, ca * r.ru), mul(r.w, sa * r.rw)));
      let d = f ? f(p[0], p[1], p[2]) : 10;
      gaps[j] = d;
      // push out along the body's surface normal (field gradient) until clear of the skin
      for (let it = 0; it < 10 && d < minGap; it++) {
        const e = 0.3;
        const g = norm([f(p[0] + e, p[1], p[2]) - f(p[0] - e, p[1], p[2]), f(p[0], p[1] + e, p[2]) - f(p[0], p[1] - e, p[2]), f(p[0], p[1], p[2] + e) - f(p[0], p[1], p[2] - e)]);
        const dir = len(g) > 0.5 ? g : o;
        p = add(p, mul(dir, minGap - d + 0.05));
        d = f(p[0], p[1], p[2]);
      }
      pts[j * 3] = p[0]; pts[j * 3 + 1] = p[1]; pts[j * 3 + 2] = p[2];
    }
    return { pts, gaps };
  }

  function garmentMesh(tube, f, opts) {
    opts = opts || {};
    const segs = opts.segs || 96;
    const rings = upsampleRings(tube.rings, opts.spacing || 1.4);
    const R = rings.length;
    const positions = new Float32Array(R * segs * 3);
    const gaps = new Float32Array(R * segs);
    const tension = new Float32Array(R * segs);
    const zones = tube.tension || [];
    rings.forEach((r, i) => {
      const d = drapeRing(r, f, segs, opts.minGap == null ? 0.35 : opts.minGap);
      positions.set(d.pts, i * segs * 3);
      for (let j = 0; j < segs; j++) {
        const q = i * segs + j;
        gaps[q] = f ? f(d.pts[j * 3], d.pts[j * 3 + 1], d.pts[j * 3 + 2]) : 5;
        let tv = 0;
        zones.forEach((z) => {
          const along = z.ring != null ? Math.abs(i / Math.max(R - 1, 1) - z.ring) * z.span : Math.abs(d.pts[j * 3 + 1] - z.y);
          const wgt = clamp(1 - along / z.range, 0, 1) * (z.status === 'tight' ? 1 : -0.75);
          if (Math.abs(wgt) > Math.abs(tv)) tv = wgt;
        });
        tension[q] = tv;
      }
    });
    const ind = [];
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < segs; j++) {
      const a = i * segs + j, b = i * segs + ((j + 1) % segs), c = (i + 1) * segs + j, d = (i + 1) * segs + ((j + 1) % segs);
      ind.push(a, c, b, b, c, d);
    }
    const rims = (tube.rim || []).map((ri) => {
      const k = ri < 0 ? R + ri : (ri === 0 ? 0 : R - 1);
      return Array.from(positions.subarray(k * segs * 3, (k + 1) * segs * 3));
    });
    return { positions, gaps, tension, indices: R * segs > 65535 ? new Uint32Array(ind) : new Uint16Array(ind), segs, rings: R, rims };
  }

  // Fit-map colour for a fabric-to-skin distance (cm) after draping: touching → loose.
  const HEAT_STOPS = [[0.3, [0.86, 0.95, 0.35]], [1.2, [0.35, 0.95, 0.5]], [3, [0.2, 0.88, 0.85]], [6, [0.25, 0.62, 1.0]], [11, [0.52, 0.42, 1.0]], [18, [0.72, 0.4, 0.95]]];
  const TIGHT_RGB = [1.0, 0.2, 0.32], SNUG_RGB = [1.0, 0.6, 0.18];
  function heatColor(d) {
    if (d <= HEAT_STOPS[0][0]) return HEAT_STOPS[0][1];
    for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
      const [a, ca] = HEAT_STOPS[i], [b, cb] = HEAT_STOPS[i + 1];
      if (d <= b) { const t = (d - a) / (b - a); return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)]; }
    }
    return HEAT_STOPS[HEAT_STOPS.length - 1][1];
  }
  // Colour for one garment vertex: distance colour, pulled toward red / orange where the
  // size check found that area tight / snug and the fabric is in contact with the body.
  function fitColor(gap, tension) {
    const c = heatColor(gap);
    if (!tension) return c;
    const contact = clamp(1 - (gap - 0.3) / 2.5, 0, 1);
    const w = Math.abs(tension) * contact;
    const t = tension > 0 ? TIGHT_RGB : SNUG_RGB;
    return [lerp(c[0], t[0], w), lerp(c[1], t[1], w), lerp(c[2], t[2], w)];
  }

  // ---------------------------------------------------------------------------
  // Model description
  // ---------------------------------------------------------------------------
  function ringAtY(rings, y) {
    if (y >= rings[0].c[1]) return rings[0];
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      if (y <= a.c[1] && y >= b.c[1]) {
        const t = (a.c[1] - y) / ((a.c[1] - b.c[1]) || 1);
        return { c: [lerp(a.c[0], b.c[0], t), y, lerp(a.c[2], b.c[2], t)], u: a.u, w: a.w, ru: lerp(a.ru, b.ru, t), rw: lerp(a.rw, b.rw, t) };
      }
    }
    return rings[rings.length - 1];
  }

  function buildFitModel(result, chart, sizeLabel) {
    const body = result.body;
    const { p, L, H } = body;
    const spec = bodySpec(body);
    const ev = result.evals.find((e) => e.label === sizeLabel) || result.best;
    const type = chart.type;
    const group = (SF.GARMENT_TYPES[type] || {}).group;
    const v = ev.values;
    const g = (k) => SF.mid(v[k]);
    const { chestE, hipE, shoulderHalf, bicepR, handLen } = spec;
    const bodyCirc = (y) => SF.bodyCircAt(body, y);
    const kAt = (y) => (y >= L.chest ? spec.kChest : y >= L.waist ? lerp(spec.kChest, spec.kWaist, (L.chest - y) / (L.chest - L.waist)) : y >= L.hip ? lerp(spec.kWaist, spec.kHip, (L.waist - y) / (L.waist - L.hip)) : spec.kHip);
    const tubes = [];
    const markers = [];
    let torsoG = null, sleeveEnds = [], legG = null, shoulderY = null;

    const armAt = (arm, t) => {
      // point and direction along the arm path (shoulder joint → elbow → wrist → hand)
      if (t <= arm.upper) return { c: add(arm.J, mul(arm.dir, t)), d: arm.dir };
      const tf = t - arm.upper;
      const fl = p.armLength * 0.45;
      if (tf <= fl) return { c: add(arm.E, mul(arm.fdir, tf)), d: arm.fdir };
      return { c: add(arm.W, mul(arm.hdir, tf - fl)), d: arm.hdir };
    };
    const armR = (t) => {
      const A = p.armLength;
      const pts = [[0, bicepR * 1.2], [A * 0.22, bicepR * 1.02], [A * 0.55, bicepR * 0.8], [A * 0.7, bicepR * 0.86], [A, bicepR * 0.55], [A + handLen * 0.4, bicepR * 0.8]];
      if (t <= 0) return pts[0][1];
      for (let i = 0; i < pts.length - 1; i++) if (t <= pts[i + 1][0]) return lerp(pts[i][1], pts[i + 1][1], (t - pts[i][0]) / (pts[i + 1][0] - pts[i][0]));
      return pts[pts.length - 1][1];
    };

    if (group === 'top' || group === 'dress') {
      const gC = g('chest') != null ? g('chest') : p.chest + (type === 'tee' ? 10 : 16);
      const chestEase = gC - p.chest;
      const gSh = g('shoulder') != null ? g('shoulder') : p.shoulder + Math.max(0, chestEase) * 0.15;
      const gsh = (gSh * 0.93) / 2;
      const drop = Math.max(0, gsh - shoulderHalf);
      const length = g('length') != null ? g('length') : 0.4 * H;
      const hemH = Math.max(SF.hemHeightTop(body, length), 1);
      let gHem = g('hem') != null ? g('hem') : gC;
      if (type === 'dress' || type === 'coat') gHem = Math.max(gHem, (g('hip') != null ? g('hip') : p.hip + 10) + (hemH < L.knee ? 24 : 10));
      const kg = (y) => 1 + (kAt(y) - 1) * 0.92;
      const armpitY = L.armpit - drop * 0.5 - Math.max(0, chestEase) * 0.06;
      shoulderY = L.shoulder - drop * 0.5 + 0.8;
      const rings = [
        hring(0, L.hps + 1.2, -1.2, ellipse(p.neck + 5, 1.15)),
        hring(0, lerp(L.hps, L.shoulder, 0.55), -1.2, { rx: lerp(spec.torso[10].rx, Math.max(gsh, shoulderHalf * 0.85), 0.6) + 0.6, rz: chestE.rz * 0.62 }),
        hring(0, shoulderY, -0.8, { rx: Math.max(gsh, spec.armX0 + bicepR * (gsh >= shoulderHalf - 1 ? 0.9 : 0.2)), rz: chestE.rz * 0.86 + Math.max(0, chestEase) * 0.04 }),
        hring(0, armpitY, 0, ellipse(Math.max(gC, p.chest + 1), kg(L.armpit))),
      ];
      const levels = [L.chest, lerp(L.chest, L.waist, 0.5), L.waist, L.pantWaist, L.hip, L.crotch, L.midThigh, L.knee, L.calf].filter((y) => y < armpitY - 2 && y > hemH + 2);
      const span = Math.max(armpitY - hemH, 1);
      levels.forEach((y) => {
        const t = (armpitY - y) / span;
        let Cg = lerp(gC, gHem, type === 'dress' ? Math.pow(t, 1.6) : t);
        if (type === 'dress' && g('waist') != null && Math.abs(y - L.waist) < 0.5) Cg = g('waist');
        if (type === 'dress' && g('hip') != null && Math.abs(y - L.hip) < 0.5) Cg = g('hip');
        rings.push(hring(0, y, y <= L.hip + 1 && y >= L.crotch ? -0.6 : 0, ellipse(Math.max(Cg, bodyCirc(y) + 1), kg(y))));
      });
      rings.push(hring(0, hemH, 0, ellipse(Math.max(gHem, bodyCirc(hemH) + 1), kg(hemH))));
      tubes.push({ rings, rim: [0, -1], part: 'body' });
      torsoG = rings;

      let eff = null;
      if (g('sleeve') != null) eff = g('sleeve') + Math.max(0, (gSh - p.shoulder) / 2);
      else if (g('fullSleeve') != null) eff = g('fullSleeve') / 2 - p.shoulder / 2;
      else if (g('neckSleeve') != null) eff = g('neckSleeve') - p.shoulder / 2 + 2;
      if (eff != null) {
        const tEnd = Math.min(eff + 1.5, p.armLength + handLen * 0.7);
        const tStart = -2.5 + drop * 0.8;
        if (tEnd > tStart + 3) {
          const sleeveEase = g('bicep') != null ? g('bicep') - p.bicep : Math.max(3, chestEase * 0.3);
          const topR = Math.max(bicepR * 1.45, (p.bicep + sleeveEase) / TAU + 0.6);
          const cuffR = g('cuff') != null ? Math.max(armR(tEnd) + 0.5, g('cuff') / TAU) : armR(tEnd) + (eff < p.armLength * 0.6 ? Math.max(1.4, sleeveEase * 0.12) : 0.9);
          spec.arms.forEach((arm) => {
            const sr = [];
            const n = 10;
            for (let i = 0; i <= n; i++) {
              const t = lerp(tStart, tEnd, i / n);
              const at = armAt(arm, Math.max(t, 0));
              const c = t < 0 ? add(arm.J, mul(arm.dir, t)) : at.c;
              const r = Math.max(lerp(topR, cuffR, Math.pow(i / n, 0.8)), armR(Math.max(t, 0)) + 0.5);
              sr.push(tubeRing(c, at.d, r));
            }
            tubes.push({ rings: sr, rim: [-1], part: 'sleeve' });
            sleeveEnds.push(sr[sr.length - 1]);
          });
        }
      }
    } else if (group === 'bottom') {
      const w = v.waist;
      const elastic = w && w.elastic;
      const gW = elastic ? p.pantWaist + 1 : Math.max(g('waist') != null ? g('waist') : p.pantWaist + 2, p.pantWaist + 0.5);
      const gH = Math.max(g('hip') != null ? g('hip') : p.hip + 6, p.hip + 0.5);
      let hemH;
      if (g('inseam') != null) hemH = L.crotch - g('inseam');
      else if (g('outseam') != null) hemH = L.pantWaist - g('outseam');
      else if (g('skirtLength') != null) hemH = L.pantWaist - g('skirtLength');
      else hemH = type === 'shorts' ? L.knee + 8 : type === 'skirt' ? L.knee : 3;
      const extra = Math.max(0, -hemH);
      const hemY = Math.max(hemH, 0.8);
      const upper = [
        hring(0, L.pantWaist + 1.5, 0, ellipse(gW, spec.kWaist)),
        hring(0, L.pantWaist - 4, 0, ellipse(Math.max(gW, bodyCirc(L.pantWaist - 4) + 1), spec.kWaist)),
        hring(0, L.hip, -0.6, ellipse(gH, spec.kHip)),
      ];
      if (type === 'skirt') {
        upper.push(hring(0, hemY, 0, ellipse(Math.max(gH + 12, bodyCirc(hemY) + 6), 1.3)));
        tubes.push({ rings: upper, rim: [0, -1], part: 'body' });
        torsoG = upper;
      } else {
        let crotchG = L.crotch - 1;
        if (g('rise') != null) crotchG = Math.min(L.crotch - 0.5, L.pantWaist - (g('rise') - 3));
        const hipG = ellipse(gH, spec.kHip);
        upper.push(hring(0, crotchG + 2, -0.4, { rx: hipG.rx * 0.96, rz: hipG.rz * 0.86 }));
        tubes.push({ rings: upper, rim: [0], part: 'body' });
        torsoG = upper;
        const gThigh = Math.max(g('thigh') != null ? g('thigh') : p.thigh + Math.max(4, (gH - p.hip) * 0.6), p.thigh + 1);
        const gOpen = g('legOpening') != null ? g('legOpening') : type === 'shorts' ? gThigh * 0.92 : Math.max(gThigh * 0.66, p.thigh * 0.4 + 10);
        const gKnee = g('knee') != null ? g('knee') : null;
        legG = [];
        spec.legs.forEach((leg) => {
          const s = leg.side;
          const legCenter = (y) => {
            if (y >= leg.K[1]) return lerp(leg.K[0], leg.J[0], (y - leg.K[1]) / (leg.J[1] - leg.K[1]));
            return lerp(leg.A[0], leg.K[0], (y - leg.A[1]) / (leg.K[1] - leg.A[1]));
          };
          const ys = [crotchG + 5, crotchG - 3, (crotchG + Math.max(L.knee, hemY)) / 2, L.knee, (L.knee + L.calf) / 2, L.calf, L.ankle + 5].filter((y, i) => i < 2 || (y > hemY + 2 && y < crotchG - 4));
          if (extra > 0.5) ys.push(Math.min(7, hemY + 5), Math.min(4, hemY + 2.8));
          ys.push(hemY);
          const lr = ys.map((y, i) => {
            const t = clamp((crotchG - 3 - y) / Math.max(crotchG - 3 - hemY, 1), 0, 1);
            let Cg = lerp(gThigh, gOpen, Math.pow(t, 0.9));
            if (gKnee != null && Math.abs(y - L.knee) < 0.5) Cg = gKnee;
            if (extra > 0.5 && y < 8 && i >= ys.length - 3) Cg *= 1.14; // stacking at the ankle
            const x = y >= crotchG - 3 ? s * Math.max(Math.abs(legCenter(y)), hipG.rx * 0.45) : legCenter(Math.max(y, 3));
            return hring(x, y, y < L.knee ? -0.4 : 0, ellipse(Cg, 1.06));
          });
          tubes.push({ rings: lr, rim: [-1], part: 'leg' });
          legG.push(lr);
        });
      }
    }

    // tension zones: where the size check found the garment tight / snug
    const statusOf = (k) => { const it = ev.items.find((x) => x.key === k); return it && (it.status === 'tight' || it.status === 'snug') ? it.status : null; };
    const zone = (k, y, range) => { const st = statusOf(k); return st ? [{ y, range, status: st }] : []; };
    tubes.forEach((t) => {
      if (t.part === 'body' && (group === 'top' || group === 'dress')) {
        t.tension = [].concat(zone('chest', L.chest, 9), zone('shoulder', shoulderY, 6), zone('waist', L.waist, 7), zone('hip', L.hip, 8), zone('hem', L.hip, 8));
      } else if (t.part === 'body' && group === 'bottom') {
        t.tension = [].concat(zone('waist', L.pantWaist, 6), zone('hip', L.hip, 9));
      } else if (t.part === 'leg') {
        t.tension = zone('thigh', L.crotch - 4, 10);
      } else if (t.part === 'sleeve') {
        const st = statusOf('bicep') || (statusOf('shoulder') === 'tight' ? 'snug' : null);
        t.tension = st ? [{ ring: 0, span: 30, range: 10, status: st }] : [];
      }
    });

    // markers: ring specs placed on the garment (draped by the viewer)
    const addRing = (it, r, grow) => r && markers.push({ key: it.key, status: it.status, item: it, ring: Object.assign({}, r, { ru: r.ru + (grow || 0.5), rw: r.rw + (grow || 0.5) }) });
    ev.items.forEach((it) => {
      if (torsoG && (group === 'top' || group === 'dress')) {
        if (it.key === 'chest') addRing(it, ringAtY(torsoG, L.chest));
        else if (it.key === 'waist') addRing(it, ringAtY(torsoG, L.waist));
        else if (it.key === 'hip' || it.key === 'hem') addRing(it, ringAtY(torsoG, Math.max(L.hip, torsoG[torsoG.length - 1].c[1] + 1)));
        else if (it.key === 'length') addRing(it, torsoG[torsoG.length - 1], 0.6);
        else if (it.key === 'shoulder') addRing(it, ringAtY(torsoG, shoulderY - 0.5), 0.6);
        else if (it.key === 'sleeve' && sleeveEnds[0]) addRing(it, sleeveEnds[0], 0.6);
      } else if (torsoG && group === 'bottom') {
        if (it.key === 'waist') addRing(it, torsoG[0], 0.6);
        else if (it.key === 'hip') addRing(it, ringAtY(torsoG, L.hip));
        else if (it.key === 'thigh' && legG) addRing(it, legG[0][1]);
        else if ((it.key === 'outseam' || it.key === 'inseam') && legG) addRing(it, legG[0][legG[0].length - 1], 0.6);
        else if (it.key === 'skirtLength') addRing(it, torsoG[torsoG.length - 1], 0.6);
      }
    });

    return {
      H, sizeLabel: ev.label, score: ev.score, group, type,
      bodyKey: JSON.stringify([p, body.fem]),
      spec,
      garment: { tubes },
      markers,
    };
  }

  // ---------------------------------------------------------------------------
  // three.js viewer — clinical body-scan presentation
  // ---------------------------------------------------------------------------
  function webglAvailable() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  const BODY_VS = `
    varying vec3 vN; varying vec3 vW;
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  const BODY_FS = `
    uniform vec3 uBase; uniform vec3 uRim; uniform vec3 uKey; uniform float uScanY; uniform float uScan; uniform float uLines;
    varying vec3 vN; varying vec3 vW;
    void main() {
      vec3 n = normalize(vN);
      vec3 V = normalize(cameraPosition - vW);
      vec3 Lk = normalize(uKey);
      float ndl = max(dot(n, Lk), 0.0);
      float hemi = 0.5 + 0.5 * n.y;
      float fr = pow(1.0 - max(dot(n, V), 0.0), 2.4);
      float spec = pow(max(dot(reflect(-Lk, n), V), 0.0), 36.0);
      vec3 col = uBase * (0.28 + 0.34 * hemi + 0.55 * ndl) + vec3(0.9, 0.97, 1.0) * spec * 0.22;
      // subsurface-like warm wrap
      col += uBase * vec3(1.0, 0.55, 0.45) * pow(max(dot(-n, Lk) * 0.5 + 0.5, 0.0), 3.0) * 0.08;
      col += uRim * fr * 0.85;
      float c = vW.y / 2.0;
      float l = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), 1e-4);
      col += uRim * (1.0 - min(l, 1.0)) * 0.10 * uLines;
      float s = exp(-pow((vW.y - uScanY) / 1.1, 2.0)) * uScan;
      col += vec3(0.45, 0.95, 1.0) * s * 0.9;
      gl_FragColor = vec4(col, 1.0);
    }`;
  const CLOTH_VS = `
    attribute vec3 heat;
    varying vec3 vN; varying vec3 vW; varying vec3 vH;
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); vH = heat;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  const CLOTH_FS = `
    uniform vec3 uFabric; uniform float uHeat; uniform vec3 uKey; uniform float uScanY; uniform float uScan; uniform float uAlpha;
    varying vec3 vN; varying vec3 vW; varying vec3 vH;
    void main() {
      vec3 n = normalize(vN);
      vec3 V = normalize(cameraPosition - vW);
      if (dot(n, V) < 0.0) n = -n;
      float ndl = max(dot(n, normalize(uKey)), 0.0);
      float fr = pow(1.0 - max(dot(n, V), 0.0), 2.0);
      vec3 base = mix(uFabric, vH, uHeat);
      vec3 col = base * (0.45 + 0.55 * ndl) + base * fr * 0.9;
      float c = vW.y / 3.0;
      float l = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), 1e-4);
      float line = 1.0 - min(l, 1.0);
      float s = exp(-pow((vW.y - uScanY) / 1.4, 2.0)) * uScan;
      col += vec3(0.6, 1.0, 1.0) * s * 0.6;
      float a = uAlpha + fr * 0.45 + line * 0.18 + s * 0.3;
      gl_FragColor = vec4(col + base * line * 0.35, clamp(a, 0.0, 0.92));
    }`;
  const FLOOR_FS = `
    varying vec2 vUv; uniform float uTime;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      if (r > 1.0) discard;
      float ring = 0.0;
      for (int i = 1; i <= 6; i++) {
        float rr = float(i) / 6.0;
        ring += (1.0 - smoothstep(0.0, 0.006, abs(r - rr))) * (i == 6 ? 0.9 : 0.35);
      }
      float ang = atan(p.y, p.x);
      float spokes = (1.0 - smoothstep(0.0, 0.012, abs(fract(ang / 6.2831853 * 36.0) - 0.5) * 2.0 * r * 0.18)) * step(0.5, r) * 0.25;
      float sweep = pow(max(cos(ang - uTime * 0.8), 0.0), 40.0) * smoothstep(1.0, 0.2, r) * 0.35;
      float glow = (1.0 - r) * 0.18;
      vec3 col = vec3(0.22, 0.85, 1.0);
      float a = clamp(ring * 0.55 + spokes + sweep + glow, 0.0, 1.0) * (1.0 - smoothstep(0.92, 1.0, r) * 0.3);
      gl_FragColor = vec4(col * a, a);
    }`;
  const FLOOR_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

  const SKIN_TINT = { mannequin: [0.58, 0.68, 0.76], light: [0.86, 0.72, 0.64], medium: [0.74, 0.55, 0.42], tan: [0.6, 0.42, 0.3], deep: [0.4, 0.27, 0.2] };

  function Fit3D(container, opts) {
    const THREE = window.THREE;
    if (!THREE) throw new Error('three.js not loaded');
    opts = opts || {};
    this.THREE = THREE;
    this.container = container;
    container.classList.add('fit3d');
    container.innerHTML = '';

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('role', 'img');
    this.renderer = renderer;

    // HUD
    const hud = document.createElement('div');
    hud.className = 'scan-hud';
    hud.innerHTML = `
      <div class="hud-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="hud-tl"><div class="hud-kicker">SizeFit · 3D fit scan</div><div class="hud-size"></div><div class="hud-sub"></div></div>
      <div class="hud-tr"><svg viewBox="0 0 64 64" class="hud-gauge" aria-hidden="true"><circle cx="32" cy="32" r="27" class="g-bg"/><circle cx="32" cy="32" r="27" class="g-fg"/></svg><div class="hud-score"><b></b><span>fit score</span></div></div>
      <div class="hud-bl"></div>
      <div class="hud-legend"><div class="hud-legend-row"><div class="hud-legend-t">Fabric-to-skin distance</div><div class="hud-key"></div></div><div class="hud-bar"></div><div class="hud-ticks"></div></div>
      <svg class="hud-lines" aria-hidden="true"></svg>
      <div class="hud-labels"></div>
      <div class="hud-busy">Building body scan…</div>`;
    container.appendChild(hud);
    this.hud = hud;
    this.labelsEl = hud.querySelector('.hud-labels');
    this.linesEl = hud.querySelector('.hud-lines');

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(26, 3 / 4, 10, 3000);
    this.camera = camera;
    scene.add(camera);

    // scanner platform + scan ring
    this.uTime = { value: 0 };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), new THREE.ShaderMaterial({
      vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, uniforms: { uTime: this.uTime }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.02;
    scene.add(floor);
    const ringGeo = new THREE.TorusGeometry(46, 0.18, 6, 160);
    this.scanRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scanRing.rotation.x = Math.PI / 2;
    scene.add(this.scanRing);
    this.scanDisc = new THREE.Mesh(new THREE.CircleGeometry(46, 96), new THREE.MeshBasicMaterial({ color: 0x2fbfff, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.scanDisc.rotation.x = -Math.PI / 2;
    scene.add(this.scanDisc);

    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = {
      uKey: { value: new THREE.Vector3(0.4, 0.6, 1) },
      uScanY: { value: -100 },
      uScan: { value: 1 },
    };

    this.angle = 0.45;
    this.elev = 0.06;
    this.zoom = 1;
    this.paused = !!opts.paused;
    this.scanOn = !opts.paused;
    this.speed = 0.25;
    this.markerObjs = [];
    this._disp = [];
    this._bodyCache = null;
    this._time = 0;
    this._last = performance.now();
    this._bindControls();
    this._resize = () => this.resize();
    if (window.ResizeObserver) { this._ro = new ResizeObserver(this._resize); this._ro.observe(container); }
    window.addEventListener('resize', this._resize);
    this.resize();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  Fit3D.prototype._bindControls = function () {
    const el = this.renderer.domElement;
    let drag = null;
    el.style.touchAction = 'pan-y';
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, a: this.angle, el: this.elev, wasPaused: this.paused }; this.paused = true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.angle = drag.a - (e.clientX - drag.x) * 0.012;
      this.elev = Math.max(-0.25, Math.min(0.6, drag.el + (e.clientY - drag.y) * 0.004));
    });
    const end = () => { if (drag) { this.paused = drag.wasPaused; drag = null; } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(0.45, Math.min(1.4, this.zoom * (e.deltaY > 0 ? 1.08 : 0.93))); }, { passive: false });
  };

  Fit3D.prototype.resize = function () {
    const w = this.container.clientWidth || 400;
    const h = Math.round(w * (w < 560 ? 1.4 : 1.15));
    this.container.style.height = h + 'px';
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.compact = w < 560;
    if (!this.compact) this.camera.setViewOffset(w, h, Math.round(w * 0.12), 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.width = w; this.height = h;
    this.linesEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.hud.classList.toggle('compact', this.compact);
  };

  Fit3D.prototype._track = function (x) { this._disp.push(x); return x; };

  Fit3D.prototype._bodyMesh = function (model, opts) {
    const THREE = this.THREE;
    const key = model.bodyKey;
    if (this._bodyCache && this._bodyCache.key === key) return this._bodyCache;
    if (this._bodyCache) { this._bodyCache.geo.dispose(); this._bodyCache.mat.dispose(); }
    const f = makeBodySDF(model.spec);
    const mesh = polygonize(f, model.spec.bounds, this.compact ? 0.95 : 0.8);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: BODY_VS, fragmentShader: BODY_FS, side: THREE.DoubleSide,
      uniforms: { uBase: { value: new THREE.Vector3() }, uRim: { value: new THREE.Vector3(0.3, 0.85, 1.0) }, uLines: { value: 1 }, uKey: this.uniforms.uKey, uScanY: this.uniforms.uScanY, uScan: this.uniforms.uScan },
      extensions: { derivatives: true },
    });
    this._bodyCache = { key, f, geo, mat, tris: mesh.indices.length / 3 };
    return this._bodyCache;
  };

  Fit3D.prototype.show = function (model, opts) {
    opts = opts || {};
    this.model = model;
    this.opts = opts;
    const needsBody = !this._bodyCache || this._bodyCache.key !== model.bodyKey;
    if (needsBody) {
      this.hud.classList.add('busy');
      clearTimeout(this._buildTimer);
      this._buildTimer = setTimeout(() => this._build(model, opts), 30);
    } else this._build(model, opts);
  };

  Fit3D.prototype._build = function (model, opts) {
    const THREE = this.THREE;
    this.clear();
    const body = this._bodyMesh(model, opts);
    const tint = SKIN_TINT[opts.skin] || SKIN_TINT.mannequin;
    body.mat.uniforms.uBase.value.set(tint[0], tint[1], tint[2]);
    this.group.add(new THREE.Mesh(body.geo, body.mat));
    const f = body.f;

    // garment
    const clothMat = this._track(new THREE.ShaderMaterial({
      vertexShader: CLOTH_VS, fragmentShader: CLOTH_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uFabric: { value: new THREE.Color(model.group === 'bottom' ? '#3f6fd8' : model.group === 'dress' ? '#c25bb0' : '#3aa0e8') }, uHeat: { value: this.heatMode === false ? 0 : 1 }, uAlpha: { value: 0.3 }, uKey: this.uniforms.uKey, uScanY: this.uniforms.uScanY, uScan: this.uniforms.uScan },
      extensions: { derivatives: true },
    }));
    this.clothMat = clothMat;
    const rimMat = this._track(new THREE.MeshBasicMaterial({ color: 0xbff4ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    model.garment.tubes.forEach((tube) => {
      const gm = garmentMesh(tube, f, { segs: 112 });
      const geo = this._track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.BufferAttribute(gm.positions, 3));
      const heat = new Float32Array(gm.gaps.length * 3);
      for (let i = 0; i < gm.gaps.length; i++) { const c = fitColor(gm.gaps[i], gm.tension[i]); heat[i * 3] = c[0]; heat[i * 3 + 1] = c[1]; heat[i * 3 + 2] = c[2]; }
      geo.setAttribute('heat', new THREE.BufferAttribute(heat, 3));
      geo.setIndex(new THREE.BufferAttribute(gm.indices, 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, clothMat);
      mesh.renderOrder = 2;
      this.group.add(mesh);
      gm.rims.forEach((pts) => {
        const vs = [];
        for (let i = 0; i < pts.length; i += 3) vs.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
        const tg = this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(vs, true), 160, 0.16, 6, true));
        const t = new THREE.Mesh(tg, rimMat);
        t.renderOrder = 3;
        this.group.add(t);
      });
    });

    // measurement bands
    this.labelsEl.innerHTML = '';
    this.linesEl.innerHTML = '';
    const units = opts.units || 'in';
    this.markerObjs = model.markers.map((mk) => {
      const color = STATUS_COLORS[mk.status] || STATUS_COLORS.info;
      const d = drapeRing(mk.ring, f, 96, 0.9);
      const pts = [];
      for (let i = 0; i < d.pts.length; i += 3) pts.push(new THREE.Vector3(d.pts[i], d.pts[i + 1], d.pts[i + 2]));
      const curve = new THREE.CatmullRomCurve3(pts, true);
      const core = new THREE.Mesh(this._track(new THREE.TubeGeometry(curve, 192, 0.22, 6, true)), this._track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })));
      const glow = new THREE.Mesh(this._track(new THREE.TubeGeometry(curve, 192, 0.85, 8, true)), this._track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })));
      core.renderOrder = glow.renderOrder = 4;
      this.group.add(glow); this.group.add(core);
      const def = SF.MEASURE_DEFS[mk.key] || { label: mk.key, zh: '' };
      const it = mk.item;
      const value = it.kind === 'ease' && it.diff != null ? (it.diff >= 0 ? '+' : '−') + SF.fmtLen(Math.abs(it.diff), units) : it.kind === 'elastic' ? 'elastic' : SF.fmtLen(it.garment, units);
      const lab = document.createElement('div');
      lab.className = 'hud-label';
      lab.style.setProperty('--c', color);
      lab.innerHTML = `<div class="hl-top"><span class="hl-name">${esc(def.label)}</span><span class="hl-val">${esc(value)}</span></div><div class="hl-verdict">${esc(it.verdict)}</div>`;
      this.labelsEl.appendChild(lab);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('stroke', color);
      this.linesEl.appendChild(line);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '3.2'); dot.setAttribute('fill', color);
      this.linesEl.appendChild(dot);
      return { pts, lab, line, dot, color, title: def.label, value, verdict: it.verdict };
    });

    this._hudText(model, opts);
    this.H = model.H;
    this.hud.classList.remove('busy');
    this.renderer.domElement.setAttribute('aria-label', `3D body scan wearing size ${model.sizeLabel}, fit score ${model.score} out of 100`);
    this._frame(0);
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  Fit3D.prototype._hudText = function (model, opts) {
    const h = this.hud;
    const units = opts.units || 'in';
    h.querySelector('.hud-size').textContent = model.sizeLabel;
    h.querySelector('.hud-sub').textContent = opts.subtitle || (SF.GARMENT_TYPES[model.type] || {}).label || '';
    const score = model.score;
    const col = score >= 85 ? STATUS_COLORS.ok : score >= 70 ? '#9be36a' : score >= 50 ? STATUS_COLORS.snug : STATUS_COLORS.tight;
    const fg = h.querySelector('.g-fg');
    const circ = 2 * Math.PI * 27;
    fg.style.stroke = col;
    fg.style.strokeDasharray = `${(circ * score) / 100} ${circ}`;
    h.querySelector('.hud-score b').textContent = score;
    h.querySelector('.hud-score b').style.color = col;
    const p = opts.profile || {};
    const rows = [['Height', p.height ? (units === 'in' ? SF.fmtHeightImperial(p.height) : Math.round(p.height) + ' cm') : '–'], ['Chest', SF.fmtLen(p.chest, units)], ['Waist', SF.fmtLen(p.waist, units)], ['Hips', SF.fmtLen(p.hip, units)]];
    h.querySelector('.hud-bl').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('') + '<div class="hud-az"><span>View</span><b>000°</b></div>';
    this.azEl = h.querySelector('.hud-az b');
    const ticks = units === 'in' ? [[0.3, 'touching'], [2.54, '1″'], [5.08, '2″'], [10.16, '4″'], [15.24, '6″+']] : [[0.3, 'touching'], [2.5, '2.5'], [5, '5'], [10, '10'], [15, '15+ cm']];
    const minD = HEAT_STOPS[0][0], maxD = 16;
    const grad = [];
    for (let i = 0; i <= 12; i++) { const d = lerp(minD, maxD, i / 12); const c = heatColor(d); grad.push(`rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}) ${Math.round((i / 12) * 100)}%`); }
    h.querySelector('.hud-bar').style.background = `linear-gradient(90deg, ${grad.join(',')})`;
    h.querySelector('.hud-ticks').innerHTML = ticks.map(([d, t], i) => `<span style="left:${(((d - minD) / (maxD - minD)) * 100).toFixed(1)}%${i === 0 ? ';transform:none' : i === ticks.length - 1 ? ';transform:translateX(-100%)' : ''}">${t}</span>`).join('');
    h.querySelector('.hud-key').innerHTML = `<span><i style="background:rgb(255,51,82)"></i>too tight</span><span><i style="background:rgb(255,153,46)"></i>snug</span>`;
  };

  Fit3D.prototype.clear = function () {
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    this._disp.forEach((x) => x.dispose());
    this._disp = [];
    this.markerObjs = [];
  };

  Fit3D.prototype.setPaused = function (p) { this.paused = p; this.scanOn = !p; };
  Fit3D.prototype.setHeat = function (on) { this.heatMode = on; if (this.clothMat) this.clothMat.uniforms.uHeat.value = on ? 1 : 0; };
  Fit3D.prototype.setView = function (name) {
    const a = { front: 0, side: Math.PI / 2, back: Math.PI, angle: 0.6 }[name];
    if (a != null) { this.angle = a; this.elev = 0.06; this.paused = true; }
  };

  Fit3D.prototype._frame = function (dt) {
    this._time += dt;
    if (!this.paused) this.angle += this.speed * dt;
    const H = this.H || 175;
    const target = new this.THREE.Vector3(0, H * 0.5, 0);
    const dist = (H * 0.6 / Math.tan((this.camera.fov * Math.PI) / 360)) * this.zoom;
    const cx = Math.sin(this.angle) * dist * Math.cos(this.elev), cz = Math.cos(this.angle) * dist * Math.cos(this.elev);
    this.camera.position.set(cx, target.y + Math.sin(this.elev) * dist, cz);
    this.camera.lookAt(target);
    // key light from the camera's upper left
    this.uniforms.uKey.value.set(cx * 0.6 - cz * 0.4, dist * 0.7, cz * 0.6 + cx * 0.4).normalize();
    // scanning beam sweeps up and down
    const period = 7;
    const ph = (this._time % period) / period;
    const sy = (ph < 0.5 ? ph * 2 : 2 - ph * 2) * (H + 4) - 2;
    const on = this.scanOn ? 1 : 0;
    this.uniforms.uScanY.value = sy;
    this.uniforms.uScan.value = on;
    this.scanRing.position.y = sy; this.scanDisc.position.y = sy;
    this.scanRing.visible = this.scanDisc.visible = !!on;
    this.uTime.value = this._time;
    this.renderer.render(this.scene, this.camera);
    this._placeLabels();
    if (this.azEl) { const deg = ((((this.angle * 180) / Math.PI) % 360) + 360) % 360; this.azEl.textContent = String(Math.round(deg)).padStart(3, '0') + '°'; }
  };

  Fit3D.prototype._placeLabels = function () {
    const W = this.width, Hh = this.height;
    const v = new this.THREE.Vector3();
    const ms = this.markerObjs;
    ms.forEach((m) => {
      let best = null;
      for (let i = 0; i < m.pts.length; i += 2) {
        v.copy(m.pts[i]).project(this.camera);
        const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * Hh;
        if (!best || sx > best.x) best = { x: sx, y: sy };
      }
      m.anchor = best;
    });
    const labelW = this.compact ? Math.min(150, W * 0.42) : 210;
    const x0 = W - labelW - (this.compact ? 8 : 18);
    const sorted = ms.slice().sort((a, b) => a.anchor.y - b.anchor.y);
    const gap = this.compact ? 40 : 52;
    let y = this.compact ? 84 : 96;
    sorted.forEach((m) => { m.ly = Math.max(m.anchor.y - 18, y); y = m.ly + gap; });
    const over = y - (Hh - (this.compact ? 70 : 84));
    if (over > 0) sorted.forEach((m) => { m.ly -= over; });
    sorted.forEach((m) => {
      m.lx = x0;
      m.lab.style.width = labelW + 'px';
      m.lab.style.transform = `translate(${Math.round(x0)}px, ${Math.round(m.ly)}px)`;
      const ax = m.anchor.x, ay = m.anchor.y, ex = x0 - 4, ey = m.ly + 13;
      const mx = Math.max(ax + 14, ex - 26);
      m.line.setAttribute('d', `M${ax.toFixed(1)},${ay.toFixed(1)} L${mx.toFixed(1)},${ey.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`);
      m.dot.setAttribute('cx', ax.toFixed(1)); m.dot.setAttribute('cy', ay.toFixed(1));
    });
  };

  Fit3D.prototype._loop = function (now) {
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (!document.hidden && this.model && !this.hud.classList.contains('busy')) this._frame(dt);
    this._raf = requestAnimationFrame(this._loop);
  };

  // PNG of the current view, with the HUD drawn in.
  Fit3D.prototype.snapshot = function () {
    this._frame(0);
    const src = this.renderer.domElement;
    const s = src.width / this.width;
    const W = this.width, Hh = this.height;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.scale(s, s);
    const bg = ctx.createRadialGradient(W / 2, Hh * 0.45, 10, W / 2, Hh * 0.5, Math.max(W, Hh) * 0.75);
    bg.addColorStop(0, '#0f2740'); bg.addColorStop(1, '#040a12');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, Hh);
    ctx.drawImage(src, 0, 0, W, Hh);
    ctx.fillStyle = '#7fdcff'; ctx.font = '600 11px ui-monospace, Menlo, monospace';
    ctx.fillText('SIZEFIT · 3D FIT SCAN', 18, 28);
    ctx.fillStyle = '#ffffff'; ctx.font = '700 34px system-ui, sans-serif';
    ctx.fillText(this.model.sizeLabel, 18, 64);
    ctx.font = '600 13px system-ui, sans-serif'; ctx.fillStyle = '#cfe6ff';
    ctx.fillText('Fit score ' + this.model.score + '/100', 18, 86);
    this.markerObjs.forEach((m) => {
      if (m.lx == null) return;
      ctx.strokeStyle = m.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.anchor.x, m.anchor.y); ctx.lineTo(m.lx - 4, m.ly + 13); ctx.stroke();
      ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(m.anchor.x, m.anchor.y, 3, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(6,18,32,0.82)'; ctx.fillRect(m.lx, m.ly, 200, 40);
      ctx.fillStyle = m.color; ctx.fillRect(m.lx, m.ly, 3, 40);
      ctx.fillStyle = '#ffffff'; ctx.font = '600 12px system-ui, sans-serif'; ctx.fillText(m.title + '  ' + m.value, m.lx + 10, m.ly + 16);
      ctx.fillStyle = m.color; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(m.verdict.slice(0, 34), m.lx + 10, m.ly + 32);
    });
    return c.toDataURL('image/png');
  };

  Fit3D.prototype.dispose = function () {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._buildTimer);
    if (this._ro) this._ro.disconnect();
    window.removeEventListener('resize', this._resize);
    this.clear();
    if (this._bodyCache) { this._bodyCache.geo.dispose(); this._bodyCache.mat.dispose(); }
    this.renderer.dispose();
    this.container.classList.remove('fit3d');
    this.container.style.height = '';
  };

  return {
    buildFitModel, Fit3D, webglAvailable,
    bodySpec, makeBodySDF, polygonize, garmentMesh, upsampleRings, drapeRing, sliceCircumference, heatColor, fitColor,
    ellipse3d: ellipse, circumference3d: circumference,
  };
});
