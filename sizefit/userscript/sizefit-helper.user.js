// ==UserScript==
// @name         SizeFit helper — send size charts from Taobao / 1688 / Weidian
// @namespace    https://github.com/5mu6/first-repo
// @version      1.0.0
// @description  Adds a "SizeFit" button to product pages. It grabs the size-chart text and the size-chart images you pick, and opens your SizeFit app with them so it can recommend a size and draw the fit.
// @match        *://*.taobao.com/*
// @match        *://*.tmall.com/*
// @match        *://*.tmall.hk/*
// @match        *://*.1688.com/*
// @match        *://weidian.com/*
// @match        *://*.weidian.com/*
// @match        *://*.superbuy.com/*
// @match        *://*.cssbuy.com/*
// @match        *://*.sugargoo.com/*
// @match        *://*.cnfans.com/*
// @match        *://*.acbuy.com/*
// @match        *://*.mulebuy.com/*
// @match        *://*.kakobuy.com/*
// @match        *://*.hoobuy.com/*
// @match        *://*.allchinabuy.com/*
// @match        *://*.basetao.com/*
// @match        https://5mu6.github.io/first-repo/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_APP_URL = 'https://5mu6.github.io/first-repo/sizefit/';
  const appUrl = () => GM_getValue('appUrl', DEFAULT_APP_URL);
  const PAYLOAD_KEY = 'sizefit_payload';

  GM_registerMenuCommand('Set SizeFit app address…', () => {
    const v = prompt('Address of your SizeFit page (where index.html is hosted):', appUrl());
    if (v) GM_setValue('appUrl', v.trim());
  });

  // ---------------------------------------------------------------------------
  // On the SizeFit app page: deliver the stored payload
  // ---------------------------------------------------------------------------
  if (location.href.startsWith(appUrl()) || /\/sizefit\/(index\.html)?(\?|#|$)/.test(location.pathname + location.search)) {
    const payload = GM_getValue(PAYLOAD_KEY, null);
    if (!payload || Date.now() - payload.ts > 10 * 60 * 1000) return;
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    let tries = 0;
    const timer = setInterval(() => {
      if (document.documentElement.dataset.sizefitReady === '1') page.postMessage(payload, location.origin);
      if (++tries > 40) clearInterval(timer);
    }, 250);
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sizefit:ack') { clearInterval(timer); GM_deleteValue(PAYLOAD_KEY); }
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // On shop pages
  // ---------------------------------------------------------------------------
  const KEYWORDS = /尺码|尺寸|衣长|胸围|肩宽|袖长|腰围|臀围|裤长|大腿围|脚口|下摆|身高|体重|脚长|内长|前裆|通袖|平铺|size|length|chest|bust|shoulder|sleeve|waist|hip|inseam|thigh/i;
  const SIZE_ROW = /^\s*(X{0,4}S|M|X{0,5}L|[2-9]XL|均码|\d{2,3}(\/\d{2,3}[AB]?)?)\s*(码|号)?[\s:：]/i;

  function collectText() {
    const out = new Set();
    document.querySelectorAll('table').forEach((t) => {
      if (KEYWORDS.test(t.innerText)) {
        Array.from(t.rows).forEach((r) => out.add(Array.from(r.cells).map((c) => c.innerText.trim()).join('\t')));
      }
    });
    (document.body.innerText || '').split('\n').forEach((line) => {
      const l = line.trim();
      if (l.length > 2 && l.length < 300 && (KEYWORDS.test(l) || SIZE_ROW.test(l)) && /\d/.test(l)) out.add(l);
    });
    return Array.from(out).join('\n').slice(0, 12000);
  }

  function title() {
    const h = document.querySelector('h1, [class*="ItemTitle"], [class*="title--"], .tb-main-title, .d-title, .item-title');
    return ((h && h.innerText) || document.title || '').trim().slice(0, 120);
  }

  // UI ------------------------------------------------------------------------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .fab { background:#b2452f; color:#fff; border:0; border-radius:999px; padding:10px 16px; font-weight:700; cursor:pointer; box-shadow:0 4px 14px rgba(0,0,0,.25); }
      .panel { display:none; width:300px; background:#fff; color:#1f1d1a; border-radius:14px; padding:14px; box-shadow:0 8px 30px rgba(0,0,0,.3); margin-bottom:10px; }
      .panel.on { display:block; }
      .panel h3 { margin:0 0 6px; font-size:15px; }
      .panel p { margin:0 0 10px; color:#6b655c; font-size:13px; }
      .row { display:flex; gap:8px; flex-wrap:wrap; }
      button.b { border:1px solid #ddd; background:#faf9f7; border-radius:9px; padding:7px 12px; cursor:pointer; }
      button.p { background:#b2452f; border-color:#b2452f; color:#fff; font-weight:700; }
      .msg { margin-top:8px; font-size:12px; color:#6b655c; }
    </style>
    <div class="panel" part="panel">
      <h3>SizeFit</h3>
      <p>Click the size-chart picture(s) on the page to select them (they get a red outline), then press <b>Send</b>. Text charts on the page are picked up automatically.</p>
      <div class="row">
        <button class="b p" data-act="send">Send to SizeFit</button>
        <button class="b" data-act="cancel">Cancel</button>
      </div>
      <div class="msg" data-msg></div>
    </div>
    <button class="fab" data-act="toggle">📏 SizeFit</button>`;
  document.documentElement.appendChild(host);
  const panel = root.querySelector('.panel');
  const msg = root.querySelector('[data-msg]');

  const selected = new Set();
  let picking = false;

  function onPick(e) {
    if (!picking) return;
    const img = e.target.closest && e.target.closest('img');
    if (!img || host.contains(img)) return;
    e.preventDefault();
    e.stopPropagation();
    if (selected.has(img)) { selected.delete(img); img.style.outline = img.dataset.sfOutline || ''; }
    else { selected.add(img); img.dataset.sfOutline = img.style.outline; img.style.outline = '4px solid #e0442b'; }
    msg.textContent = `${selected.size} image(s) selected.`;
  }
  function startPicking() {
    picking = true;
    panel.classList.add('on');
    document.addEventListener('click', onPick, true);
    const text = collectText();
    msg.textContent = text ? 'Found size text on this page. Select chart images too if there are any.' : 'No size text found — select the size-chart image(s).';
  }
  function stopPicking() {
    picking = false;
    panel.classList.remove('on');
    document.removeEventListener('click', onPick, true);
    selected.forEach((img) => { img.style.outline = img.dataset.sfOutline || ''; });
    selected.clear();
  }

  function fetchImage(src) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: src, responseType: 'blob', timeout: 30000,
        headers: { Referer: location.href },
        onload: (r) => (r.status >= 200 && r.status < 400 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // Shrink to ≤1600 px wide JPEG so the hand-off stays small.
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
      img.src = url;
    });
  }

  async function send() {
    const imgs = Array.from(selected);
    msg.textContent = imgs.length ? 'Fetching images…' : 'Sending…';
    const images = [];
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.dataset.src || img.getAttribute('data-ks-lazyload') || '';
      if (!src) continue;
      try { images.push(await blobToDataUrl(await fetchImage(src.startsWith('//') ? location.protocol + src : src))); }
      catch (e) { msg.textContent = 'Could not fetch one image (' + e.message + '). Try a screenshot instead.'; }
    }
    const text = collectText();
    if (!images.length && !text) { msg.textContent = 'Nothing to send — select the size-chart image first.'; return; }
    GM_setValue(PAYLOAD_KEY, { type: 'sizefit:payload', ts: Date.now(), url: location.href, title: title(), text, images });
    stopPicking();
    GM_openInTab(appUrl(), { active: true, insert: true });
  }

  root.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'toggle') (picking ? stopPicking : startPicking)();
    else if (act === 'cancel') stopPicking();
    else if (act === 'send') send();
  });
})();
