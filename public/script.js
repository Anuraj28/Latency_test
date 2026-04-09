/* ═══════════════════════════════════════════════════════════════
   NetDiag v2 — script.js
   Latency + Jitter + Chart.js + Bandwidth + Traceroute
═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONFIG ──────────────────────────────────────────────────────
const PING_INTERVAL    = 15000;           // 15 seconds
const PING_TIMEOUT     = 3000;
const CHART_WINDOW_PTS = 240;             // 1 hour / 15s
const JITTER_WINDOW    = 4;               // last 4 samples (60 seconds)
const BW_AUTO_INTERVAL = 60 * 60 * 1000;  // 1 hour
const DL_SIZE          = 10 * 1024 * 1024;
const ARC_LEN          = 270;             // SVG arc half-circle px
const MAX_MBPS         = 100;

// ── STATE ────────────────────────────────────────────────────────
const state = {
  isPinging:  false,
  samples:   [],   // { ts, ms: number|null }
  totalPings: 0,
  lost:       0,
  min:        Infinity,
  max:        0,
  sum:        0,
  count:      0,
  uptime:     0,
  bwCountdown: BW_AUTO_INTERVAL / 1000,
  bwRunning:  false,
  trRunning:  false,
  checkId:    null,
  userIP:     '—',
};

// ── DOM ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dom = {
  mLatency: $('m-latency'), mAvg: $('m-avg'), mMin: $('m-min'),
  mMax: $('m-max'), mJitter: $('m-jitter'), mLoss: $('m-loss'),
  srcIp:    $('src-ip'),    checkNum: $('check-num'),
  statusDot:$('status-dot'),statusText:$('status-text'),
  dlNum:    $('dl-num'),
  arcDl:    $('arc-dl'),
  ndlDl:    $('ndl-dl'),
  ulNum:    $('ul-num'),
  arcUl:    $('arc-ul'),
  ndlUl:    $('ndl-ul'),
  bwProgress:$('bw-progress'),
  pgDl:     $('pg-dl'),
  pgDlPct:  $('pg-dl-pct'),
  pgUl:     $('pg-ul'),
  pgUlPct:  $('pg-ul-pct'),
  bwSummary:$('bw-summary'),sTime: $('s-time'), sId: $('s-id'),
  countdown:$('bw-countdown'),
  runBtn:   $('run-btn'),
  runTrBtn: $('run-traceroute-btn'),
  trStatus: $('tr-status'), trBody: $('tr-body'),
  trRawWrap:$('tr-raw-wrap'),trRaw: $('tr-raw'),
  sbPings:  $('sb-pings'),  sbUptime: $('sb-uptime'), sbDb: $('sb-db'),
};

// ── CHART.JS ──────────────────────────────────────────────────────
const ctxChart = $('smokeChart').getContext('2d');
let smokeChart = null;

function initChart() {
  smokeChart = new Chart(ctxChart, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Latency (ms)',
          data: [],
          borderColor: '#00ff87',
          backgroundColor: 'rgba(0, 255, 135, 0.1)',
          borderWidth: 2,
          pointRadius: 2,
          fill: true,
          tension: 0,
          spanGaps: false
        },
        {
          label: 'Packet Loss',
          data: [], 
          backgroundColor: 'red',
          borderColor: 'red',
          pointStyle: 'circle',
          pointRadius: 6,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: 'rgba(255,255,255,0.5)',
            maxTicksLimit: 12
          }
        },
        y: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          min: 0,
          suggestedMax: 200,
          ticks: { color: 'rgba(255,255,255,0.8)' }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

function updateChart() {
  if (!smokeChart) return;
  const labels = state.samples.map(s => {
    const d = new Date(s.ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
  });

  const dataLat = state.samples.map(s => s.ms !== null ? s.ms : Number.NaN);
  const maxLat = Math.max(...dataLat.filter(n => !isNaN(n)), 0);
  // Place loss marker slightly below minimum scale (or 0) for visibility 
  const dataLoss = state.samples.map(s => s.ms === null ? 0 : Number.NaN);

  smokeChart.data.labels = labels;
  smokeChart.data.datasets[0].data = dataLat;
  smokeChart.data.datasets[1].data = dataLoss;

  smokeChart.update('none'); 
}

// ── BOOT ────────────────────────────────────────────────────────
(async function boot() {
  initChart();
  await fetchIP();
  startPinging();
  startUptimeTimer();
  startBWCountdown();
})();

async function fetchIP() {
  try {
    const r = await fetch('/my-ip');
    const d = await r.json();
    state.userIP   = d.ip || '—';
    dom.srcIp.textContent = state.userIP;
  } catch (_) { dom.srcIp.textContent = 'unknown'; }
}

// ════════════════════════════════════════════════════════════════
// HTTP LATENCY POLLING
// ════════════════════════════════════════════════════════════════

function startPinging() {
  doPing();
  setInterval(doPing, PING_INTERVAL);
}

async function doPing() {
  if (state.isPinging) return;
  state.isPinging = true;

  const ts  = Date.now();
  let ms    = null;
  let lost  = false;

  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), PING_TIMEOUT);

  try {
    const r = await fetch(`/ping?_=${ts}`, {
      cache: 'no-store',
      signal: ctrl.signal
    });
    
    clearTimeout(timeout);
    if (!r.ok) throw new Error("bad ping");
    const data = await r.json();
    if (data.ok && data.ms !== undefined) {
      ms = data.ms;
    } else {
      lost = true;
    }
  } catch (_) {
    lost = true;
  }

  state.totalPings++;
  if (lost) {
    state.lost++;
  } else {
    state.count++;
    state.sum += ms;
    if (ms < state.min) state.min = ms;
    if (ms > state.max) state.max = ms;
  }

  state.samples.push({ ts, ms: lost ? null : ms });

  if (state.samples.length > CHART_WINDOW_PTS) {
    state.samples.shift();
  }

  updateMetrics(ms, lost);
  updateStatusDot(ms, lost);
  updateChart();
  
  dom.sbPings.textContent = `Pings: ${state.totalPings}`;
  state.isPinging = false;
}

function updateMetrics(ms, lost) {
  if (lost) {
    dom.mLatency.textContent = '—';
    dom.mLatency.className   = 'metric-val lat-loss';
  } else {
    const rMs = Math.round(ms);
    dom.mLatency.textContent = rMs;
    dom.mLatency.className   = 'metric-val ' + latCls(rMs);
  }

  const valid = state.samples.filter(s => s.ms !== null);
  if (valid.length) {
    const vals = valid.map(s => s.ms);
    const avg  = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    const mn   = Math.round(Math.min(...vals));
    const mx   = Math.round(Math.max(...vals));
    dom.mAvg.textContent = avg;  dom.mAvg.className = 'metric-val ' + latCls(avg);
    dom.mMin.textContent = mn;   dom.mMin.className = 'metric-val ' + latCls(mn);
    dom.mMax.textContent = mx;   dom.mMax.className = 'metric-val ' + latCls(mx);
  }

  const windowJit = state.samples.filter(s => s.ms !== null).slice(-JITTER_WINDOW);
  if (windowJit.length > 1) {
    const vals  = windowJit.map(s => s.ms);
    const mean  = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd    = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    let jit   = Math.round(sd * 10) / 10;
    if (jit === 0 && sd > 0) jit = 0.1;
    dom.mJitter.textContent = jit;
    dom.mJitter.className = 'metric-val ' + (jit < 15 ? '' : jit < 40 ? 'lat-warn' : 'lat-bad');
  } else {
    dom.mJitter.textContent = '—';
    dom.mJitter.className = 'metric-val';
  }

  const lossRate = state.totalPings
    ? ((state.lost / state.totalPings) * 100).toFixed(1)
    : '0.0';
  dom.mLoss.textContent = lossRate;
  dom.mLoss.className   = 'metric-val ' + (parseFloat(lossRate) > 0 ? (parseFloat(lossRate) < 5 ? 'lat-warn' : 'lat-bad') : '');
}

function updateStatusDot(ms, lost) {
  const dot  = dom.statusDot;
  const txt  = dom.statusText;
  if (lost) {
    dot.className = 'status-dot bad';
    txt.textContent = 'Connection Lost';
    txt.style.color = 'var(--red)';
  } else if (ms > 200) {
    dot.className = 'status-dot warn';
    txt.textContent = 'High Latency';
    txt.style.color = 'var(--yellow)';
  } else {
    dot.className = 'status-dot ok';
    txt.textContent = ms < 50 ? 'Excellent' : ms < 120 ? 'Good' : 'Acceptable';
    txt.style.color = 'var(--green)';
  }
}

function latCls(ms) {
  if (ms === null || ms === undefined) return 'lat-loss';
  if (ms < 50)  return 'lat-ok';
  if (ms < 120) return 'lat-warn';
  return 'lat-bad';
}

// ════════════════════════════════════════════════════════════════
// UPTIME COUNTER
// ════════════════════════════════════════════════════════════════
function startUptimeTimer() {
  setInterval(() => {
    state.uptime++;
    const h = Math.floor(state.uptime / 3600);
    const m = Math.floor((state.uptime % 3600) / 60);
    const s = state.uptime % 60;
    dom.sbUptime.textContent = h
      ? `Uptime: ${h}h ${m}m ${s}s`
      : m
        ? `Uptime: ${m}m ${s}s`
        : `Uptime: ${s}s`;
  }, 1000);
}

// ════════════════════════════════════════════════════════════════
// BANDWIDTH TEST
// ════════════════════════════════════════════════════════════════
function startBWCountdown() {
  state.bwCountdown = BW_AUTO_INTERVAL / 1000;
  const timer = setInterval(() => {
    state.bwCountdown--;
    const m = String(Math.floor(state.bwCountdown / 60)).padStart(2, '0');
    const s = String(state.bwCountdown % 60).padStart(2, '0');
    dom.countdown.textContent = `${m}:${s}`;
    if (state.bwCountdown <= 0) {
      clearInterval(timer);
      startBandwidthTest();
    }
  }, 1000);
}

async function startBandwidthTest() {
  if (state.bwRunning) return;
  state.bwRunning = true;
  dom.runBtn.disabled = true;
  dom.runBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="3" height="8" fill="currentColor"/><rect x="7" y="2" width="3" height="8" fill="currentColor"/></svg> Testing…';
  dom.bwProgress.style.display = 'flex';
  dom.bwSummary.style.display = 'none';

  resetGauge('dl');
  resetGauge('ul');
  dom.dlNum.textContent = '—';
  dom.ulNum.textContent = '—';

  let dlMbps = null;
  let ulMbps = null;

  try {
    dlMbps = await runDownload();
    animateGauge('dl', dlMbps);
    dom.dlNum.textContent = dlMbps.toFixed(1);

    ulMbps = await runUpload();
    animateGauge('ul', ulMbps);
    dom.ulNum.textContent = ulMbps.toFixed(1);
  } catch (e) {
    if (dlMbps === null) dom.dlNum.textContent = 'ERR';
    if (ulMbps === null) dom.ulNum.textContent = 'ERR';
  }

  dom.bwProgress.style.display = 'none';

  await sendResultData(dlMbps, ulMbps, null);

  dom.runBtn.disabled = false;
  dom.runBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="2,1 11,6 2,11" fill="currentColor"/></svg> Run Speed Test';
  state.bwRunning = false;

  startBWCountdown();
}

async function runTracerouteOnly() {
  if (state.trRunning) return;
  state.trRunning = true;
  dom.runTrBtn.disabled = true;
  dom.trStatus.textContent = 'Running path trace...';
  
  let trData = null;
  try {
    const r = await fetch('/traceroute');
    trData = await r.json();
    renderTraceroute(trData);
    dom.trStatus.textContent = `Completed — ${trData.hops?.length ?? '?'} hops`;
  } catch (e) {
    dom.trStatus.textContent = 'Path trace failed';
  }

  await sendResultData(null, null, trData?.raw || '');

  dom.runTrBtn.disabled = false;
  state.trRunning = false;
}

async function sendResultData(dlMbps, ulMbps, tracerouteRaw) {
  const recent = state.samples.filter(s => s.ms !== null).slice(-JITTER_WINDOW);
  let jitter = null, avgLat = null, minLat = null, maxLat = null;
  
  if (recent.length) {
    const vals = recent.map(s => s.ms);
    avgLat = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    minLat = Math.round(Math.min(...vals));
    maxLat = Math.round(Math.max(...vals));
  }
  
  if (recent.length > 1) {
    const vals = recent.map(s => s.ms);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    jitter = Math.round(sd * 10) / 10;
    if (jitter === 0 && sd > 0) jitter = 0.1;
  }

  const packetLoss = parseFloat(((state.lost / Math.max(state.totalPings, 1)) * 100).toFixed(1));
  const payload = {
    latency_avg: avgLat,
    latency_min: minLat,
    latency_max: maxLat,
    jitter,
    packet_loss: packetLoss,
    download_speed: dlMbps,
    upload_speed: ulMbps,
    traceroute: tracerouteRaw || ''
  };

  try {
    const r = await fetch('/save-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    state.checkId = data.check_id;
    dom.checkNum.textContent = `${data.check_id}`;
    dom.sId.textContent      = `${data.check_id}`;
    dom.sbDb.textContent     = `DB: saved ${data.check_id}`;
  } catch (_) {
    dom.sbDb.textContent = 'DB: save failed';
  }

  dom.sTime.textContent = new Date().toLocaleTimeString();
  dom.bwSummary.style.display = 'flex';
}

function runDownload() {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/download?_=${Date.now()}`, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 30000;
    let t0 = null;
    xhr.onloadstart = () => { t0 = performance.now(); };
    xhr.onprogress  = e => {
      if (e.lengthComputable && e.total) {
        const p = Math.round((e.loaded / e.total) * 100);
        dom.pgDl.style.width = p + '%';
        dom.pgDlPct.textContent = p + '%';
      }
    };
    xhr.onload = () => {
      if (xhr.status !== 200) { reject(); return; }
      const sec  = (performance.now() - t0) / 1000;
      const mbps = ((xhr.response.byteLength || DL_SIZE) * 8) / (sec * 1e6);
      dom.pgDl.style.width = '100%';
      dom.pgDlPct.textContent = '100%';
      resolve(mbps);
    };
    xhr.onerror = xhr.ontimeout = reject;
    xhr.send();
  });
}

function runUpload() {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload?_=${Date.now()}`, true);
    
    // Generate ~10MB payload string
    const payloadSize = 10 * 1024 * 1024;
    const payload = new Blob([new Uint8Array(payloadSize)]);

    xhr.timeout = 30000;
    let t0 = null;
    
    xhr.upload.onloadstart = () => { t0 = performance.now(); };
    xhr.upload.onprogress  = e => {
      if (e.lengthComputable && e.total) {
        const p = Math.round((e.loaded / e.total) * 100);
        dom.pgUl.style.width = p + '%';
        dom.pgUlPct.textContent = p + '%';
      }
    };
    xhr.onload = () => {
      if (xhr.status !== 200) { reject(); return; }
      const sec  = (performance.now() - t0) / 1000;
      const mbps = (payloadSize * 8) / (sec * 1e6);
      dom.pgUl.style.width = '100%';
      dom.pgUlPct.textContent = '100%';
      resolve(mbps);
    };
    xhr.onerror = xhr.ontimeout = reject;
    xhr.send(payload);
  });
}

function resetGauge(type) {
  const arc = document.getElementById(`arc-${type}`);
  const ndl = document.getElementById(`ndl-${type}`);
  if (arc) arc.style.strokeDasharray = `0 ${ARC_LEN}`;
  if (ndl) ndl.setAttribute('transform', 'rotate(-90,100,105)');
}

function animateGauge(type, mbps) {
  const clamped = Math.min(mbps, MAX_MBPS);
  const frac    = clamped / MAX_MBPS;
  const fill    = frac * ARC_LEN;
  const angle   = -90 + frac * 180;

  const arc = document.getElementById(`arc-${type}`);
  const ndl = document.getElementById(`ndl-${type}`);
  if (arc) arc.style.strokeDasharray = `${fill} ${ARC_LEN - fill + 1}`;
  if (ndl) ndl.setAttribute('transform', `rotate(${angle},100,105)`);
}

function renderTraceroute(data) {
  const hops = data.hops || [];
  if (!hops.length) {
    dom.trBody.innerHTML = '<tr><td colspan="4" class="tr-empty">No hops parsed. See raw output below.</td></tr>';
  } else {
    dom.trBody.innerHTML = hops.map(h => {
      const ms        = h.ms;
      const isTimeout  = h.ip === '*' || ms === null;
      const cls       = isTimeout ? 'hop-timeout' : ms < 50 ? '' : ms < 150 ? 'hop-warn' : 'hop-bad';
      const badge     = isTimeout
        ? '<span class="hop-badge na">TIMEOUT</span>'
        : ms < 50
          ? '<span class="hop-badge ok">OK</span>'
          : ms < 150
            ? '<span class="hop-badge warn">HIGH</span>'
            : '<span class="hop-badge bad">CRITICAL</span>';
      const msDisplay = isTimeout ? '* * *' : `${ms} ms`;
      return `<tr>
        <td>${h.hop}</td>
        <td>${h.ip === '*' ? '* * *' : h.ip}</td>
        <td class="${cls}">${msDisplay}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
  }

  if (data.raw) {
    dom.trRawWrap.style.display = 'block';
    dom.trRaw.textContent       = data.raw;
  }
}

// ── Expose globals for onclick ───────────────────────────────────
window.startBandwidthTest = startBandwidthTest;
window.runTracerouteOnly = runTracerouteOnly;
