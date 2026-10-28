(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const U = window.UAN;
  const state = { tpl: null, tplName: '', rows: 0, defaults: U.newDefaults(), worker: null, ocrReady: false, pdfReady: false, objectUrls: [] };

  // ---------------------------------------------------------------- small storage helpers
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('uanscan', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return undefined; } }
  async function kvSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { } }

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('missing ' + src)); document.head.appendChild(s); });
  }
  const abs = p => new URL(p, location.href).href;

  // ---------------------------------------------------------------- libraries
  const CDN = 'https://cdn.jsdelivr.net/npm';
  async function checkLibs() {
    // 1) files next to the page (lib folder); 2) otherwise the internet copy, which the browser then keeps for offline use
    try { await loadScript('lib/tesseract.min.js'); state.ocrReady = true; state.local = true; }
    catch (e) { try { await loadScript(CDN + '/tesseract.js@5.1.1/dist/tesseract.min.js'); state.ocrReady = true; } catch (e2) { } }
    try { await loadScript('lib/pdf.min.js'); window.pdfjsLib.GlobalWorkerOptions.workerSrc = abs('lib/pdf.worker.min.js'); state.pdfReady = true; }
    catch (e) { try { await loadScript(CDN + '/pdfjs-dist@3.11.174/build/pdf.min.js'); window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + '/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; state.pdfReady = true; } catch (e2) { } }
    const b = $('libBanner');
    if (!state.ocrReady) {
      b.className = 'banner err';
      b.innerHTML = '<b>The text reader could not be loaded.</b> Connect to the internet and reload this page once. After that it also works offline.';
    } else if (!state.local) {
      b.className = 'banner';
      b.innerHTML = 'First time on this device: read one photo while <b>online</b>. The text reader is then saved in the browser and works offline.';
    } else { b.className = 'banner hidden'; }
    refresh();
  }

  // ---------------------------------------------------------------- batch defaults
  function loadDefaults() {
    try { const j = JSON.parse(localStorage.getItem('uanDefaults') || 'null'); if (j) Object.assign(state.defaults, j); } catch (e) { }
  }
  function renderDefaults() {
    const d = state.defaults;
    $('defView').innerHTML = 'Client: <b>' + esc(d.client) + '</b><br>Sub-contractor: <b>' + esc(d.subContractor) + '</b><br>Joining: <b>' + esc(d.doj) + '</b> &nbsp; ESIC wages: <b>' + esc(d.esicWages) + '</b> &nbsp; EPF wages: <b>' + esc(d.epfWages) + '</b><br>ESI remit: <b>' + esc(d.remitLoc) + '</b> &nbsp; Dispensary: <b>' + esc(d.dispensary) + '</b> &nbsp; Marital: <b>' + esc(d.marital) + '</b>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function editDefaults(on) {
    $('defView').classList.toggle('hidden', on); $('defForm').classList.toggle('hidden', !on);
    $('defEdit').classList.toggle('hidden', on); $('defSave').classList.toggle('hidden', !on); $('defCancel').classList.toggle('hidden', !on);
    if (on) {
      $('defForm').innerHTML = U.DEFAULT_FIELDS.map(f => '<div><label>' + esc(f[1]) + '</label><input type="text" data-k="' + f[0] + '" value="' + esc(state.defaults[f[0]]) + '"></div>').join('');
    }
  }

  // ---------------------------------------------------------------- template
  function refresh() {
    const has = !!state.tpl;
    $('tplInfo').innerHTML = has ? '<b>' + esc(state.tplName) + '</b> &nbsp;-&nbsp; ' + state.rows + ' row(s) added by this site' : 'No template chosen yet.';
    $('tplBtn').textContent = has ? 'Choose a different template' : 'Choose template (.xlsx)';
    $('dlBtn').disabled = !has || state.rows === 0;
    $('docBtn').disabled = !has || !state.ocrReady;
  }
  async function useTemplate(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await U.inspectXlsx(bytes);
      state.tpl = bytes; state.tplName = file.name; state.rows = 0;
      await kvSet('tpl', { bytes, name: file.name, rows: 0 });
      $('homeMsg').innerHTML = '<span class="ok">Template ready.</span> Last filled row: ' + info.lastRow + '. New people go below it.';
    } catch (e) { $('homeMsg').innerHTML = '<span style="color:var(--bad)">Could not use this file: ' + esc(e.message) + '</span>'; }
    refresh();
  }
  function download() {
    const blob = new Blob([state.tpl], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = state.tplName.replace(/\.xlsx$/i, '') + '_filled.xlsx';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------------------------------------------------------------- OCR
  function setProgress(frac, text) {
    $('progress').classList.remove('hidden'); $('barFill').style.width = Math.round(frac * 100) + '%'; $('progText').textContent = text;
  }
  async function getWorker() {
    if (state.worker) return state.worker;
    setProgress(0.02, 'Starting the text reader (first time takes a little longer)...');
    state.worker = await Tesseract.createWorker('eng', 1, state.local ? {
      workerPath: abs('lib/worker.min.js'), corePath: abs('lib/core'), langPath: abs('lib/lang'),
      workerBlobURL: false, gzip: true, logger: () => { },
    } : { logger: () => { } });
    return state.worker;
  }
  async function toCanvas(source, w0, h0) {
    let w = w0, h = h0; const longest = Math.max(w, h);
    let scale = 1; if (longest < 1700) scale = 1700 / longest; else if (longest > 3000) scale = 3000 / longest;
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    try { x.filter = 'grayscale(1) contrast(1.15)'; } catch (e) { }
    x.drawImage(source, 0, 0, w, h);
    return c;
  }
  async function imageCanvas(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
    const c = await toCanvas(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close(); return c;
  }
  async function pdfCanvases(file) {
    const out = []; const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const n = Math.min(pdf.numPages, 6);
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      let text = ''; try { const tc = await page.getTextContent(); text = tc.items.map(t => t.str).join('\n'); } catch (e) { }
      if (text.replace(/\s/g, '').length > 80) { out.push({ text }); continue; }   // digital PDF: text already there
      const vp = page.getViewport({ scale: 2.5 }); const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height; const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise; out.push({ canvas: c });
    }
    return out;
  }
  const MODES = ['6', '11', '3'];   // each reading mode catches things the others miss; the parser takes a vote per field
  async function readFiles(files) {
    const worker = await getWorker();
    const jobs = []; const previews = [];
    for (const f of files) {
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        if (!state.pdfReady) { $('homeMsg').textContent = 'Skipped ' + f.name + ' (PDF reader not installed).'; continue; }
        const pages = await pdfCanvases(f);
        pages.forEach((p, i) => { jobs.push(p); if (p.canvas) previews.push(p.canvas.toDataURL('image/jpeg', 0.7)); });
      } else {
        const c = await imageCanvas(f); jobs.push({ canvas: c, name: f.name });
        previews.push(URL.createObjectURL(f)); state.objectUrls.push(previews[previews.length - 1]);
      }
    }
    const texts = []; const total = jobs.reduce((n, j) => n + (j.canvas ? MODES.length : 0), 0) || 1; let done = 0;
    for (const j of jobs) {
      if (j.text) { texts.push(j.text); continue; }
      for (const m of MODES) {
        setProgress(0.05 + 0.9 * done / total, 'Reading ' + (done + 1) + ' of ' + total + ' ...');
        await worker.setParameters({ tessedit_pageseg_mode: m });
        const r = await worker.recognize(j.canvas);
        texts.push(r.data.text || ''); done++;
      }
    }
    setProgress(1, 'Done.');
    return { texts, previews };
  }

  // ---------------------------------------------------------------- review screen
  let current = null;
  function showReview(person, previews) {
    current = person;
    $('fields').innerHTML = U.PERSON_FIELDS.map(f => {
      const k = f[0], big = k === 'address';
      return '<div ' + (big ? 'style="grid-column:1/-1"' : '') + '><label>' + esc(f[1]) + '</label>' +
        (big ? '<textarea data-k="' + k + '">' + esc(person[k]) + '</textarea>' : '<input type="text" data-k="' + k + '" value="' + esc(person[k]) + '">') +
        '<div class="msg-bad" data-m="' + k + '"></div></div>';
    }).join('');
    $('docsPane').innerHTML = '<div class="muted" style="margin-bottom:6px">Documents (click to enlarge)</div>' + previews.map(p => '<img src="' + p + '" alt="document">').join('');
    $('home').classList.add('hidden'); $('reviewSec').classList.remove('hidden'); $('saveMsg').textContent = '';
    validateAll(); window.scrollTo(0, 0);
  }
  function collect() {
    const p = {}; document.querySelectorAll('#fields [data-k]').forEach(el => p[el.dataset.k] = el.value.trim()); return p;
  }
  function validateAll() {
    const p = collect(); let bad = 0;
    document.querySelectorAll('#fields [data-k]').forEach(el => {
      const pr = U.problem(el.dataset.k, el.value); el.classList.toggle('bad', !!pr); if (pr) bad++;
      document.querySelector('[data-m="' + el.dataset.k + '"]').textContent = pr || '';
    });
    const s = $('summary'); s.className = 'summary' + (bad ? ' warn' : '');
    s.textContent = bad ? bad + ' field(s) need attention (marked in red). Handwritten text is not read - type it in.' : 'Everything looks fine. Compare with the documents once, then save.';
  }
  async function saveRow() {
    const p = collect(); $('saveMsg').textContent = '';
    try {
      const r = await U.appendRow(state.tpl, U.buildRow(p, state.defaults));
      state.tpl = r.bytes; state.rows++;
      await kvSet('tpl', { bytes: state.tpl, name: state.tplName, rows: state.rows });
      $('homeMsg').innerHTML = '<span class="ok">Added to Excel row ' + r.row + '.</span> Select the next person, or download the Excel.';
      leaveReview();
    } catch (e) { $('saveMsg').textContent = 'Could not save the row: ' + e.message; }
  }
  function leaveReview() {
    $('reviewSec').classList.add('hidden'); $('home').classList.remove('hidden'); $('progress').classList.add('hidden');
    state.objectUrls.forEach(u => URL.revokeObjectURL(u)); state.objectUrls = []; refresh();
  }

  // ---------------------------------------------------------------- wiring
  async function init() {
    loadDefaults(); renderDefaults();
    const saved = await kvGet('tpl');
    if (saved && saved.bytes) { state.tpl = saved.bytes; state.tplName = saved.name; state.rows = saved.rows || 0; }
    refresh();
    $('tplBtn').onclick = () => $('tplFile').click();
    $('tplFile').onchange = e => { if (e.target.files[0]) useTemplate(e.target.files[0]); e.target.value = ''; };
    $('dlBtn').onclick = download;
    $('defEdit').onclick = () => editDefaults(true);
    $('defCancel').onclick = () => editDefaults(false);
    $('defSave').onclick = () => {
      document.querySelectorAll('#defForm [data-k]').forEach(el => state.defaults[el.dataset.k] = el.value.trim());
      localStorage.setItem('uanDefaults', JSON.stringify(state.defaults)); renderDefaults(); editDefaults(false);
    };
    $('docBtn').onclick = () => $('docFiles').click();
    $('docFiles').onchange = async e => {
      const files = Array.from(e.target.files); e.target.value = ''; if (!files.length) return;
      $('docBtn').disabled = true; $('homeMsg').textContent = '';
      try {
        const r = await readFiles(files);
        showReview(U.parseAll(r.texts), r.previews);
      } catch (err) {
        $('homeMsg').innerHTML = '<span style="color:var(--bad)">Could not read the documents: ' + esc(err.message || err) + '</span>';
      }
      $('docBtn').disabled = !state.tpl || !state.ocrReady;
    };
    $('fields').addEventListener('input', validateAll);
    $('saveRow').onclick = saveRow; $('discard').onclick = leaveReview;
    $('docsPane').addEventListener('click', e => { if (e.target.tagName === 'IMG') { $('zoom').querySelector('img').src = e.target.src; $('zoom').style.display = 'flex'; } });
    $('zoom').onclick = () => { $('zoom').style.display = 'none'; };
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => { });
    checkLibs();
  }
  init();
})();
