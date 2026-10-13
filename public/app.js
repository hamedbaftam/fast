'use strict';

(() => {
  const API = '/api';
  const DOWNLOAD_BYTES = 25 * 1024 * 1024;
  const UPLOAD_BYTES = 8 * 1024 * 1024;
  const SAMPLE_MS = 200;     // how often the live number updates
  const WINDOW_MS = 2000;    // sliding window used to compute the current speed
  const STABLE_MS = 3000;    // speed must stay within tolerance for this long
  const STABLE_TOLERANCE = 0.05;

  const DEFAULTS = { connections: 4, minDuration: 8, maxDuration: 20, alwaysUpload: true };
  const SETTINGS_KEY = 'speedtest-settings';

  const $ = (id) => document.getElementById(id);
  const ui = {
    speedSection: document.querySelector('.speed'),
    label: $('speed-label'),
    value: $('speed-value'),
    units: $('speed-units'),
    action: $('action-btn'),
    moreBtn: $('more-btn'),
    moreInfo: $('more-info'),
    latUnloaded: $('lat-unloaded'),
    latLoaded: $('lat-loaded'),
    upValue: $('up-value'),
    upUnits: $('up-units'),
    clientIp: $('client-ip'),
    serverName: $('server-name'),
    settingsBtn: $('settings-btn'),
    settingsForm: $('settings'),
    setConn: $('set-conn-min'),
    outConn: $('out-conn'),
    setDurMin: $('set-dur-min'),
    setDurMax: $('set-dur-max'),
    setUpload: $('set-upload'),
    setDefault: $('set-default'),
  };

  // ---------- settings ----------
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { ...DEFAULTS, ...saved };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }
  let settings = loadSettings();

  // ---------- helpers ----------
  const now = () => performance.now();
  const median = (arr) => {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function formatSpeed(bps) {
    if (!isFinite(bps) || bps <= 0) return { value: '0', units: 'Mbps' };
    let v, units;
    if (bps >= 1e9) { v = bps / 1e9; units = 'Gbps'; }
    else if (bps >= 1e6) { v = bps / 1e6; units = 'Mbps'; }
    else { v = bps / 1e3; units = 'Kbps'; }
    const value = v < 10 || (units === 'Gbps' && v < 100) ? v.toFixed(1) : String(Math.round(v));
    return { value, units };
  }

  function randomBlob(size) {
    const chunk = new Uint8Array(65536);
    crypto.getRandomValues(chunk);
    const parts = [];
    for (let i = 0; i < size; i += chunk.length) parts.push(chunk);
    return new Blob(parts, { type: 'application/octet-stream' });
  }
  const uploadBlob = randomBlob(UPLOAD_BYTES);

  // ---------- latency ----------
  async function ping(signal) {
    const t0 = now();
    const res = await fetch(`${API}/ping?r=${Math.random()}`, { cache: 'no-store', signal });
    await res.text();
    return now() - t0;
  }

  async function measureUnloadedLatency(signal, count = 10) {
    await ping(signal).catch(() => {}); // warm up connection
    const times = [];
    for (let i = 0; i < count && !signal.aborted; i++) {
      try { times.push(await ping(signal)); } catch { break; }
    }
    return median(times);
  }

  // ---------- throughput meter ----------
  /**
   * Runs `startWorker` in `connections` parallel loops, samples total bytes
   * every SAMPLE_MS and stops once the speed is stable or maxDuration passes.
   */
  function measureThroughput({ startWorker, onUpdate, signal }) {
    return new Promise((resolve) => {
      let bytes = 0;
      const addBytes = (n) => { bytes += n; };
      const ctrl = new AbortController();
      const stopAll = () => ctrl.abort();
      signal.addEventListener('abort', stopAll, { once: true });

      for (let i = 0; i < settings.connections; i++) startWorker(addBytes, ctrl.signal);

      const start = now();
      const samples = [{ t: start, bytes: 0 }];
      const speeds = [];
      let current = 0;

      const timer = setInterval(() => {
        const t = now();
        samples.push({ t, bytes });
        while (samples.length > 2 && t - samples[0].t > WINDOW_MS) samples.shift();
        const first = samples[0];
        const dt = (t - first.t) / 1000;
        if (dt > 0) current = ((bytes - first.bytes) * 8) / dt;
        speeds.push({ t, v: current });
        while (speeds.length && t - speeds[0].t > STABLE_MS) speeds.shift();
        onUpdate(current);

        const elapsed = (t - start) / 1000;
        let stable = false;
        if (elapsed >= settings.minDuration && speeds.length > 5) {
          const vs = speeds.map((s) => s.v);
          const max = Math.max(...vs), min = Math.min(...vs);
          const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
          stable = mean > 0 && (max - min) / mean < STABLE_TOLERANCE;
        }
        if (stable || elapsed >= settings.maxDuration || signal.aborted) {
          clearInterval(timer);
          signal.removeEventListener('abort', stopAll);
          stopAll();
          resolve(current);
        }
      }, SAMPLE_MS);
    });
  }

  async function downloadWorker(addBytes, signal) {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${API}/download?bytes=${DOWNLOAD_BYTES}&r=${Math.random()}`, { cache: 'no-store', signal });
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          addBytes(value.byteLength);
        }
      } catch {
        if (signal.aborted) return;
        await sleep(250); // transient network error; retry
      }
    }
  }

  function uploadWorker(addBytes, signal) {
    if (signal.aborted) return;
    const xhr = new XMLHttpRequest();
    let last = 0;
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.upload.onprogress = (e) => { addBytes(e.loaded - last); last = e.loaded; };
    xhr.onloadend = () => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) setTimeout(() => uploadWorker(addBytes, signal), xhr.status ? 0 : 250);
    };
    xhr.open('POST', `${API}/upload?r=${Math.random()}`);
    xhr.send(uploadBlob);
  }

  // Pings repeatedly while a transfer saturates the link.
  function sampleLoadedLatency(signal) {
    const times = [];
    (async () => {
      await sleep(1000); // let the connections ramp up first
      while (!signal.aborted) {
        try { times.push(await ping(signal)); } catch { break; }
        await sleep(300);
      }
    })();
    return times;
  }

  // ---------- UI ----------
  function showSpeed(bps) {
    const f = formatSpeed(bps);
    ui.value.textContent = f.value;
    ui.units.textContent = f.units;
  }
  function showUpload(bps) {
    const f = formatSpeed(bps);
    ui.upValue.textContent = f.value;
    ui.upUnits.textContent = f.units;
  }
  function setDone(done) {
    ui.speedSection.classList.toggle('done', done);
    ui.action.setAttribute('aria-label', done ? 'Restart test' : 'Stop test');
    ui.action.title = done ? 'Restart' : 'Stop';
  }
  function resetExtras() {
    for (const el of [ui.latUnloaded, ui.latLoaded, ui.upValue]) {
      el.textContent = '–';
      el.classList.remove('final');
    }
    ui.upUnits.textContent = 'Mbps';
  }
  function setFinal(el, text) {
    el.textContent = text;
    el.classList.add('final');
  }

  // ---------- test orchestration ----------
  let runCtrl = null;
  let uploadMeasured = false;
  let running = false;

  async function runUpload(signal) {
    const loaded = sampleLoadedLatency(signal);
    const upCtrl = new AbortController();
    signal.addEventListener('abort', () => upCtrl.abort(), { once: true });
    const result = await measureThroughput({ startWorker: uploadWorker, onUpdate: showUpload, signal: upCtrl.signal });
    upCtrl.abort();
    showUpload(result);
    ui.upValue.classList.add('final');
    uploadMeasured = true;
    return loaded;
  }

  async function runTest() {
    if (runCtrl) runCtrl.abort();
    const ctrl = new AbortController();
    runCtrl = ctrl;
    const { signal } = ctrl;
    running = true;
    uploadMeasured = false;

    setDone(false);
    resetExtras();
    showSpeed(0);
    ui.label.textContent = 'Your Internet speed is';

    // Latency first, on an idle connection.
    const unloaded = await measureUnloadedLatency(signal);
    if (isFinite(unloaded)) setFinal(ui.latUnloaded, String(Math.round(unloaded)));
    if (signal.aborted) return;

    // Download — the headline number. A stop click ends this phase and keeps the result.
    const dlCtrl = new AbortController();
    const onStop = () => dlCtrl.abort();
    signal.addEventListener('abort', onStop, { once: true });
    const loadedTimes = sampleLoadedLatency(dlCtrl.signal);
    const download = await measureThroughput({ startWorker: downloadWorker, onUpdate: showSpeed, signal: dlCtrl.signal });
    dlCtrl.abort();
    showSpeed(download);
    setDone(true);

    if (runCtrl !== ctrl) return; // a new test has started

    const wantUpload = settings.alwaysUpload || !ui.moreInfo.hidden;
    if (wantUpload && !signal.aborted) {
      const upLoaded = await runUpload(signal);
      loadedTimes.push(...upLoaded);
    }
    const loaded = median(loadedTimes);
    if (isFinite(loaded)) setFinal(ui.latLoaded, String(Math.round(loaded)));

    if (runCtrl === ctrl) { running = false; runCtrl = null; }
  }

  async function loadInfo() {
    try {
      const res = await fetch(`${API}/info`, { cache: 'no-store' });
      const info = await res.json();
      ui.clientIp.textContent = info.ip || '–';
      ui.serverName.textContent = info.server || '–';
    } catch { /* leave placeholders */ }
  }

  // ---------- events ----------
  ui.action.addEventListener('click', () => {
    if (running && runCtrl) {
      runCtrl.abort();
      running = false;
      runCtrl = null;
      setDone(true);
    } else {
      runTest();
    }
  });

  ui.moreBtn.addEventListener('click', () => {
    ui.moreInfo.hidden = false;
    ui.moreBtn.classList.add('open');
    ui.moreBtn.setAttribute('aria-expanded', 'true');
    // If the download finished without upload, measure upload now (like fast.com).
    if (!running && !uploadMeasured) {
      const ctrl = new AbortController();
      runCtrl = ctrl;
      running = true;
      setDone(false);
      runUpload(ctrl.signal).then((times) => {
        const loaded = median(times);
        if (isFinite(loaded) && !ui.latLoaded.classList.contains('final')) setFinal(ui.latLoaded, String(Math.round(loaded)));
        if (runCtrl === ctrl) { running = false; runCtrl = null; }
        setDone(true);
      });
    }
  });

  function fillSettingsForm() {
    ui.setConn.value = settings.connections;
    ui.outConn.textContent = settings.connections;
    ui.setDurMin.value = settings.minDuration;
    ui.setDurMax.value = settings.maxDuration;
    ui.setUpload.checked = settings.alwaysUpload;
  }

  ui.settingsBtn.addEventListener('click', () => {
    const open = ui.settingsForm.hidden;
    ui.settingsForm.hidden = !open;
    ui.settingsBtn.setAttribute('aria-expanded', String(open));
    if (open) fillSettingsForm();
  });
  ui.setConn.addEventListener('input', () => { ui.outConn.textContent = ui.setConn.value; });
  ui.setDefault.addEventListener('click', () => {
    settings = { ...DEFAULTS };
    fillSettingsForm();
  });
  ui.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const minD = Math.max(3, Number(ui.setDurMin.value) || DEFAULTS.minDuration);
    const maxD = Math.max(minD + 1, Number(ui.setDurMax.value) || DEFAULTS.maxDuration);
    settings = {
      connections: Number(ui.setConn.value) || DEFAULTS.connections,
      minDuration: minD,
      maxDuration: maxD,
      alwaysUpload: ui.setUpload.checked,
    };
    saveSettings(settings);
    ui.settingsForm.hidden = true;
    ui.settingsBtn.setAttribute('aria-expanded', 'false');
    runTest();
  });

  loadInfo();
  runTest();
})();
