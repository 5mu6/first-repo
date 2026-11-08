/* SizeFit web app UI. Depends on sizefit-core.js and sizefit-render.js (window.SizeFit). */
(function () {
  'use strict';
  const SF = window.SizeFit;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Self-hosting? Set window.SizeFitConfig = { tesseractUrl, workerPath, corePath, langPath } before app.js.
  const CONFIG = window.SizeFitConfig || {};
  const THREE_URL = CONFIG.threeUrl || 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  const TESSERACT_URL = CONFIG.tesseractUrl || 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  const STORE_KEY = 'sizefit.profile.v1';
  const UNITS_KEY = 'sizefit.units';

  const PROFILE_FIELDS = [
    { key: 'height', label: 'Height', req: true, kind: 'height', help: 'Barefoot, standing straight.' },
    { key: 'weight', label: 'Weight', kind: 'weight', help: "Used when a seller's chart only lists 身高/体重." },
    { key: 'chest', label: 'Chest / bust', req: true, help: 'Fullest part, tape under the arms and level.' },
    { key: 'waist', label: 'Natural waist', req: true, help: 'Narrowest part, about 1″ above the belly button.' },
    { key: 'pantWaist', label: 'Pants waist', help: 'Around where you actually wear your pants.' },
    { key: 'hip', label: 'Hips / seat', req: true, help: 'Fullest part of the seat, feet together.' },
    { key: 'shoulder', label: 'Shoulder width', help: 'Across the back, shoulder bone to shoulder bone.' },
    { key: 'armLength', label: 'Arm length', help: 'Shoulder bone to wrist bone, arm relaxed.' },
    { key: 'neck', label: 'Neck', help: 'Base of the neck (for dress-shirt collars).' },
    { key: 'bicep', label: 'Bicep', help: 'Fullest part of the upper arm, relaxed.' },
    { key: 'thigh', label: 'Thigh', help: 'Fullest part, just below the crotch.' },
    { key: 'inseam', label: 'Inseam', help: 'Crotch straight down to the floor, barefoot.' },
    { key: 'outseam', label: 'Outseam', help: 'From your pants waist down the side to the floor.' },
    { key: 'footLength', label: 'Foot length', kind: 'foot', help: 'Heel to longest toe, standing (measure both, use the longer).' },
  ];

  const EXAMPLES = {
    tee: { title: '重磅纯棉短袖T恤', text: '尺码 衣长 胸围 肩宽 袖长\nS 66 100 44 19\nM 68 104 45 20\nL 70 108 46 21\nXL 72 112 47 22\n2XL 74 116 48 23\n(手工测量存在1-3cm误差 单位:cm)' },
    hoodie: { title: '美式落肩连帽卫衣', text: '尺码    M    L    XL    XXL\n衣长    68   70   72    74\n胸围(平铺)  58   60   62    64\n肩宽    54   56   58    60\n袖长    56   57   58    59' },
    jeans: { title: '直筒牛仔裤男', text: '28码:腰围2尺1 臀围96 裤长100 大腿围56 脚口34\n29码:腰围2尺2 臀围98 裤长101 大腿围58 脚口35\n30码:腰围2尺3 臀围100 裤长102 大腿围60 脚口36\n31码:腰围2尺4 臀围102 裤长103 大腿围62 脚口37\n32码:腰围2尺5 臀围104 裤长104 大腿围64 脚口38\n33码:腰围2尺6 臀围106 裤长105 大腿围66 脚口39\n34码:腰围2尺7 臀围108 裤长106 大腿围68 脚口40' },
    joggers: { title: '休闲束脚卫裤', text: '尺码 腰围 臀围 裤长 大腿围\nM 66-90 104 98 62\nL 70-94 108 100 64\nXL 74-98 112 102 66\n2XL 78-102 116 104 68' },
    hw: { title: '宽松短袖', text: 'M码 建议身高160-168cm 体重100-120斤\nL码 建议身高168-175cm 体重120-140斤\nXL码 建议身高175-180cm 体重140-160斤\n2XL码 建议身高180-185cm 体重160-180斤' },
    shoes: { title: '休闲运动鞋', text: '码数 38 39 40 41 42 43 44 45\n脚长 235 240 245 250 255 260 265 270' },
  };

  const state = {
    units: 'in',
    profile: { fitTop: 'regular', fitBottom: 'regular', figure: 'masculine', skin: 'mannequin' },
    parsed: null,
    overrides: {},
    chart: null,
    result: null,
    selected: null,
    images: [],
    view: '3d',
  };

  // --------------------------------------------------------------------------
  // 3D viewer (three.js loaded on first use; falls back to the flat diagram)
  // --------------------------------------------------------------------------
  let viewer = null;
  let threePromise = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve();
    if (!threePromise) threePromise = loadScript(THREE_URL).catch((e) => { threePromise = null; throw e; });
    return threePromise;
  }
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function dropViewer() {
    if (viewer) { viewer.dispose(); viewer = null; }
  }
  async function show3d(label) {
    const host = $('#render');
    try {
      if (!SF.webglAvailable()) throw new Error('3D graphics are turned off in this browser');
      await loadThree();
      if (state.view !== '3d' || !state.result) return;
      if (!viewer) {
        host.innerHTML = '';
        viewer = new SF.Fit3D(host, { paused: reducedMotion() });
        syncSpinButton();
      }
      const fitWord = { slim: 'slim', regular: 'regular', relaxed: 'relaxed', oversized: 'oversized' }[SF.GARMENT_TYPES[state.chart.type].group === 'bottom' ? state.profile.fitBottom : state.profile.fitTop] || 'regular';
      viewer.show(SF.buildFitModel(state.result, state.chart, label), {
        skin: state.profile.skin, units: lenUnit(), profile: state.result.body.p,
        subtitle: ($('#title').value || SF.GARMENT_TYPES[state.chart.type].label).slice(0, 40) + ' · ' + fitWord + ' fit',
      });
    } catch (e) {
      dropViewer();
      state.view = 'flat';
      syncViewButtons();
      $('#render-note').textContent = "Couldn't start the 3D view (" + e.message + '), so this is the flat diagram.';
      renderFlat(label);
    }
  }
  function renderFlat(label) {
    dropViewer();
    $('#render').innerHTML = SF.renderFit(state.result, state.chart, label, { units: lenUnit(), skin: state.profile.skin, title: $('#title').value || SF.GARMENT_TYPES[state.chart.type].label });
  }
  function syncViewButtons() {
    $$('#view-mode button').forEach((b) => { const on = b.dataset.view === state.view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    const is3d = state.view === '3d' && state.chart && state.chart.type !== 'shoes';
    $('#view-3d-ctrls').hidden = !is3d;
    $('#view-mode').hidden = !!(state.chart && state.chart.type === 'shoes');
  }
  function syncSpinButton() {
    const b = $('#spin');
    const spinning = viewer && !viewer.paused;
    b.textContent = spinning ? 'Pause' : 'Rotate';
    b.setAttribute('aria-pressed', String(!!spinning));
  }

  // --------------------------------------------------------------------------
  // Storage (wrapped: may be unavailable in private windows)
  // --------------------------------------------------------------------------
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

  // --------------------------------------------------------------------------
  // Profile form
  // --------------------------------------------------------------------------
  function lenUnit() { return state.units === 'in' ? 'in' : 'cm'; }

  function buildProfileFields() {
    const host = $('#profile-fields');
    host.innerHTML = PROFILE_FIELDS.map((f) => {
      const id = 'pf-' + f.key;
      let input;
      if (f.kind === 'height' && state.units === 'in') {
        input = `<div class="field ft"><input id="${id}" data-key="height" data-part="ft" type="number" inputmode="decimal" min="3" max="8" step="1" placeholder="5"><span class="u">ft</span><input data-key="height" data-part="in" type="number" inputmode="decimal" min="0" max="11.9" step="0.5" placeholder="10" aria-label="Height inches"><span class="u">in</span></div>`;
      } else {
        const u = f.kind === 'weight' ? (state.units === 'in' ? 'lb' : 'kg') : f.kind === 'foot' ? (state.units === 'in' ? 'in' : 'cm') : lenUnit();
        input = `<div class="field"><input id="${id}" data-key="${f.key}" type="number" inputmode="decimal" step="0.1" min="0"><span class="u">${u}</span></div>`;
      }
      return `<label for="${id}">${esc(f.label)}${f.req ? ' *' : ''}${input}<span class="help">${esc(f.help)}</span></label>`;
    }).join('');
    fillProfileForm();
    $$('input', host).forEach((el) => el.addEventListener('change', () => { readProfileForm(); persistProfile(true); }));
  }

  function toDisplay(key, v) {
    const f = PROFILE_FIELDS.find((x) => x.key === key);
    if (v == null) return '';
    if (f.kind === 'weight') return state.units === 'in' ? Math.round(SF.kgToLb(v)) : SF.round1(v);
    return state.units === 'in' ? Math.round(SF.cmToIn(v) * 4) / 4 : SF.round1(v);
  }

  function fillProfileForm() {
    const p = state.profile;
    PROFILE_FIELDS.forEach((f) => {
      if (f.kind === 'height' && state.units === 'in') {
        const ft = $('input[data-key="height"][data-part="ft"]');
        const inch = $('input[data-key="height"][data-part="in"]');
        if (p.height) {
          const total = SF.cmToIn(p.height);
          ft.value = Math.floor(total / 12);
          inch.value = Math.round((total - Math.floor(total / 12) * 12) * 2) / 2;
        } else { ft.value = ''; inch.value = ''; }
        return;
      }
      const el = $(`input[data-key="${f.key}"]`);
      el.value = toDisplay(f.key, p[f.key]);
    });
    ['fitTop', 'fitBottom', 'figure', 'skin'].forEach((k) => { const el = $(`[name="${k}"]`); if (p[k]) el.value = p[k]; });
  }

  function readProfileForm() {
    const p = state.profile;
    PROFILE_FIELDS.forEach((f) => {
      if (f.kind === 'height' && state.units === 'in') {
        const ft = parseFloat($('input[data-key="height"][data-part="ft"]').value);
        const inch = parseFloat($('input[data-key="height"][data-part="in"]').value) || 0;
        p.height = ft > 0 ? SF.inToCm(ft * 12 + inch) : null;
        return;
      }
      const raw = parseFloat($(`input[data-key="${f.key}"]`).value);
      if (!(raw > 0)) { p[f.key] = null; return; }
      if (f.kind === 'weight') p[f.key] = state.units === 'in' ? SF.lbToKg(raw) : raw;
      else p[f.key] = state.units === 'in' ? SF.inToCm(raw) : raw;
    });
    ['fitTop', 'fitBottom', 'figure', 'skin'].forEach((k) => { p[k] = $(`[name="${k}"]`).value; });
  }

  function missingRequired() {
    return PROFILE_FIELDS.filter((f) => f.req && !(state.profile[f.key] > 0)).map((f) => f.label);
  }

  function updateProfileStatus() {
    const miss = missingRequired();
    const pill = $('#profile-status');
    if (miss.length) { pill.textContent = 'Needs: ' + miss.join(', '); pill.className = 'pill'; }
    else {
      const p = state.profile;
      pill.textContent = `✓ ${state.units === 'in' ? SF.fmtHeightImperial(p.height) : Math.round(p.height) + ' cm'} · chest ${SF.fmtLen(p.chest, lenUnit(), state.units === 'in' ? 1 : 0)}`;
      pill.className = 'pill ok';
    }
  }

  function persistProfile(silent) {
    const ok = save(STORE_KEY, state.profile);
    updateProfileStatus();
    if (!silent) $('#profile-msg').textContent = ok ? 'Saved on this device.' : 'Could not save (private browsing?) — it will work until you close this tab.';
    if (state.parsed) refresh();
  }

  // --------------------------------------------------------------------------
  // Units toggle
  // --------------------------------------------------------------------------
  function setUnits(u) {
    readProfileForm();
    state.units = u;
    save(UNITS_KEY, u);
    $$('.unit-switch button').forEach((b) => b.classList.toggle('on', b.dataset.units === u));
    buildProfileFields();
    updateProfileStatus();
    if (state.parsed) refresh();
  }

  // --------------------------------------------------------------------------
  // OCR (Tesseract.js, loaded on first use)
  // --------------------------------------------------------------------------
  let workerPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!window.Tesseract) await loadScript(TESSERACT_URL);
        const wopts = { logger: (m) => onProgress && onProgress(m) };
        ['workerPath', 'corePath', 'langPath'].forEach((k) => { if (CONFIG[k]) wopts[k] = CONFIG[k]; });
        if (CONFIG.langSuffix) {
          // Hosts that only serve certain file extensions: store the language files with an
          // extra suffix and rewrite the worker's requests for them.
          const real = new URL(CONFIG.workerPath || 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js', location.href).href;
          const src = `const f0 = self.fetch.bind(self); self.fetch = (u, o) => f0(String(u).replace(/\\.traineddata(\\.gz)?$/, (m) => m + ${JSON.stringify(CONFIG.langSuffix)}), o); importScripts(${JSON.stringify(real)});`;
          wopts.workerPath = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          wopts.workerBlobURL = false;
        }
        const worker = await window.Tesseract.createWorker(['chi_sim', 'eng'], 1, wopts);
        await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        return worker;
      })();
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not open that image.'));
      img.src = src;
    });
  }

  // Upscale, greyscale and stretch contrast; invert dark backgrounds.
  function preprocess(img) {
    const scale = Math.min(3, Math.max(1, 1800 / Math.max(img.naturalWidth, 1)));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    const lum = new Float32Array(px.length / 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) { lum[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; }
    // Light text on a dark band (e.g. a coloured header row) is inverted band by band,
    // so the whole image becomes dark text on a light background.
    const W = c.width, Hc = c.height;
    const rowMean = new Float32Array(Hc);
    for (let y = 0; y < Hc; y++) {
      let rs = 0;
      for (let x = 0; x < W; x += 3) rs += lum[y * W + x];
      rowMean[y] = rs / Math.ceil(W / 3);
    }
    const invertRow = new Uint8Array(Hc);
    const win = Math.max(4, Math.round(Hc / 200));
    for (let y = 0; y < Hc; y++) {
      let a = 0, n = 0;
      for (let k = Math.max(0, y - win); k <= Math.min(Hc - 1, y + win); k++) { a += rowMean[k]; n++; }
      invertRow[y] = a / n < 128 ? 1 : 0;
    }
    let lo = 255, hi = 0;
    for (let j = 0; j < lum.length; j += 7) { const v = invertRow[(j / W) | 0] ? 255 - lum[j] : lum[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const range = Math.max(hi - lo, 1);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      let v = invertRow[(j / W) | 0] ? 255 - lum[j] : lum[j];
      v = Math.max(0, Math.min(255, ((v - lo) / range) * 255));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  async function ocrImages(sources) {
    const status = $('#ocr-status');
    status.className = 'msg';
    const texts = [];
    try {
      status.textContent = 'Loading the Chinese text reader…';
      const worker = await getWorker((m) => {
        if (m.status && m.progress != null) status.textContent = `${m.status} ${Math.round(m.progress * 100)}%`;
      });
      for (let i = 0; i < sources.length; i++) {
        status.textContent = `Reading image ${i + 1} of ${sources.length}…`;
        const img = await loadImage(sources[i]);
        const { data } = await worker.recognize(preprocess(img));
        texts.push(data.text || '');
      }
      status.textContent = 'Done — check the table below.';
    } catch (e) {
      status.className = 'msg err';
      status.textContent = 'Could not read the image: ' + e.message + ' You can type the numbers into the "Paste text" tab instead.';
    }
    return texts.join('\n');
  }

  async function handleImages(files) {
    const sources = [];
    for (const file of files) {
      if (typeof file === 'string') { sources.push(file); continue; }
      if (!file.type.startsWith('image/')) continue;
      sources.push(await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); }));
    }
    if (!sources.length) return;
    $('#thumbs').innerHTML = sources.map((s) => `<img src="${esc(s)}" alt="Size chart image">`).join('');
    const text = await ocrImages(sources);
    if (text.trim()) {
      const ta = $('#chart-text');
      ta.value = (ta.dataset.pageText ? ta.dataset.pageText + '\n' : '') + text.trim();
      analyze();
    }
  }

  // --------------------------------------------------------------------------
  // Analysis
  // --------------------------------------------------------------------------
  function analyze() {
    const text = $('#chart-text').value;
    state.parsed = SF.parseChart(text, { unit: $('#chart-unit').value || undefined });
    state.overrides = {};
    state.selected = null;
    if (!state.parsed.sizes.length) {
      $('#parsed').hidden = false;
      $('#parse-notes').innerHTML = `<div class="note">No size chart found in that text. Make sure it includes the measurement names (e.g. 衣长 胸围 肩宽 / 腰围 臀围 裤长) and numbers. For images, try a tighter crop of just the table.</div>`;
      $('#parsed-table').innerHTML = '';
      $('#result-card').hidden = true;
      return;
    }
    refresh();
    $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function refresh() {
    if (!state.parsed) return;
    const typeSel = $('#type').value;
    const type = typeSel || SF.detectType(state.parsed, $('#title').value);
    if (!typeSel) $('#type').options[0].textContent = 'Auto-detect: ' + SF.GARMENT_TYPES[type].label;
    state.chart = SF.normalizeChart(state.parsed, type, state.overrides);
    readProfileForm();
    const opts = { stretch: $('#stretch').checked };
    state.result = state.chart.sizes.length ? SF.recommend(state.chart, state.profile, opts) : null;
    if (state.result && (!state.selected || !state.result.evals.some((e) => e.label === state.selected))) state.selected = state.result.best.label;
    renderParsedTable();
    renderResult();
  }

  function keysOf(parsed) {
    const order = Object.keys(SF.MEASURE_DEFS);
    const keys = new Set();
    parsed.sizes.forEach((s) => Object.keys(s.values).forEach((k) => keys.add(k)));
    return order.filter((k) => keys.has(k));
  }

  function fmtCell(v) {
    if (!v) return '';
    return v.max !== v.min ? `${SF.round1(v.min)}-${SF.round1(v.max)}` : `${SF.round1(v.min)}`;
  }

  function renderParsedTable() {
    const parsed = state.parsed;
    const chart = state.chart;
    $('#parsed').hidden = false;
    const notes = [];
    if (parsed.source) notes.push(`<div class="note info">Read as: ${esc(parsed.source)}${parsed.defaultUnit === 'in' ? ' · values in inches' : ' · values in cm'}. Garment type: <strong>${esc(SF.GARMENT_TYPES[chart.type].label)}</strong>.</div>`);
    parsed.warnings.forEach((w) => notes.push(`<div class="note">${esc(w)}</div>`));
    chart.notes.forEach((w) => notes.push(`<div class="note info">${esc(w)}</div>`));
    $('#parse-notes').innerHTML = notes.join('');

    // Columns follow the parsed chart; ambiguous keys are shown under the name they'll be scored as.
    const keys = keysOf(parsed);
    const head = keys.map((k) => {
      const d = SF.MEASURE_DEFS[k];
      const shownKey = mapKeyForType(k, chart.type);
      const sd = SF.MEASURE_DEFS[shownKey] || d;
      const unit = d.kind === 'weight' ? 'kg' : d.kind === 'shoesize' ? '' : 'cm';
      const flat = d.kind === 'circ' ? `<label><input type="checkbox" data-flat="${k}" ${chart.doubled.includes(shownKey) ? 'checked' : ''}> flat ×2</label>` : '';
      const opts = Object.entries(SF.MEASURE_DEFS).map(([key, md]) => `<option value="${key}" ${key === k ? 'selected' : ''}>${esc(md.zh + ' ' + md.label)}</option>`).join('');
      return `<th><span class="zh">${esc(sd.zh)}</span><select class="colsel" data-col="${k}" aria-label="Column meaning">${opts}</select>${unit ? '<span class="unit">' + unit + '</span>' : ''}${flat}</th>`;
    }).join('');
    const rows = parsed.sizes.map((s, ri) => {
      const cs = chart.sizes[ri];
      const cells = keys.map((k) => {
        const shownKey = mapKeyForType(k, chart.type);
        const cv = cs && (cs.values[shownKey] || cs.values[k]);
        const d = SF.MEASURE_DEFS[k];
        let conv = '';
        if (cv && (d.kind === 'circ' || d.kind === 'len')) conv = (cv.doubled ? '×2 = ' : '') + (state.units === 'in' ? fmtRange(cv, 'in') : (cv.doubled ? fmtRange(cv, 'cm') : ''));
        else if (cv && d.kind === 'weight') conv = state.units === 'in' ? `${Math.round(SF.kgToLb(cv.min))}${cv.max !== cv.min ? '–' + Math.round(SF.kgToLb(cv.max)) : ''} lb` : '';
        else if (cv && d.kind === 'height') conv = state.units === 'in' ? SF.fmtHeightImperial(cv.min) + (cv.max !== cv.min ? '–' + SF.fmtHeightImperial(cv.max) : '') : '';
        else if (cv && d.kind === 'foot') conv = state.units === 'in' ? fmtRange(cv, 'in') : '';
        return `<td><input data-r="${ri}" data-k="${k}" value="${esc(fmtCell(s.values[k]))}" inputmode="decimal" aria-label="${esc(s.label + ' ' + d.label)}">${conv ? `<span class="conv">${esc(conv)}</span>` : ''}</td>`;
      }).join('');
      return `<tr><td class="label"><input data-r="${ri}" data-label value="${esc(s.label)}" aria-label="Size label"></td>${cells}<td><button type="button" class="del" data-del="${ri}" aria-label="Remove ${esc(s.label)}">✕</button></td></tr>`;
    }).join('');
    $('#parsed-table').innerHTML = `<thead><tr><th>Size<span class="zh">尺码</span></th>${head}<th></th></tr></thead><tbody>${rows}</tbody>`;
  }

  function fmtRange(v, u) {
    return v.max !== v.min ? `${SF.fmtLen(v.min, u)}–${SF.fmtLen(v.max, u)}` : SF.fmtLen(v.min, u);
  }

  function mapKeyForType(k, type) {
    const group = SF.GARMENT_TYPES[type].group;
    if (group === 'bottom' && k === 'length' && type !== 'skirt') return 'outseam';
    if (type === 'skirt' && k === 'length') return 'skirtLength';
    if (type === 'dress' && k === 'skirtLength') return 'length';
    if (type === 'shoes' && k === 'inseam') return 'insole';
    return k;
  }

  function onTableInput(e) {
    const t = e.target;
    if (t.dataset.col) {
      const from = t.dataset.col, to = t.value;
      state.parsed.sizes.forEach((sz) => {
        if (!sz.values[from]) return;
        const tmp = sz.values[to];
        sz.values[to] = sz.values[from];
        if (tmp) sz.values[from] = tmp; else delete sz.values[from];
      });
      state.parsed.halfKeys = state.parsed.halfKeys.map((x) => (x === from ? to : x === to ? from : x));
      delete state.overrides[from]; delete state.overrides[to];
      state.selected = null;
      refresh();
      return;
    }
    if (t.dataset.flat) {
      const key = mapKeyForType(t.dataset.flat, state.chart.type);
      state.overrides[key] = t.checked ? 'half' : 'full';
      refresh();
      return;
    }
    const ri = Number(t.dataset.r);
    const size = state.parsed.sizes[ri];
    if (!size) return;
    if (t.dataset.label !== undefined) { size.label = t.value.trim() || size.label; refresh(); return; }
    const k = t.dataset.k;
    const m = String(t.value).replace(/[~～至到—–]/g, '-').match(/^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$/);
    if (!t.value.trim()) delete size.values[k];
    else if (m) size.values[k] = { min: Number(m[1]), max: m[2] != null ? Number(m[2]) : Number(m[1]) };
    else return;
    refresh();
  }

  // --------------------------------------------------------------------------
  // Result
  // --------------------------------------------------------------------------
  function renderResult() {
    const card = $('#result-card');
    if (!state.result) { card.hidden = true; return; }
    card.hidden = false;
    const r = state.result;
    const best = r.best;
    const units = lenUnit();
    const miss = missingRequired();
    const estimated = Object.keys(r.body.est).map((k) => (PROFILE_FIELDS.find((f) => f.key === k) || {}).label).filter(Boolean);

    const problems = best.items.filter((i) => i.status !== 'ok' && i.status !== 'info');
    const goods = best.items.filter((i) => i.status === 'ok');
    const bullets = [];
    problems.forEach((i) => bullets.push(`<li><span class="st ${i.status}">${esc(labelOf(i.key))}:</span> ${esc(i.verdict)}</li>`));
    goods.slice(0, 4).forEach((i) => bullets.push(`<li><span class="st ok">${esc(labelOf(i.key))}:</span> ${esc(i.verdict)}</li>`));
    let alt = '';
    if (r.alternative) alt = `<div>Runner-up: <strong>${esc(r.alternative.label)}</strong> — ${esc(r.alternative.why)}.</div>`;
    const warn = [];
    if (miss.length) warn.push(`<div class="note">Add your ${esc(miss.join(', ').toLowerCase())} in step 1 — until then those are estimated from your height, so treat this as a rough guess.</div>`);
    else if (estimated.length) warn.push(`<div class="muted small">Estimated from your height (add them in step 1 for a better check): ${esc(estimated.join(', '))}.</div>`);
    const rating = best.score >= 85 ? 'Great fit' : best.score >= 70 ? 'Good fit' : best.score >= 50 ? 'Acceptable fit' : 'Poor fit';
    $('#verdict').innerHTML = `
      <div class="big">${esc(best.label)}<small>${best.score}/100</small></div>
      <div class="headline">Buy size ${esc(best.label)} — ${rating.toLowerCase()}${best.score < 50 ? '. No size in this chart fits you well.' : ''}</div>
      <ul>${bullets.join('')}</ul>
      ${alt}${warn.join('')}`;

    renderSelected();

    // strip of all sizes
    $('#strip').innerHTML = r.evals.map((e) => {
      const svg = SF.renderFit(r, state.chart, e.label, { compact: true, units, skin: state.profile.skin });
      return `<button type="button" data-size="${esc(e.label)}" class="${e.label === state.selected ? 'on' : ''}" aria-pressed="${e.label === state.selected}">${state.chart.type === 'shoes' ? '' : svg}<span class="lab">${esc(e.label)}</span><span class="sc">${e.score}/100</span>${e === best ? '<span class="best">best</span>' : ''}</button>`;
    }).join('');
  }

  function labelOf(key) { return (SF.MEASURE_DEFS[key] || { label: key }).label; }

  function renderSelected() {
    const r = state.result;
    const units = lenUnit();
    const ev = r.evals.find((e) => e.label === state.selected) || r.best;
    syncViewButtons();
    if (state.view === '3d' && state.chart.type !== 'shoes') show3d(ev.label);
    else renderFlat(ev.label);
    $$('#strip button').forEach((b) => { const on = b.dataset.size === ev.label; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    const rows = ev.items.map((i) => {
      const d = SF.MEASURE_DEFS[i.key] || { label: i.key, zh: '' };
      let garment = '–', you = '–', ease = '';
      if (i.kind === 'range') {
        const isW = i.key === 'weight';
        garment = isW ? `${SF.fmtWeight(i.garment, state.units === 'in' ? 'lb' : 'kg')}–${SF.fmtWeight(i.garmentMax, state.units === 'in' ? 'lb' : 'kg')}` : `${fmtH(i.garment)}–${fmtH(i.garmentMax)}`;
        you = isW ? SF.fmtWeight(i.body, state.units === 'in' ? 'lb' : 'kg') : fmtH(i.body);
      } else if (i.kind === 'shoe') {
        garment = i.key === 'euSize' ? 'EU ' + i.garment : Math.round(i.garment * 10) + ' mm';
        you = Math.round(i.body * 10) + ' mm';
        ease = (i.diff >= 0 ? '+' : '−') + Math.round(Math.abs(i.diff) * 10) + ' mm';
      } else if (i.kind === 'elastic') {
        garment = `${SF.fmtLen(i.garment, units)}–${SF.fmtLen(i.garmentMax, units)}`;
        you = SF.fmtLen(i.body, units);
      } else {
        garment = SF.fmtLen(i.garment, units);
        if (i.body != null) you = SF.fmtLen(i.body, units);
        if (i.diff != null && i.kind === 'ease') ease = SF.fmtSigned(i.diff, units);
      }
      return `<tr><td><strong>${esc(d.label)}</strong> <span class="muted">${esc(d.zh)}</span></td><td>${esc(garment)}</td><td>${esc(you)}</td><td>${esc(ease)}</td><td><span class="st ${i.status}">${esc(i.verdict)}</span></td></tr>`;
    }).join('');
    $('#breakdown').innerHTML = `<thead><tr><th>Measurement</th><th>Size ${esc(ev.label)}</th><th>You</th><th>Ease</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function fmtH(cm) { return state.units === 'in' ? SF.fmtHeightImperial(cm) : Math.round(cm) + ' cm'; }

  // PNG export: try a direct download, and always show the image so it can be
  // saved with a long-press / right-click where downloads are blocked.
  function offerImage(dataUrl) {
    const name = `sizefit-${(state.selected || 'size').replace(/[^\w-]+/g, '')}.png`;
    const out = $('#png-out');
    out.hidden = false;
    out.innerHTML = `<p class="muted small">If nothing downloaded, long-press (phone) or right-click (computer) the picture and choose Save image.</p><img src="${dataUrl}" alt="Fit image for size ${esc(state.selected)}">`;
    try {
      const a = document.createElement('a');
      a.href = dataUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { /* downloads blocked: the image above can be saved */ }
  }

  async function downloadPng() {
    if (viewer && state.view === '3d') { offerImage(viewer.snapshot()); return; }
    const svgEl = $('#render svg');
    if (!svgEl) return;
    const xml = new XMLSerializer().serializeToString(svgEl);
    const vb = svgEl.viewBox.baseVal;
    const W = 1600;
    const Hh = Math.round((W * vb.height) / vb.width);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
    try {
      const img = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = W; c.height = Hh;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fbfaf8'; ctx.fillRect(0, 0, W, Hh);
      ctx.drawImage(img, 0, 0, W, Hh);
      offerImage(c.toDataURL('image/png'));
    } finally { URL.revokeObjectURL(url); }
  }

  // --------------------------------------------------------------------------
  // Browser-helper (userscript) hand-off
  // --------------------------------------------------------------------------
  function receivePayload(data) {
    if (!data || data.type !== 'sizefit:payload') return;
    window.postMessage({ type: 'sizefit:ack' }, location.origin);
    if (data.title) $('#title').value = data.title;
    const ta = $('#chart-text');
    ta.value = data.text || '';
    ta.dataset.pageText = data.text || '';
    if (data.images && data.images.length) { switchTab('image'); handleImages(data.images); }
    else { switchTab('text'); analyze(); }
  }

  function switchTab(name) {
    $$('.tabs button').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    $$('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------
  function init() {
    const saved = load(STORE_KEY);
    if (saved) Object.assign(state.profile, saved);
    const u = load(UNITS_KEY);
    state.units = u === 'cm' ? 'cm' : 'in';
    $$('.unit-switch button').forEach((b) => b.classList.toggle('on', b.dataset.units === state.units));
    buildProfileFields();
    updateProfileStatus();
    if (!missingRequired().length) $('#profile-details').open = false;

    const typeSel = $('#type');
    Object.entries(SF.GARMENT_TYPES).forEach(([k, v]) => typeSel.insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v.label)}</option>`));

    $$('.unit-switch button').forEach((b) => b.addEventListener('click', () => setUnits(b.dataset.units)));
    $$('[name="fitTop"],[name="fitBottom"],[name="figure"],[name="skin"]').forEach((el) => el.addEventListener('change', () => { readProfileForm(); persistProfile(true); }));
    $('#profile-save').addEventListener('click', () => { readProfileForm(); persistProfile(false); if (!missingRequired().length) $('#profile-details').open = false; });
    const codeBox = $('#profile-code');
    $('#profile-export').addEventListener('click', async () => {
      readProfileForm();
      const code = btoa(unescape(encodeURIComponent(JSON.stringify(state.profile))));
      codeBox.hidden = false;
      $('#profile-code-input').value = code;
      $('#profile-code-input').select();
      try { await navigator.clipboard.writeText(code); $('#profile-msg').textContent = 'Copied. On another device, choose "Load profile code" and paste it.'; }
      catch (e) { $('#profile-msg').textContent = 'Copy the code from the box below.'; }
    });
    $('#profile-import').addEventListener('click', () => {
      codeBox.hidden = false;
      $('#profile-code-input').value = '';
      $('#profile-code-input').focus();
      $('#profile-msg').textContent = 'Paste a profile code into the box below, then press Load.';
    });
    $('#profile-code-load').addEventListener('click', () => {
      const code = $('#profile-code-input').value.trim();
      if (!code) return;
      try {
        Object.assign(state.profile, JSON.parse(decodeURIComponent(escape(atob(code)))));
        fillProfileForm(); persistProfile(false); codeBox.hidden = true;
      } catch (e) { $('#profile-msg').textContent = "That code couldn't be read. Copy the whole code and try again."; }
    });

    $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    const drop = $('#drop');
    $('#file').addEventListener('change', (e) => handleImages(Array.from(e.target.files)));
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => handleImages(Array.from(e.dataTransfer.files)));
    document.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData ? e.clipboardData.files : []).filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); switchTab('image'); handleImages(files); }
    });

    $('#analyze').addEventListener('click', analyze);
    $('#chart-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) analyze(); });
    $('#example').addEventListener('change', (e) => {
      const ex = EXAMPLES[e.target.value];
      if (!ex) return;
      $('#title').value = ex.title;
      $('#chart-text').value = ex.text;
      $('#type').value = '';
      switchTab('text');
      analyze();
    });
    ['#type', '#stretch', '#title'].forEach((s) => $(s).addEventListener('change', refresh));
    $('#chart-unit').addEventListener('change', () => { if (state.parsed) analyze(); });
    const table = $('#parsed-table');
    table.addEventListener('change', onTableInput);
    table.addEventListener('click', (e) => {
      const d = e.target.closest('[data-del]');
      if (d) { state.parsed.sizes.splice(Number(d.dataset.del), 1); refresh(); }
    });
    $('#add-row').addEventListener('click', () => {
      if (!state.parsed) return;
      state.parsed.sizes.push({ label: 'New', values: {} });
      refresh();
    });
    $('#strip').addEventListener('click', (e) => {
      const b = e.target.closest('[data-size]');
      if (b) { state.selected = b.dataset.size; renderSelected(); }
    });
    $('#download').addEventListener('click', downloadPng);
    $$('#view-mode button').forEach((b) => b.addEventListener('click', () => {
      state.view = b.dataset.view;
      $('#render-note').textContent = state.view === '3d'
        ? "A 3D scan built from your measurements. The garment is see-through and coloured by how far the fabric sits from your skin (red tight, green fitted, blue loose). Drag to turn it. It's a fit model, not a photo."
        : "Front view drawn to your measurements, with each measurement labelled. It's a fit diagram, not a photo.";
      if (state.result) renderSelected();
    }));
    $('#heatmap').addEventListener('click', () => {
      const on = $('#heatmap').getAttribute('aria-pressed') !== 'true';
      $('#heatmap').setAttribute('aria-pressed', String(on));
      if (viewer) viewer.setHeat(on);
    });
    $('#spin').addEventListener('click', () => { if (viewer) { viewer.setPaused(!viewer.paused); syncSpinButton(); } });
    $$('[data-cam]').forEach((b) => b.addEventListener('click', () => { if (viewer) { viewer.setView(b.dataset.cam); syncSpinButton(); } }));
    $('#render').addEventListener('pointerup', () => setTimeout(syncSpinButton, 0));

    // userscript hand-off (same-window postMessage from the helper)
    window.addEventListener('message', (e) => { if (e.source === window) receivePayload(e.data); });
    window.postMessage({ type: 'sizefit:ready' }, location.origin === 'null' ? '*' : location.origin);
    document.documentElement.dataset.sizefitReady = '1';
  }

  init();
})();
