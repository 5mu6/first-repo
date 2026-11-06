/*
 * SizeFit 3D: a rotating 3D figure built from the user's measurements,
 * wearing one size of a garment as a semi-transparent shell.
 *
 *   buildFitModel(result, chart, sizeLabel) → plain description (rings, ellipsoids,
 *     markers); no WebGL needed, so it can be tested in Node.
 *   new Fit3D(container) → three.js viewer (needs window.THREE, r128+).
 *
 * World units are centimetres; y is height above the floor, z points forward.
 */
(function (root, factory) {
  const core = (typeof module === 'object' && module.exports) ? require('./sizefit-core.js') : root.SizeFit;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SizeFit = Object.assign(root.SizeFit || {}, api);
})(typeof self !== 'undefined' ? self : this, function (SF) {
  'use strict';

  const STATUS_COLORS = { tight: '#d23a2f', snug: '#e0901c', ok: '#1f9a62', loose: '#2f6fc0', big: '#6c45b8', info: '#7a7a7a' };
  const SKIN = { mannequin: '#d9cfc2', light: '#f0d3bd', medium: '#d4a17a', tan: '#b07a52', deep: '#6f4630' };
  const GARMENT = { top: '#3f78c2', dress: '#a2508e', bottom: '#2c4a78' };

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const TAU = Math.PI * 2;

  // Ellipse (half-width rx, half-depth rz) with circumference C and width/depth ratio k.
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
  const ring = (x, y, z, e) => ({ x, y, z, rx: e.rx, rz: e.rz });

  // Interpolate a ring list (ordered top → bottom) at height y.
  function ringAt(rings, y) {
    if (!rings.length) return null;
    if (y >= rings[0].y) return rings[0];
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      if (y <= a.y && y >= b.y) {
        const t = (a.y - y) / ((a.y - b.y) || 1);
        return { x: lerp(a.x, b.x, t), y, z: lerp(a.z, b.z, t), rx: lerp(a.rx, b.rx, t), rz: lerp(a.rz, b.rz, t) };
      }
    }
    return rings[rings.length - 1];
  }

  function ellipsePoints(r, n, scale) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      pts.push([r.x + Math.cos(a) * r.rx * scale, r.y, r.z + Math.sin(a) * r.rz * scale]);
    }
    return pts;
  }

  // ---------------------------------------------------------------------------
  // Model description
  // ---------------------------------------------------------------------------
  function buildFitModel(result, chart, sizeLabel) {
    const body = result.body;
    const { p, L, H } = body;
    const fem = body.fem;
    const ev = result.evals.find((e) => e.label === sizeLabel) || result.best;
    const type = chart.type;
    const group = (SF.GARMENT_TYPES[type] || {}).group;
    const v = ev.values;
    const g = (k) => SF.mid(v[k]);

    const kChest = fem ? 1.3 : 1.42, kWaist = 1.3, kHip = fem ? 1.4 : 1.33;
    const kAt = (y) => (y >= L.chest ? kChest : y >= L.waist ? lerp(kChest, kWaist, (L.chest - y) / (L.chest - L.waist)) : y >= L.hip ? lerp(kWaist, kHip, (L.waist - y) / (L.waist - L.hip)) : kHip);

    const chestE = ellipse(p.chest, kChest);
    const waistE = ellipse(p.waist, kWaist);
    const pwE = ellipse(p.pantWaist, kWaist);
    const hipE = ellipse(p.hip, kHip);
    const shoulderHalf = (p.shoulder * 0.93) / 2;
    const bicepR = p.bicep / TAU;
    const armAngle = (13 * Math.PI) / 180;
    const handLen = 0.108 * H;

    // ---- body ---------------------------------------------------------------
    const bodyLofts = [];
    const ellipsoids = [];
    const torso = [
      ring(0, L.chin - 1, -1, ellipse(p.neck, 1.05)),
      ring(0, L.hps, -1, ellipse(p.neck * 1.1, 1.1)),
      ring(0, L.shoulder + 0.5, -0.5, { rx: Math.max(shoulderHalf - bicepR * 0.55, chestE.rx * 0.98), rz: chestE.rz * 0.78 }),
      ring(0, L.armpit, 0, { rx: chestE.rx * 1.0, rz: chestE.rz * 0.95 }),
      ring(0, L.chest, fem ? 0.8 : 0, chestE),
      ring(0, L.waist, 0, waistE),
      ring(0, L.pantWaist, 0, pwE),
      ring(0, L.hip, -0.8, hipE),
      ring(0, L.crotch + 2, -0.5, { rx: hipE.rx * 0.93, rz: hipE.rz * 0.8 }),
      ring(0, L.crotch - 1, 0, { rx: hipE.rx * 0.45, rz: hipE.rz * 0.35 }),
    ];
    bodyLofts.push({ rings: torso, closeBottom: true });

    // legs
    const thighE = ellipse(p.thigh, 1.08);
    const legX0 = Math.max(hipE.rx * 0.97 - thighE.rx, thighE.rx * 0.9);
    const legX = (y) => (y >= L.crotch ? legX0 : y >= L.knee ? lerp(legX0, legX0 * 0.86, (L.crotch - y) / (L.crotch - L.knee)) : lerp(legX0 * 0.86, legX0 * 0.8, (L.knee - y) / L.knee));
    const legCirc = (y) => {
      const pts = [[L.crotch + 3, p.thigh * 1.03], [L.crotch - 4, p.thigh], [L.midThigh, p.thigh * 0.84], [L.knee, p.thigh * 0.66], [L.calf + 5, p.thigh * 0.66], [L.ankle + 3, p.thigh * 0.4], [L.ankle, p.thigh * 0.38], [3, p.thigh * 0.38]];
      if (y >= pts[0][0]) return pts[0][1];
      for (let i = 0; i < pts.length - 1; i++) {
        if (y <= pts[i][0] && y >= pts[i + 1][0]) return lerp(pts[i][1], pts[i + 1][1], (pts[i][0] - y) / ((pts[i][0] - pts[i + 1][0]) || 1));
      }
      return pts[pts.length - 1][1];
    };
    const legYs = [L.crotch + 3, L.crotch - 4, L.midThigh, L.knee + 3, L.knee, L.calf + 5, L.ankle + 3, L.ankle, 3];
    [1, -1].forEach((s) => {
      bodyLofts.push({ rings: legYs.map((y) => ring(s * legX(y), y, y < L.knee ? -0.6 : 0, ellipse(legCirc(y), y > L.knee ? 1.08 : 1.0))), closeBottom: true });
      const fl = p.footLength;
      ellipsoids.push({ x: s * legX(3) * 1.02, y: 3.6, z: fl * 0.27, rx: fl * 0.18, ry: 3.7, rz: fl * 0.52, part: 'body' });
    });

    // arms
    const armX0 = Math.max(shoulderHalf - bicepR * 0.6, chestE.rx + bicepR * 0.7 - 12 * Math.tan(armAngle));
    const armY0 = L.shoulder - 1.5;
    const armPoint = (t) => [armX0 + Math.sin(armAngle) * t, armY0 - Math.cos(armAngle) * t];
    const arm = p.armLength;
    const armR = (t) => {
      const pts = [[0, bicepR * 1.12], [arm * 0.22, bicepR], [arm * 0.55, bicepR * 0.78], [arm * 0.72, bicepR * 0.82], [arm, bicepR * 0.55]];
      if (t <= 0) return pts[0][1];
      for (let i = 0; i < pts.length - 1; i++) if (t <= pts[i + 1][0]) return lerp(pts[i][1], pts[i + 1][1], (t - pts[i][0]) / (pts[i + 1][0] - pts[i][0]));
      return pts[pts.length - 1][1];
    };
    const armTs = [0, arm * 0.12, arm * 0.22, arm * 0.4, arm * 0.55, arm * 0.72, arm * 0.9, arm];
    [1, -1].forEach((s) => {
      bodyLofts.push({ rings: armTs.map((t) => { const c = armPoint(t); return ring(s * c[0], c[1], 0, { rx: armR(t) / Math.cos(armAngle), rz: armR(t) * 0.95 }); }), closeBottom: true });
      const d = armPoint(0);
      ellipsoids.push({ x: s * d[0], y: d[1] - bicepR * 0.35, z: 0, rx: bicepR * 1.2, ry: bicepR * 1.05, rz: bicepR * 1.1, part: 'body' });
      const h = armPoint(arm + handLen * 0.45);
      ellipsoids.push({ x: s * h[0], y: h[1], z: 0.6, rx: 1.9, ry: handLen * 0.5, rz: 4.3, rotZ: s * armAngle, part: 'body' });
    });
    // head
    const headRx = 0.044 * H, headRy = 0.066 * H;
    ellipsoids.push({ x: 0, y: H - headRy, z: 0.4, rx: headRx, ry: headRy, rz: headRx * 1.22, part: 'body' });

    // ---- garment ------------------------------------------------------------
    const garmentLofts = [];
    const markers = [];
    let torsoG = null, sleeveEnd = null, legRingsG = null, seamPts = null;
    const bodyCirc = (y) => SF.bodyCircAt(body, y);

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
      const kg = (y) => 1 + (kAt(y) - 1) * 0.9;
      const armpitY = L.armpit - drop * 0.5 - Math.max(0, chestEase) * 0.08;
      const rings = [
        ring(0, L.hps + 1.4, -0.8, ellipse(p.neck + 6, 1.15)),
        // a garment at least as wide as you also covers the top of the shoulder joint
        ring(0, L.shoulder - drop * 0.6, -0.4, { rx: Math.max(gsh, torso[2].rx + 0.6, gsh >= shoulderHalf - 1 ? armX0 + bicepR * 0.8 : 0), rz: chestE.rz * 0.85 + Math.max(0, chestEase) * 0.04 + 0.6 }),
        ring(0, armpitY, 0, ellipse(Math.max(gC, p.chest + 1.5), kg(L.armpit))),
      ];
      const levels = [L.chest, L.waist, L.pantWaist, L.hip, L.crotch, L.midThigh, L.knee, L.calf].filter((y) => y < armpitY - 2 && y > hemH + 2);
      const span = Math.max(armpitY - hemH, 1);
      levels.forEach((y) => {
        const t = (armpitY - y) / span;
        let C = lerp(gC, gHem, type === 'dress' ? Math.pow(t, 1.6) : t);
        if (type === 'dress' && g('waist') != null && Math.abs(y - L.waist) < 0.5) C = g('waist');
        if (type === 'dress' && g('hip') != null && Math.abs(y - L.hip) < 0.5) C = g('hip');
        rings.push(ring(0, y, y <= L.hip + 1 && y >= L.crotch ? -0.6 : 0, ellipse(Math.max(C, bodyCirc(y) + 1.5), kg(y))));
      });
      rings.push(ring(0, hemH, 0, ellipse(Math.max(gHem, bodyCirc(hemH) + 1.5), kg(hemH))));
      garmentLofts.push({ rings, part: 'garment', rim: [rings.length - 1] });
      torsoG = rings;
      seamPts = [[rings[1].rx, rings[1].y, 0], [-rings[1].rx, rings[1].y, 0]];

      // sleeves
      let eff = null;
      if (g('sleeve') != null) eff = g('sleeve') + Math.max(0, (gSh - p.shoulder) / 2);
      else if (g('fullSleeve') != null) eff = g('fullSleeve') / 2 - p.shoulder / 2;
      else if (g('neckSleeve') != null) eff = g('neckSleeve') - p.shoulder / 2 + 2;
      if (eff != null) {
        const tStart = Math.max(-3, drop * 0.9 - 3);
        const tEnd = Math.min(eff, arm + handLen * 0.7);
        if (tEnd > tStart + 3) {
          const sleeveEase = g('bicep') != null ? g('bicep') - p.bicep : Math.max(3, chestEase * 0.3);
          const topR = Math.max(armR(Math.max(0, tStart)) + 1, (p.bicep + sleeveEase) / TAU, bicepR * 1.45);
          const cuffR = g('cuff') != null ? Math.max(armR(tEnd) + 0.6, g('cuff') / TAU) : armR(tEnd) + (eff < arm * 0.6 ? Math.max(1.5, sleeveEase * 0.12) : 1.0);
          const n = 7;
          [1, -1].forEach((s) => {
            const sr = [];
            for (let i = 0; i <= n; i++) {
              const t = lerp(tStart, tEnd, i / n);
              const c = armPoint(t);
              const r = Math.max(lerp(topR, cuffR, i / n), armR(Math.max(t, 0)) + 0.7);
              sr.push(ring(s * c[0], c[1], 0, { rx: r / Math.cos(armAngle), rz: r }));
            }
            garmentLofts.push({ rings: sr, part: 'garment', rim: [sr.length - 1] });
            if (s === 1) sleeveEnd = sr[sr.length - 1];
          });
        }
      }
    } else if (group === 'bottom') {
      const w = v.waist;
      const elastic = w && w.elastic;
      const gW = elastic ? p.pantWaist + 1 : Math.max(g('waist') != null ? g('waist') : p.pantWaist + 2, p.pantWaist + 0.8);
      const gH = Math.max(g('hip') != null ? g('hip') : p.hip + 6, p.hip + 1);
      let hemH;
      if (g('inseam') != null) hemH = L.crotch - g('inseam');
      else if (g('outseam') != null) hemH = L.pantWaist - g('outseam');
      else if (g('skirtLength') != null) hemH = L.pantWaist - g('skirtLength');
      else hemH = type === 'shorts' ? L.knee + 8 : type === 'skirt' ? L.knee : 3;
      const extra = Math.max(0, -hemH);
      const hemY = Math.max(hemH, 0.6);
      const upper = [
        ring(0, L.pantWaist + 1.5, 0, ellipse(gW, kWaist)),
        ring(0, L.pantWaist - 3, 0, ellipse(Math.max(gW, bodyCirc(L.pantWaist - 3) + 1), kWaist)),
        ring(0, L.hip, -0.8, ellipse(gH, kHip)),
      ];
      if (type === 'skirt') {
        const hemC = Math.max(gH + 12, bodyCirc(hemY) + 6);
        upper.push(ring(0, hemY, 0, ellipse(hemC, 1.3)));
        garmentLofts.push({ rings: upper, part: 'garment', rim: [0, upper.length - 1] });
        torsoG = upper;
      } else {
        let crotchG = L.crotch - 1;
        if (g('rise') != null) crotchG = Math.min(L.crotch - 0.5, L.pantWaist - (g('rise') - 3));
        const hipG = ellipse(gH, kHip);
        upper.push(ring(0, crotchG + 1.5, -0.4, { rx: hipG.rx * 0.97, rz: hipG.rz * 0.86 }));
        garmentLofts.push({ rings: upper, part: 'garment', rim: [0] });
        torsoG = upper;
        const gThigh = Math.max(g('thigh') != null ? g('thigh') : p.thigh + Math.max(4, (gH - p.hip) * 0.6), p.thigh + 1.5);
        const thighGE = ellipse(gThigh, 1.05);
        const lx0 = Math.max(hipG.rx * 0.97 - thighGE.rx, thighGE.rx * 0.85, legX0);
        const gOpen = g('legOpening') != null ? g('legOpening') : type === 'shorts' ? gThigh * 0.92 : Math.max(gThigh * 0.66, legCirc(hemY) + 10);
        const gKnee = g('knee') != null ? g('knee') : null;
        const ys = [crotchG + 4, crotchG - 3, (crotchG + Math.max(L.knee, hemY)) / 2, L.knee, L.calf, L.ankle + 6].filter((y, i) => i < 2 || (y > hemY + 2 && y < crotchG - 4));
        ys.push(hemY);
        if (extra > 0.5) { ys.splice(ys.length - 1, 0, Math.min(8, hemY + 6), Math.min(4.5, hemY + 3.5)); }
        legRingsG = { 1: [], '-1': [] };
        [1, -1].forEach((s) => {
          const lr = ys.map((y, i) => {
            const t = clamp01((crotchG - 3 - y) / Math.max(crotchG - 3 - hemY, 1));
            let C = lerp(gThigh, gOpen, Math.pow(t, 0.9));
            if (gKnee != null && Math.abs(y - L.knee) < 0.5) C = gKnee;
            if (extra > 0.5 && y < 9 && i >= ys.length - 3) C *= 1.12; // fabric stacking at the ankle
            const x = y >= crotchG - 3 ? lx0 : lerp(lx0, legX(Math.max(y, 3)), clamp01((crotchG - 3 - y) / Math.max(crotchG - 3 - Math.max(L.knee, hemY), 1)));
            return ring(s * x, y, y < L.knee ? -0.5 : 0, ellipse(Math.max(C, legCirc(Math.max(y, 3)) + 1.5), 1.05));
          });
          garmentLofts.push({ rings: lr, part: 'garment', rim: [lr.length - 1] });
          legRingsG[s] = lr;
        });
      }
    }

    // ---- fit markers -------------------------------------------------------
    const addRing = (item, r, scale) => markers.push({ key: item.key, status: item.status, item, points: ellipsePoints(r, 36, scale || 1.02), closed: true });
    ev.items.forEach((it) => {
      if (torsoG && (group === 'top' || group === 'dress')) {
        if (it.key === 'chest') addRing(it, ringAt(torsoG, L.chest));
        else if (it.key === 'waist') addRing(it, ringAt(torsoG, L.waist));
        else if (it.key === 'hip' || it.key === 'hem') addRing(it, ringAt(torsoG, Math.max(L.hip, torsoG[torsoG.length - 1].y + 1)));
        else if (it.key === 'length') addRing(it, torsoG[torsoG.length - 1], 1.03);
        else if (it.key === 'shoulder' && seamPts) markers.push({ key: it.key, status: it.status, item: it, points: [seamPts[1], [0, seamPts[0][1] + 1.5, -torsoG[1].rz * 1.05], seamPts[0]], closed: false });
        else if (it.key === 'sleeve' && sleeveEnd) addRing(it, sleeveEnd, 1.08);
      } else if (torsoG && group === 'bottom') {
        if (it.key === 'waist') addRing(it, torsoG[0], 1.03);
        else if (it.key === 'hip') addRing(it, ringAt(torsoG, L.hip));
        else if (it.key === 'thigh' && legRingsG) addRing(it, legRingsG[1][1], 1.04);
        else if ((it.key === 'outseam' || it.key === 'inseam') && legRingsG) addRing(it, legRingsG[1][legRingsG[1].length - 1], 1.05);
        else if (it.key === 'skirtLength') addRing(it, torsoG[torsoG.length - 1], 1.03);
      }
    });

    return {
      H, sizeLabel: ev.label, score: ev.score, group, type,
      body: { lofts: bodyLofts, ellipsoids },
      garment: { lofts: garmentLofts },
      markers,
    };
  }

  // ---------------------------------------------------------------------------
  // three.js viewer
  // ---------------------------------------------------------------------------
  function webglAvailable() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  function Fit3D(container, opts) {
    const THREE = window.THREE;
    if (!THREE) throw new Error('three.js not loaded');
    opts = opts || {};
    this.THREE = THREE;
    this.container = container;
    container.classList.add('fit3d');
    container.innerHTML = '';

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('role', 'img');
    this.renderer = renderer;

    this.labels = document.createElement('div');
    this.labels.className = 'fit3d-labels';
    container.appendChild(this.labels);
    this.header = document.createElement('div');
    this.header.className = 'fit3d-header';
    container.appendChild(this.header);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f4f2ee');
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(28, 3 / 4, 10, 2000);
    this.camera = camera;
    scene.add(camera);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8f857a, 0.62));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(120, 160, 260);
    camera.add(key);
    const rimL = new THREE.DirectionalLight(0xffffff, 0.2);
    rimL.position.set(-200, 80, -100);
    scene.add(rimL);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(70, 64), new THREE.MeshBasicMaterial({ color: '#e7e2d9' }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.12, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    shadow.scale.set(26, 18, 1);
    scene.add(shadow);

    this.group = new THREE.Group();
    scene.add(this.group);

    this.angle = 0.35;
    this.elev = 0.08;
    this.zoom = 1;
    this.paused = !!opts.paused;
    this.speed = 0.3; // radians per second
    this.markerObjs = [];
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
      this.elev = Math.max(-0.3, Math.min(0.6, drag.el + (e.clientY - drag.y) * 0.004));
    });
    const end = () => { if (drag) { this.paused = drag.wasPaused; drag = null; } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(0.55, Math.min(1.4, this.zoom * (e.deltaY > 0 ? 1.08 : 0.93))); }, { passive: false });
  };

  Fit3D.prototype.resize = function () {
    const w = this.container.clientWidth || 400;
    const h = Math.round(w * 1.2);
    this.container.style.height = h + 'px';
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.width = w; this.height = h;
  };

  Fit3D.prototype._loftGeometry = function (loft, segs) {
    const THREE = this.THREE;
    const S = segs || 32;
    const pos = [];
    const idx = [];
    loft.rings.forEach((r) => {
      for (let j = 0; j < S; j++) {
        const a = (j / S) * TAU;
        pos.push(r.x + Math.cos(a) * r.rx, r.y, r.z + Math.sin(a) * r.rz);
      }
    });
    const R = loft.rings.length;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < S; j++) {
        const a = i * S + j, b = i * S + ((j + 1) % S), c = (i + 1) * S + j, d = (i + 1) * S + ((j + 1) % S);
        idx.push(a, c, b, b, c, d);
      }
    }
    const cap = (ri, down) => {
      const r = loft.rings[ri];
      const ci = pos.length / 3;
      pos.push(r.x, r.y + (down ? -0.4 : 0.4), r.z);
      for (let j = 0; j < S; j++) {
        const a = ri * S + j, b = ri * S + ((j + 1) % S);
        if (down) idx.push(a, ci, b); else idx.push(a, b, ci);
      }
    };
    if (loft.closeBottom) cap(R - 1, true);
    if (loft.closeTop) cap(0, false);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  };

  Fit3D.prototype.show = function (model, opts) {
    const THREE = this.THREE;
    opts = opts || {};
    this.clear();
    this.model = model;
    const skin = new THREE.MeshStandardMaterial({ color: SKIN[opts.skin] || SKIN.mannequin, roughness: 0.82, metalness: 0 });
    const gColor = GARMENT[model.group] || GARMENT.top;
    const cloth = new THREE.MeshStandardMaterial({ color: gColor, roughness: 0.7, metalness: 0, transparent: true, opacity: 0.48, side: THREE.DoubleSide, depthWrite: false });
    const rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(gColor).multiplyScalar(0.6) });
    const track = (x) => { this._disp.push(x); return x; };
    [skin, cloth, rimMat].forEach(track);

    model.body.lofts.forEach((l) => this.group.add(new THREE.Mesh(track(this._loftGeometry(l, 28)), skin)));
    const sphere = track(new THREE.SphereGeometry(1, 28, 20));
    model.body.ellipsoids.forEach((e) => {
      const m = new THREE.Mesh(sphere, skin);
      m.position.set(e.x, e.y, e.z);
      m.scale.set(e.rx, e.ry, e.rz);
      if (e.rotZ) m.rotation.z = e.rotZ;
      this.group.add(m);
    });
    model.garment.lofts.forEach((l) => {
      const mesh = new THREE.Mesh(track(this._loftGeometry(l, 40)), cloth);
      mesh.renderOrder = 2;
      this.group.add(mesh);
      (l.rim || []).forEach((ri) => {
        const r = l.rings[ri];
        const curve = new THREE.CatmullRomCurve3(ellipsePoints(r, 40, 1).map((q) => new THREE.Vector3(q[0], q[1], q[2])), true);
        const tube = new THREE.Mesh(track(new THREE.TubeGeometry(curve, 80, 0.22, 6, true)), rimMat);
        tube.renderOrder = 3;
        this.group.add(tube);
      });
    });

    // fit markers: coloured bands + labels that follow the figure's right-hand edge
    this.labels.innerHTML = '';
    this.markerObjs = model.markers.map((mk) => {
      const color = STATUS_COLORS[mk.status] || STATUS_COLORS.info;
      const pts = mk.points.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
      const curve = mk.closed ? new THREE.CatmullRomCurve3(pts, true) : new THREE.CatmullRomCurve3(pts, false);
      const tube = new THREE.Mesh(track(new THREE.TubeGeometry(curve, mk.closed ? 96 : 24, 0.45, 8, mk.closed)), track(new THREE.MeshBasicMaterial({ color })));
      tube.renderOrder = 4;
      this.group.add(tube);
      const lab = document.createElement('div');
      lab.className = 'fit3d-chip';
      const def = SF.MEASURE_DEFS[mk.key] || { label: mk.key, zh: '' };
      lab.innerHTML = `<i style="background:${color}"></i><b>${def.label}</b><span>${escapeHtml(shortVerdict(mk.item, opts.units))}</span>`;
      this.labels.appendChild(lab);
      return { pts, lab, color, title: def.label, text: shortVerdict(mk.item, opts.units) };
    });

    const fitColor = model.score >= 85 ? STATUS_COLORS.ok : model.score >= 70 ? '#3f8f4f' : model.score >= 50 ? STATUS_COLORS.snug : STATUS_COLORS.tight;
    this.header.innerHTML = `<strong>Size ${escapeHtml(model.sizeLabel)}</strong><span class="score" style="background:${fitColor}">Fit ${model.score}/100</span>`;
    this.renderer.domElement.setAttribute('aria-label', `3D view of size ${model.sizeLabel} on your body`);
    this.H = model.H;
    this._frame(0);
  };

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function shortVerdict(item, units) {
    let d = '';
    if (item.kind === 'ease' && item.diff != null) d = (item.diff >= 0 ? '+' : '−') + SF.fmtLen(Math.abs(item.diff), units || 'in') + ' · ';
    const v = item.verdict.length > 34 ? item.verdict.slice(0, 33) + '…' : item.verdict;
    return d + v;
  }

  Fit3D.prototype.clear = function () {
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    (this._disp || []).forEach((x) => x.dispose());
    this._disp = [];
    this.markerObjs = [];
  };

  Fit3D.prototype.setPaused = function (p) { this.paused = p; };
  Fit3D.prototype.setView = function (name) {
    const a = { front: 0, side: Math.PI / 2, back: Math.PI, angle: 0.6 }[name];
    if (a != null) { this.angle = a; this.elev = 0.08; this.paused = true; }
  };

  Fit3D.prototype._frame = function (dt) {
    if (!this.paused) this.angle += this.speed * dt;
    const H = this.H || 175;
    const target = new this.THREE.Vector3(0, H * 0.49, 0);
    const dist = (H * 0.58 / Math.tan((this.camera.fov * Math.PI) / 360)) * this.zoom;
    this.camera.position.set(Math.sin(this.angle) * dist * Math.cos(this.elev), target.y + Math.sin(this.elev) * dist, Math.cos(this.angle) * dist * Math.cos(this.elev));
    this.camera.lookAt(target);
    this.renderer.render(this.scene, this.camera);
    this._placeLabels();
  };

  Fit3D.prototype._placeLabels = function () {
    const W = this.width, Hh = this.height;
    const v = new this.THREE.Vector3();
    const placed = [];
    this.markerObjs.forEach((m) => {
      let best = null;
      m.pts.forEach((p) => {
        v.copy(p).project(this.camera);
        const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * Hh;
        if (!best || sx > best.x) best = { x: sx, y: sy };
      });
      m.screen = best;
      placed.push(m);
    });
    placed.sort((a, b) => a.screen.y - b.screen.y);
    let lastY = -100;
    placed.forEach((m) => {
      const lw = m.lab.offsetWidth || 120;
      let x = Math.min(m.screen.x + 8, W - lw - 6);
      let y = Math.max(m.screen.y - 11, lastY + 26);
      y = Math.min(y, Hh - 30);
      lastY = y;
      m.lx = x; m.ly = y;
      m.lab.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });
  };

  Fit3D.prototype._loop = function (now) {
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (!document.hidden) this._frame(dt);
    this._raf = requestAnimationFrame(this._loop);
  };

  // PNG of the current view with the labels drawn in.
  Fit3D.prototype.snapshot = function () {
    this._frame(0);
    const src = this.renderer.domElement;
    const scale = src.width / this.width;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    ctx.scale(scale, scale);
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillStyle = '#1f1d1a';
    ctx.fillText('Size ' + this.model.sizeLabel + '  ·  Fit ' + this.model.score + '/100', 12, 24);
    this.markerObjs.forEach((m) => {
      if (m.lx == null) return;
      ctx.font = '600 12px system-ui, sans-serif';
      const text = m.title + '  ' + m.text;
      const w = ctx.measureText(text).width + 26;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      roundRect(ctx, m.lx, m.ly, w, 22, 11); ctx.fill();
      ctx.fillStyle = m.color;
      ctx.beginPath(); ctx.arc(m.lx + 11, m.ly + 11, 5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#1f1d1a';
      ctx.fillText(text, m.lx + 20, m.ly + 15);
    });
    return c.toDataURL('image/png');
  };
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  Fit3D.prototype.dispose = function () {
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    window.removeEventListener('resize', this._resize);
    this.clear();
    this.renderer.dispose();
    this.container.classList.remove('fit3d');
    this.container.style.height = '';
  };

  return { buildFitModel, Fit3D, webglAvailable, ellipse3d: ellipse, circumference3d: circumference };
});
