// 충치벌레 쫓아내기 — 전면 카메라 AR 양치 도우미 (설계서 v1 기반)
// 영상은 기기 안에서만 처리합니다. 서버로 보내는 데이터는 없습니다.
import { FilesetResolver, FaceLandmarker } from './vendor/vision_bundle.mjs';

const VERSION = '1.0.0';
const params = new URLSearchParams(location.search);

// 모델: ./models 에 파일을 넣어두면 그것을 먼저 쓰고, 없으면 구글 공식 주소에서 받습니다.
const MODEL_URLS = [
  './models/face_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
];

// MediaPipe face mesh 입술 안쪽 윤곽 (입꼬리 78 → 308)
const UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
const FACE_EDGE = [234, 454];
const TRACK = Array.from(new Set(UPPER.concat(LOWER, FACE_EDGE)));

const OPEN_ENTER = 0.22;   // 입 벌림 판정 (입술 사이 간격 / 입 너비). 웃기만 해서는 넘지 않는 값
const OPEN_EXIT = 0.12;
const MOTION_T = 4.5;      // 입 주변 움직임 기준 (0~255 평균 차이). 넘으면 벌레가 더 빨리 도망갑니다
const FACE_HOLD_MS = 600;  // 얼굴을 놓쳐도 이 시간 동안은 마지막 위치 유지 (느린 기기는 자동으로 늘림)

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- 저장
const Store = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
    catch (e) { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 불가 환경 */ } },
};
const DEFAULTS = { duration: 120, voice: 1, sfx: 1, debug: 0 };
const settings = Object.assign({}, DEFAULTS, Store.get('bb.settings', {}) || {});
if ([60, 120, 180].indexOf(Number(settings.duration)) < 0) settings.duration = 120;
['voice', 'sfx', 'debug'].forEach((k) => { settings[k] = Number(settings[k]) ? 1 : 0; });
const TEST_DUR = Number(params.get('dur'));
if (params.get('debug') === '1') settings.debug = 1;
function brushDuration() { return TEST_DUR >= 5 && TEST_DUR <= 600 ? TEST_DUR : Number(settings.duration); }

function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function getStickers() { const s = Store.get('bb.stickers', {}); return s && typeof s === 'object' ? s : {}; }
function addSticker() {
  const s = getStickers();
  const k = dayKey(new Date());
  s[k] = (Number(s[k]) || 0) + 1;
  const keys = Object.keys(s).sort();
  while (keys.length > 90) delete s[keys.shift()];
  Store.set('bb.stickers', s);
  return s[k];
}
function renderWeek(el) {
  const s = getStickers();
  const names = ['일', '월', '화', '수', '목', '금', '토'];
  const today = new Date();
  el.innerHTML = '';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const n = Number(s[dayKey(d)]) || 0;
    const day = document.createElement('div'); day.className = 'day';
    const dot = document.createElement('div');
    dot.className = 'dot' + (n > 0 ? ' on' : '') + (i === 0 ? ' today' : '');
    dot.textContent = n > 1 ? '🌟' : n === 1 ? '⭐' : '';
    const lab = document.createElement('span'); lab.textContent = names[d.getDay()];
    day.appendChild(dot); day.appendChild(lab); el.appendChild(day);
  }
}

// ---------------------------------------------------------------- 효과음 (파일 없이 합성)
const Sfx = {
  ctx: null,
  unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) { /* 소리 없이 진행 */ }
  },
  tone(freq, dur, o) {
    o = o || {};
    if (!settings.sfx || !this.ctx || this.ctx.state !== 'running') return;
    try {
      const t0 = this.ctx.currentTime + (o.delay || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
      const v = o.vol == null ? 0.16 : o.vol;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(v, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(this.ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    } catch (e) { /* ignore */ }
  },
  pop() { this.tone(520, 0.12, { to: 980, vol: 0.14 }); },
  nom() { this.tone(260, 0.07, { type: 'triangle', vol: 0.1 }); this.tone(220, 0.07, { type: 'triangle', vol: 0.1, delay: 0.11 }); },
  flee() { this.tone(380, 0.35, { to: 1400, vol: 0.13 }); },
  sparkle() { [1320, 1760, 2093].forEach((f, i) => this.tone(f, 0.18, { type: 'triangle', vol: 0.07, delay: i * 0.07 })); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i === 3 ? 0.5 : 0.18, { type: 'triangle', vol: 0.13, delay: i * 0.13 })); },
};

// ---------------------------------------------------------------- 목소리 + 자막
const captionEl = $('#caption');
let captionTimer = 0;
function showCaption(text, ms) {
  captionEl.textContent = text;
  captionEl.classList.remove('show');
  void captionEl.offsetWidth;
  captionEl.classList.add('show');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => captionEl.classList.remove('show'), ms || 3800);
}
function hideCaption() { clearTimeout(captionTimer); captionEl.classList.remove('show'); }

const hasTTS = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
const Voice = {
  voice: null,
  init() {
    if (!hasTTS) return;
    const pick = () => {
      try {
        const ko = (speechSynthesis.getVoices() || []).filter((v) => /^ko/i.test(v.lang));
        this.voice = ko.find((v) => /yuna|유나/i.test(v.name)) || ko[0] || null;
      } catch (e) { this.voice = null; }
    };
    pick();
    try { speechSynthesis.addEventListener('voiceschanged', pick); } catch (e) { speechSynthesis.onvoiceschanged = pick; }
  },
  unlock() { // 사용자 탭 안에서 호출해야 iOS가 이후 음성을 허용합니다
    if (!hasTTS || !settings.voice) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; u.lang = 'ko-KR'; speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  },
  busy() {
    try { return hasTTS && !!settings.voice && (speechSynthesis.speaking || speechSynthesis.pending); } catch (e) { return false; }
  },
  say(text, o) {
    o = o || {};
    if (o.polite && this.busy()) return; // 다른 안내가 나오는 중이면 덜 중요한 말은 건너뜁니다
    showCaption(o.caption || text, o.ms || Math.max(2800, text.length * 170));
    if (!hasTTS || !settings.voice) return;
    const speak = () => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        if (this.voice) u.voice = this.voice;
        u.rate = 1.0; u.pitch = 1.2; u.volume = 1;
        speechSynthesis.speak(u);
        if (speechSynthesis.paused) speechSynthesis.resume();
      } catch (e) { /* ignore */ }
    };
    try {
      if (speechSynthesis.speaking || speechSynthesis.pending) {
        speechSynthesis.cancel();
        setTimeout(speak, 80); // iOS는 cancel 직후 speak를 가끔 무시합니다
      } else speak();
    } catch (e) { /* ignore */ }
  },
  stop() { try { if (hasTTS) speechSynthesis.cancel(); } catch (e) { /* ignore */ } },
};

// ---------------------------------------------------------------- 오류 타입
class AppError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
}
function withTimeout(p, ms, code) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError(code, new Error('timeout'))), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------- 얼굴 인식 모델
let landmarker = null;
let delegate = '';
let modelPromise = null;
let wasmFileset = null;
let modelBytes = null;
let switching = false;

async function fetchModelBytes() {
  let lastErr = null;
  for (const url of MODEL_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 500000) throw new Error('model too small');
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('model download failed');
}
async function createLandmarker(cpuOnly) {
  const order = cpuOnly ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr = null;
  for (const d of order) {
    try {
      const lm = await FaceLandmarker.createFromOptions(wasmFileset, {
        baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate: d },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      delegate = d;
      return lm;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('landmarker failed');
}
function loadModel() {
  if (landmarker) return Promise.resolve(landmarker);
  if (!modelPromise) {
    modelPromise = (async () => {
      try {
        if (!wasmFileset) wasmFileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', location.href).href);
        if (!modelBytes) modelBytes = await fetchModelBytes();
        landmarker = await createLandmarker(false);
        return landmarker;
      } catch (e) {
        throw e instanceof AppError ? e : new AppError('model', e);
      }
    })();
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}
async function fallbackToCpu() {
  if (switching || !modelBytes || !wasmFileset) return;
  switching = true;
  const old = landmarker;
  landmarker = null;
  try { if (old) old.close(); } catch (e) { /* ignore */ }
  try { landmarker = await createLandmarker(true); detectErrors = 0; }
  catch (e) { showError(new AppError('model', e)); }
  finally { switching = false; }
}

// ---------------------------------------------------------------- 카메라
const video = $('#cam');
let stream = null;

async function startCamera() {
  if (!window.isSecureContext) throw new AppError('insecure');
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) throw new AppError('unsupported');
  stopCamera();
  const denied = (e) => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError');
  try {
    stream = await md.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
    });
  } catch (e) {
    if (denied(e)) throw new AppError('denied', e);
    if (e && (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError')) throw new AppError('nocamera', e);
    try {
      stream = await md.getUserMedia({ audio: false, video: { facingMode: 'user' } });
    } catch (e2) {
      if (denied(e2)) throw new AppError('denied', e2);
      if (e2 && (e2.name === 'NotReadableError' || e2.name === 'TrackStartError' || e2.name === 'AbortError')) throw new AppError('busy', e2);
      throw new AppError('camera', e2);
    }
  }
  video.muted = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* waitForVideo에서 다시 시도 */ }
  await waitForVideo(7000);
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', onTrackEnded));
}
function waitForVideo(timeout) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
      if (performance.now() - t0 > timeout) return reject(new AppError('camera', new Error('video timeout')));
      if (video.paused) video.play().catch(() => {});
      setTimeout(check, 100);
    };
    check();
  });
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
  stream = null;
  try { video.srcObject = null; } catch (e) { /* ignore */ }
}
function onTrackEnded() { if (isLive()) pauseSession(); }

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
function releaseAwake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }

// ---------------------------------------------------------------- 화면 좌표 + 떨림 제거
const fx = $('#fx');
const ctx = fx.getContext('2d');
let W = 0, H = 0, dpr = 1;

class LowPass {
  constructor() { this.y = null; }
  filter(x, a) { this.y = this.y == null ? x : this.y + a * (x - this.y); return this.y; }
  reset() { this.y = null; }
}
class OneEuro {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.lastT = null;
  }
  alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, t) {
    if (this.lastT == null || this.x.y == null) { this.lastT = t; this.dx.reset(); return this.x.filter(v, 1); }
    let dt = (t - this.lastT) / 1000;
    if (!(dt > 0)) dt = 1 / 60;
    this.lastT = t;
    const d = (v - this.x.y) / dt;
    const ed = this.dx.filter(d, this.alpha(this.dCutoff, dt));
    return this.x.filter(v, this.alpha(this.minCutoff + this.beta * Math.abs(ed), dt));
  }
  reset() { this.x.reset(); this.dx.reset(); this.lastT = null; }
}
const filters = new Map();
TRACK.forEach((i) => filters.set(i, [new OneEuro(1.6, 0.012, 1), new OneEuro(1.6, 0.012, 1)]));
const pts = new Map();
TRACK.forEach((i) => pts.set(i, { x: 0, y: 0 }));
const tmpPt = { x: 0, y: 0 };

let mouth = null;
let lipBox = null;
let faceSeenAt = -1e9;
let faceSize = 0;
let mouthOpen = false;

function resetTracking() {
  filters.forEach((f) => { f[0].reset(); f[1].reset(); });
  mouth = null; lipBox = null; faceSeenAt = -1e9; faceSize = 0; mouthOpen = false;
  prevGrayOk = false; motion = 0; lastVideoTime = -1;
}
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = fx.getBoundingClientRect();
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  filters.forEach((f) => { f[0].reset(); f[1].reset(); });
}
function mapPoint(lm, out) {
  // <video>는 object-fit: cover + 좌우 반전으로 그려집니다. 같은 변환을 적용합니다.
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const s = Math.max(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  out.x = W - (ox + lm.x * dw);
  out.y = oy + lm.y * dh;
  return out;
}
function onResult(res, t) {
  const faces = res && res.faceLandmarks;
  if (!faces || !faces.length) return;
  const lm = faces[0];
  if (!lm || lm.length < 455) return;
  for (let k = 0; k < TRACK.length; k++) {
    const i = TRACK[k];
    mapPoint(lm[i], tmpPt);
    const f = filters.get(i);
    const p = pts.get(i);
    p.x = f[0].filter(tmpPt.x, t);
    p.y = f[1].filter(tmpPt.y, t);
  }
  let minx = 1, miny = 1, maxx = 0, maxy = 0;
  for (let k = 0; k < UPPER.length; k++) {
    const a = lm[UPPER[k]], b = lm[LOWER[k]];
    minx = Math.min(minx, a.x, b.x); maxx = Math.max(maxx, a.x, b.x);
    miny = Math.min(miny, a.y, b.y); maxy = Math.max(maxy, a.y, b.y);
  }
  lipBox = { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
  faceSeenAt = t;
  faceSize = dist(pts.get(FACE_EDGE[0]), pts.get(FACE_EDGE[1]));
  mouth = buildMouth();
}
function buildMouth() {
  const up = UPPER.map((i) => pts.get(i));
  const lo = LOWER.map((i) => pts.get(i));
  const n = up.length - 1;
  const flip = up[0].x > up[n].x; // 거울 화면에서는 78번이 오른쪽에 옵니다
  const L = flip ? up[n] : up[0];
  const R = flip ? up[0] : up[n];
  const width = Math.max(1, dist(L, R));
  const gap = dist(up[5], lo[5]);
  return {
    up: up, lo: lo, flip: flip, width: width, gap: gap, ratio: gap / width,
    angle: Math.atan2(R.y - L.y, R.x - L.x),
    cx: (up[5].x + lo[5].x) / 2, cy: (up[5].y + lo[5].y) / 2,
  };
}
// us: 화면 기준 왼쪽 0 → 오른쪽 1, v: 윗입술 안쪽 0 → 아랫입술 안쪽 1
function mouthPoint(m, us, v, out) {
  const u = m.flip ? 1 - us : us;
  const n = m.up.length - 1;
  const f = clamp(u, 0, 1) * n;
  let i = Math.floor(f); if (i >= n) i = n - 1;
  const t = f - i;
  const a = m.up[i], a2 = m.up[i + 1], b = m.lo[i], b2 = m.lo[i + 1];
  const ax = a.x + (a2.x - a.x) * t, ay = a.y + (a2.y - a.y) * t;
  const bx = b.x + (b2.x - b.x) * t, by = b.y + (b2.y - b.y) * t;
  out.x = ax + (bx - ax) * v; out.y = ay + (by - ay) * v;
  return out;
}
function faceHoldMs() { return Math.max(FACE_HOLD_MS, detectInterval + detectMs * 2 + 120); }
function faceVisible(now) { return now - faceSeenAt < faceHoldMs() && !!mouth; }
function updateMouthOpen(now) {
  if (!faceVisible(now)) { mouthOpen = false; return; }
  if (!mouthOpen && mouth.ratio > OPEN_ENTER) mouthOpen = true;
  else if (mouthOpen && mouth.ratio < OPEN_EXIT) mouthOpen = false;
}

// ---------------------------------------------------------------- 검출 루프
let lastVideoTime = -1, lastDetectAt = 0, detectMs = 0, detectInterval = 0, lastTs = 0, detectErrors = 0;
function detect(now) {
  if (!landmarker || switching || !stream || video.readyState < 2 || !video.videoWidth) return;
  // 새 프레임일 때만 검출 (currentTime이 멈춰 보이는 브라우저 대비 100ms마다는 강제로 실행)
  if (video.currentTime === lastVideoTime && now - lastDetectAt < 100) return;
  if (now - lastDetectAt < detectInterval) return;
  lastVideoTime = video.currentTime;
  lastDetectAt = now;
  const ts = Math.max(Math.round(now), lastTs + 1);
  lastTs = ts;
  const t0 = performance.now();
  let res = null;
  try {
    res = landmarker.detectForVideo(video, ts);
    detectErrors = 0;
  } catch (e) {
    detectErrors++;
    if (detectErrors >= 3 && delegate === 'GPU') fallbackToCpu();
    return;
  }
  const ms = performance.now() - t0;
  detectMs = detectMs ? detectMs * 0.9 + ms * 0.1 : ms;
  // 느린 기기에서는 검출 횟수를 줄여 화면이 끊기지 않게 합니다
  detectInterval = detectMs > 45 ? 90 : detectMs > 28 ? 55 : 0;
  onResult(res, now);
}

// 입 주변 움직임 (양치 감지) — 32x24로 줄여 프레임 차이를 봅니다
const mCanvas = document.createElement('canvas');
mCanvas.width = 32; mCanvas.height = 24;
const mctx = mCanvas.getContext('2d', { willReadFrequently: true });
const prevGray = new Float32Array(32 * 24);
let prevGrayOk = false, motion = 0, lastMotionAt = 0;
function sampleMotion(now) {
  if (!lipBox || !stream || now - lastMotionAt < 90) return;
  if (now - faceSeenAt > faceHoldMs()) { prevGrayOk = false; motion *= 0.9; return; }
  lastMotionAt = now;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const cx = (lipBox.minx + lipBox.maxx) / 2 * vw;
  const cy = (lipBox.miny + lipBox.maxy) / 2 * vh;
  const mw = Math.max((lipBox.maxx - lipBox.minx) * vw, 24);
  const sw = mw * 2.4, sh = mw * 1.9;
  const sx = clamp(cx - sw / 2, 0, vw - 2), sy = clamp(cy - sh * 0.4, 0, vh - 2);
  const w2 = Math.min(sw, vw - sx), h2 = Math.min(sh, vh - sy);
  if (w2 < 8 || h2 < 8) return;
  try {
    mctx.drawImage(video, sx, sy, w2, h2, 0, 0, 32, 24);
    const d = mctx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      sum += Math.abs(g - prevGray[j]);
      prevGray[j] = g;
    }
    if (prevGrayOk) motion = motion * 0.6 + (sum / 768) * 0.4;
    prevGrayOk = true;
  } catch (e) { /* 읽기 실패 시 시간 기반으로만 진행 */ }
}

// ---------------------------------------------------------------- 벌레 + 효과
const COLORS = ['#7ed957', '#ff9ec7', '#b49cff', '#ffc94d', '#6fd3ff', '#ff9f68', '#a0e75a', '#f3a6ff'];
// [구역, 화면 기준 u, v] 구역: 0 윗니 왼쪽, 1 윗니 오른쪽, 2 아랫니 왼쪽, 3 아랫니 오른쪽 (화면 기준)
const SLOTS = [
  [0, 0.2, 0.2], [0, 0.38, 0.24], [1, 0.62, 0.24], [1, 0.8, 0.2],
  [2, 0.2, 0.8], [2, 0.38, 0.76], [3, 0.62, 0.76], [3, 0.8, 0.8],
];
let worms = [];
let parts = [];
let bubbles = [];

function makeWorms() {
  worms = SLOTS.map((s, i) => ({
    id: i, zone: s[0], u: s[1] + (Math.random() - 0.5) * 0.03, v: s[2], color: COLORS[i],
    phase: Math.random() * 6.28, order: i % 2, state: 'hidden', t: 0,
    x: 0, y: 0, r: 10, angle: 0, vx: 0, vy: 0, spin: 0, rot: 0, scared: 0,
  }));
}
function addPart(p) { if (parts.length > 140) parts.shift(); parts.push(p); }
function addBubble(text, wid, life) {
  for (let i = 0; i < bubbles.length; i++) if (bubbles[i].wid === wid) return;
  if (bubbles.length >= 2) bubbles.shift();
  bubbles.push({ text: text, wid: wid, life: life || 1.2, max: life || 1.2 });
}
function wormSize(m) { return clamp(m.width * 0.032, 4, 24); }

function flee(w) {
  if (w.state !== 'eating' && w.state !== 'popping') return;
  w.state = 'fleeing'; w.t = 0;
  Sfx.flee();
}
function launch(w) {
  // 놀란 뒤 입 밖으로 폴짝 뛰어나갑니다
  const cx = mouth ? mouth.cx : W / 2, cy = mouth ? mouth.cy : H / 2;
  let dx = w.x - cx, dy = w.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  if (Math.abs(dx) < 0.3) dx = w.u < 0.5 ? -0.6 : 0.6;
  const sp = Math.max(W, H) * 0.42;
  w.vx = dx * sp;
  w.vy = -Math.max(H * 0.55, 260) + dy * sp * 0.2;
  w.spin = (dx > 0 ? 1 : -1) * 3.2;
  w.state = 'flying'; w.t = 0;
  addBubble('안녕~', w.id, 1.1);
}

// ---------------------------------------------------------------- 상태 머신
let state = 'home';
let stateT = 0;
let resumeState = null;
let brushT = 0, zoneIdx = -1, zoneP = 0, halfSaid = false;
let faceHold = 0, openHold = 0, lostT = 0, lastPromptAt = 0, nomT = 0, lastFleeVoice = -99, sparkleT = 0;
let hintText = '';
const LIVE = ['findFace', 'openMouth', 'reveal', 'brushing', 'celebrate'];
function isLive() { return LIVE.indexOf(state) >= 0; }

const ZONE_LINES = [
  '반짝이는 별 쪽! 위에 이부터 쓱쓱!',
  '이번엔 위에 이 반대쪽! 쓱쓱!',
  '이제 아래 이! 별 있는 곳 쓱쓱!',
  '마지막! 아래 이 반대쪽 쓱쓱!',
];

function setState(s) {
  state = s; stateT = 0;
  faceHold = 0; openHold = 0; lostT = 0; lastPromptAt = 0;
  if (s === 'findFace') {
    showHud(false);
    Voice.say('얼굴을 동그라미 안에 쏙 넣어 볼까?');
  } else if (s === 'openMouth') {
    setHint('');
    Voice.say('입을 아~ 크게 벌려 볼까?', { caption: '입을 아~ 크게! 😮' });
  } else if (s === 'reveal') {
    setHint('');
    makeWorms();
    nomT = 0;
    Voice.say('어? 이에 꼬물꼬물 벌레들이 있네! 냠냠 먹고 있어!');
  } else if (s === 'brushing') {
    brushT = 0; zoneIdx = -1; zoneP = 0; halfSaid = false;
    hudKey = ''; hudPct = -1;
    showHud(true);
    Voice.say('칫솔로 쓱쓱 닦아서 벌레들을 쫓아내자!');
  } else if (s === 'celebrate') {
    showHud(false);
    setHint('');
    Sfx.fanfare();
    sparkleT = 0;
    addSticker();
    Voice.say('벌레들이 모두 도망갔어! 이가 반짝반짝해졌어! 최고야!');
    for (let i = 0; i < 60; i++) {
      addPart({
        kind: 'confetti', x: Math.random() * W, y: -20 - Math.random() * H * 0.4,
        vx: (Math.random() - 0.5) * 60, vy: 120 + Math.random() * 160, g: 60,
        life: 3.2, max: 3.2, size: 6 + Math.random() * 6, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8,
        color: COLORS[i % COLORS.length],
      });
    }
  }
}
function startZone(zi) {
  zoneIdx = zi; zoneP = 0;
  // 앞 구역에 남은 벌레는 바로 도망 (시간이 지나면 항상 끝나도록)
  worms.forEach((w) => { if (w.zone < zi) flee(w); });
  if (zi > 0) Voice.say(ZONE_LINES[zi]);
  else setTimeout(() => { if (state === 'brushing' && zoneIdx === 0) Voice.say(ZONE_LINES[0], { polite: true }); }, 3400);
  Sfx.sparkle();
  updateHud();
}

function update(dt, now, realDt) {
  stateT += dt;
  const seen = faceVisible(now);
  updateMouthOpen(now);

  if (state === 'findFace') {
    const near = seen && faceSize > Math.min(W, H) * 0.28;
    faceHold = seen ? faceHold + dt : 0;
    if (seen && !near) {
      setHint('조금 더 가까이 와 볼까요?');
      if (stateT - lastPromptAt > 7) { lastPromptAt = stateT; Voice.say('조금 더 가까이 와 볼까?', { polite: true }); }
    } else setHint('');
    if (faceHold > 0.5 && near) setState('openMouth');
    else if (!seen && stateT - lastPromptAt > 8 && stateT > 4) { lastPromptAt = stateT; Voice.say('얼굴을 동그라미 안에 쏙!', { polite: true }); }
  } else if (state === 'openMouth') {
    lostT = seen ? 0 : lostT + dt;
    if (lostT > 2.5) { setState('findFace'); return; }
    openHold = mouthOpen ? openHold + dt : 0;
    if (openHold > 0.35) { setState('reveal'); return; }
    if (stateT - lastPromptAt > 7) { lastPromptAt = stateT; Voice.say('아~ 해 볼까? 입을 크게!', { polite: true, caption: '입을 아~ 크게! 😮' }); }
  } else if (state === 'reveal') {
    worms.forEach((w, i) => {
      if (w.state === 'hidden' && stateT > 0.3 + i * 0.18) { w.state = 'popping'; w.t = 0; Sfx.pop(); }
    });
    nomT += dt;
    if (nomT > 0.9 && mouthOpen) { nomT = 0; Sfx.nom(); const w = worms[(Math.random() * worms.length) | 0]; addBubble('냠냠', w.id, 0.9); }
    if (stateT > 5.5) setState('brushing');
  } else if (state === 'brushing') {
    const total = brushDuration();
    const zd = total / 4;
    brushT += realDt; // 양치 시간은 화면이 느려도 실제 시간 기준
    const zi = Math.min(3, Math.floor(brushT / zd));
    if (zi !== zoneIdx) startZone(zi);
    const brushing = seen && motion > MOTION_T;
    zoneP += (realDt / zd) * (brushing ? 1.7 : 1.0);
    worms.forEach((w) => {
      if (w.zone !== zoneIdx) { w.scared = Math.max(0, w.scared - dt * 3); return; }
      w.scared = brushing ? Math.min(1, w.scared + dt * 5) : Math.max(0, w.scared - dt * 3);
      const threshold = w.order === 0 ? 0.35 : 0.75;
      if ((w.state === 'eating' || w.state === 'popping') && zoneP >= threshold) {
        flee(w);
        if (stateT - lastFleeVoice > 9) { lastFleeVoice = stateT; Voice.say('와! 벌레가 도망간다!', { polite: true }); }
      }
    });
    nomT += dt;
    if (nomT > 2.4 && mouthOpen) {
      nomT = 0;
      const left = worms.filter((w) => w.state === 'eating' && w.zone !== zoneIdx);
      if (left.length) { Sfx.nom(); addBubble('냠냠', left[(Math.random() * left.length) | 0].id, 0.9); }
    }
    if (!halfSaid && brushT >= total / 2) { halfSaid = true; setTimeout(() => { if (state === 'brushing') Voice.say('절반 왔어! 정말 잘하고 있어!', { polite: true }); }, 3200); }
    if (!seen && brushT > 1) setHint('얼굴이 화면에 보이게 해 줘요'); else setHint('');
    updateHud();
    if (brushT >= total) {
      worms.forEach(flee);
      setState('celebrate');
    }
  } else if (state === 'celebrate') {
    sparkleT += dt;
    if (seen && sparkleT > 0.07 && stateT < 2.6) {
      sparkleT = 0;
      const p = mouthPoint(mouth, 0.1 + Math.random() * 0.8, Math.random() < 0.5 ? 0.15 + Math.random() * 0.15 : 0.7 + Math.random() * 0.15, { x: 0, y: 0 });
      addPart({ kind: 'star', inMouth: false, x: p.x, y: p.y, vx: 0, vy: -10, g: 0, life: 0.7, max: 0.7, size: Math.max(6, mouth.width * 0.07), rot: Math.random() * 6, vr: 3, color: '#fff7b0' });
    }
    if (stateT > 3.6) finishSession();
  }
  updateWorms(dt, now, seen);
  updateParts(dt);
}

function updateWorms(dt, now, seen) {
  for (let i = 0; i < worms.length; i++) {
    const w = worms[i];
    w.t += dt;
    if (w.state === 'popping' && w.t > 0.45) { w.state = 'eating'; w.t = 0; }
    if ((w.state === 'popping' || w.state === 'eating' || w.state === 'fleeing') && seen) {
      mouthPoint(mouth, w.u, w.v, tmpPt);
      w.x = tmpPt.x; w.y = tmpPt.y; w.r = wormSize(mouth); w.angle = mouth.angle;
    }
    if (w.state === 'eating' && seen && mouthOpen && Math.random() < dt * 1.2) {
      const up = w.v < 0.5 ? 1 : -1;
      addPart({ kind: 'crumb', x: w.x, y: w.y, vx: (Math.random() - 0.5) * 50, vy: -40 * up - 20, g: 160, life: 0.8, max: 0.8, size: Math.max(1.5, w.r * 0.22), color: Math.random() < 0.5 ? '#fff4c2' : '#ffffff' });
    }
    if (w.state === 'fleeing' && w.t > 0.32) launch(w);
    if (w.state === 'flying') {
      w.x += w.vx * dt; w.y += w.vy * dt; w.vy += Math.max(H, 600) * 1.4 * dt; w.rot += w.spin * dt;
      if (w.t > 1.9 || w.y > H + 80 || w.x < -80 || w.x > W + 80) w.state = 'gone';
    }
  }
  for (let i = bubbles.length - 1; i >= 0; i--) { bubbles[i].life -= dt; if (bubbles[i].life <= 0) bubbles.splice(i, 1); }
}
function updateParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt;
    if (p.vr) p.rot += p.vr * dt;
  }
}

// ---------------------------------------------------------------- 그리기
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => clamp(Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt), 0, 255);
  return 'rgb(' + f((n >> 16) & 255) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
}
function circle(c, x, y, r, fill, stroke, lw) {
  c.beginPath(); c.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw || 1; c.stroke(); }
}
// 귀여운 애벌레: 둥근 몸 마디 + 큰 눈 + 볼터치. mood: eat | happy | scared
function drawWorm(c, w, x, y, r, angle, mood, t, alpha, scale) {
  c.save();
  c.globalAlpha = alpha;
  c.translate(x, y);
  c.rotate(angle);
  const facing = w.u < 0.5 ? 1 : -1;
  c.scale(scale * facing, scale);
  const outline = shade(w.color, -0.25);
  const lw = Math.max(1, r * 0.12);
  const shake = mood === 'scared' ? Math.sin(t * 40) * r * 0.12 : 0;
  for (let k = 0; k < 4; k++) {
    const sx = (k - 4) * r * 1.0 + shake;
    const sy = Math.sin(t * 7 + w.phase - k * 0.9) * r * 0.28;
    const rr = r * (0.72 + k * 0.07);
    circle(c, sx, sy, rr, w.color, outline, lw);
    circle(c, sx - rr * 0.3, sy - rr * 0.35, rr * 0.28, 'rgba(255,255,255,0.4)');
  }
  const hr = r * 1.22;
  let hy = Math.sin(t * 7 + w.phase + 0.9) * r * 0.15;
  if (mood === 'eat') hy += Math.sin(t * 12 + w.phase) * r * 0.12;
  const hx = shake;
  c.strokeStyle = outline; c.lineWidth = lw; c.lineCap = 'round';
  c.beginPath();
  c.moveTo(hx - hr * 0.3, hy - hr * 0.8); c.lineTo(hx - hr * 0.5, hy - hr * 1.45);
  c.moveTo(hx + hr * 0.3, hy - hr * 0.8); c.lineTo(hx + hr * 0.5, hy - hr * 1.45);
  c.stroke();
  circle(c, hx - hr * 0.5, hy - hr * 1.45, r * 0.2, '#ffe066');
  circle(c, hx + hr * 0.5, hy - hr * 1.45, r * 0.2, '#ffe066');
  circle(c, hx, hy, hr, shade(w.color, 0.12), outline, lw);
  const big = mood === 'scared' ? 1.2 : 1;
  const ex = hr * 0.38, ey = hy - hr * 0.12;
  circle(c, hx - ex, ey, hr * 0.3 * big, '#ffffff');
  circle(c, hx + ex, ey, hr * 0.3 * big, '#ffffff');
  const pr = hr * (mood === 'scared' ? 0.11 : 0.16);
  circle(c, hx - ex + hr * 0.04, ey + hr * 0.03, pr, '#2b2240');
  circle(c, hx + ex + hr * 0.04, ey + hr * 0.03, pr, '#2b2240');
  circle(c, hx - ex - hr * 0.04, ey - hr * 0.07, pr * 0.4, '#ffffff');
  circle(c, hx + ex - hr * 0.04, ey - hr * 0.07, pr * 0.4, '#ffffff');
  circle(c, hx - hr * 0.62, hy + hr * 0.3, hr * 0.16, 'rgba(255,110,150,0.55)');
  circle(c, hx + hr * 0.62, hy + hr * 0.3, hr * 0.16, 'rgba(255,110,150,0.55)');
  c.fillStyle = '#8a3a48';
  if (mood === 'eat') {
    const open = (Math.sin(t * 12 + w.phase) + 1) / 2;
    c.beginPath(); c.ellipse(hx, hy + hr * 0.42, hr * 0.2, hr * (0.05 + 0.12 * open), 0, 0, Math.PI * 2); c.fill();
  } else if (mood === 'scared') {
    circle(c, hx, hy + hr * 0.45, hr * 0.13, '#8a3a48');
    c.fillStyle = 'rgba(140,210,255,0.9)';
    c.beginPath();
    c.moveTo(hx + hr * 0.95, hy - hr * 0.95);
    c.quadraticCurveTo(hx + hr * 1.15, hy - hr * 0.55, hx + hr * 0.95, hy - hr * 0.5);
    c.quadraticCurveTo(hx + hr * 0.75, hy - hr * 0.55, hx + hr * 0.95, hy - hr * 0.95);
    c.fill();
  } else {
    c.strokeStyle = '#8a3a48'; c.lineWidth = Math.max(1, hr * 0.1);
    c.beginPath(); c.arc(hx, hy + hr * 0.25, hr * 0.28, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  }
  c.restore();
}
function starPath(c, x, y, r, rot) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    if (i === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath();
}
function clipMouth(c, m) {
  c.beginPath();
  c.moveTo(m.up[0].x, m.up[0].y);
  for (let i = 1; i < m.up.length; i++) c.lineTo(m.up[i].x, m.up[i].y);
  for (let i = m.lo.length - 1; i >= 0; i--) c.lineTo(m.lo[i].x, m.lo[i].y);
  c.closePath();
  c.clip();
}
function drawGuide(now, seen) {
  const rx = Math.min(W, H) * 0.34, ry = rx * 1.3;
  ctx.save();
  ctx.setLineDash([14, 12]);
  ctx.lineDashOffset = -now / 40;
  ctx.lineWidth = 5;
  ctx.strokeStyle = seen ? 'rgba(110,230,160,0.95)' : 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.ellipse(W / 2, H * 0.47, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
function drawZoneStar(now, m) {
  const us = zoneIdx % 2 === 0 ? 0.29 : 0.71;
  const upper = zoneIdx < 2;
  mouthPoint(m, us, upper ? 0 : 1, tmpPt);
  const off = m.width * 0.24 * (upper ? 1 : -1);
  const x = tmpPt.x + Math.sin(m.angle) * off;
  const y = tmpPt.y - Math.cos(m.angle) * off;
  const s = Math.max(12, m.width * 0.12) * (1 + Math.sin(now / 180) * 0.12);
  ctx.save();
  circle(ctx, x, y, s * 1.6, 'rgba(255,230,120,0.28)');
  starPath(ctx, x, y, s, now / 900);
  ctx.fillStyle = '#ffd43b'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  ctx.restore();
}
function drawBubble(text, x, y, size, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '800 ' + size + 'px -apple-system, "Apple SD Gothic Neo", sans-serif';
  const tw = ctx.measureText(text).width;
  const pw = tw + size * 1.0, ph = size * 1.6;
  const bx = x - pw / 2, by = y - ph;
  const rad = ph / 2;
  ctx.beginPath();
  ctx.moveTo(bx + rad, by); ctx.lineTo(bx + pw - rad, by);
  ctx.arc(bx + pw - rad, by + rad, rad, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + size * 0.3, by + ph); ctx.lineTo(x, by + ph + size * 0.45); ctx.lineTo(x - size * 0.15, by + ph);
  ctx.lineTo(bx + rad, by + ph);
  ctx.arc(bx + rad, by + rad, rad, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#b49cff'; ctx.stroke();
  ctx.fillStyle = '#2b2240'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, by + ph / 2 + 1);
  ctx.restore();
}
function drawParts(inMouth) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!!p.inMouth !== inMouth) continue;
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a;
    if (p.kind === 'crumb') circle(ctx, p.x, p.y, p.size, p.color);
    else if (p.kind === 'star') { starPath(ctx, p.x, p.y, p.size * (0.6 + 0.4 * a), p.rot); ctx.fillStyle = p.color; ctx.fill(); }
    else if (p.kind === 'confetti') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}
function render(now) {
  ctx.clearRect(0, 0, W, H);
  if (!isLive()) return;
  const seen = faceVisible(now);
  if (state === 'findFace') drawGuide(now, seen);
  if (seen && (state === 'reveal' || state === 'brushing' || state === 'celebrate')) {
    ctx.save();
    clipMouth(ctx, mouth);
    for (let i = 0; i < worms.length; i++) {
      const w = worms[i];
      if (w.state === 'popping') {
        const k = clamp(w.t / 0.45, 0, 1);
        const s = k < 0.7 ? (k / 0.7) * 1.15 : 1.15 - (k - 0.7) / 0.3 * 0.15;
        drawWorm(ctx, w, w.x, w.y, w.r, w.angle, 'happy', now / 1000, 1, Math.max(0.05, s));
      } else if (w.state === 'eating') {
        drawWorm(ctx, w, w.x, w.y, w.r, w.angle, w.scared > 0.5 ? 'scared' : 'eat', now / 1000, 1, 1);
      } else if (w.state === 'fleeing') {
        drawWorm(ctx, w, w.x, w.y, w.r, w.angle, 'scared', now / 1000, 1, 1 + w.t * 0.4);
      }
    }
    drawParts(true);
    ctx.restore();
    if (state === 'brushing' && zoneIdx >= 0) drawZoneStar(now, mouth);
  }
  for (let i = 0; i < worms.length; i++) {
    const w = worms[i];
    if (w.state !== 'flying') continue;
    const a = w.t > 1.4 ? clamp(1 - (w.t - 1.4) / 0.5, 0, 1) : 1;
    drawWorm(ctx, w, w.x, w.y, w.r, w.angle + w.rot, 'scared', now / 1000, a, 1.3);
  }
  drawParts(false);
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    const w = worms[b.wid];
    if (!w || w.state === 'gone' || w.state === 'hidden') continue;
    if (w.state !== 'flying' && !seen) continue;
    const size = clamp(w.r * 1.5, 13, 26);
    const yOff = w.state === 'flying' ? w.r * 3.2 : (w.v < 0.5 ? w.r * 2.6 + (mouth ? mouth.width * 0.08 : 0) : -w.r * 4.2 - (mouth ? mouth.width * 0.05 : 0));
    drawBubble(b.text, w.x, w.y - yOff, size, clamp(b.life / 0.25, 0, 1));
  }
  if (settings.debug && mouth && seen) {
    ctx.save();
    ctx.strokeStyle = mouthOpen ? '#00ff88' : '#ffcc00'; ctx.lineWidth = 2;
    ctx.beginPath();
    mouth.up.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    for (let i = mouth.lo.length - 1; i >= 0; i--) ctx.lineTo(mouth.lo[i].x, mouth.lo[i].y);
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------- 홈 화면 그림
const homeCanvas = $('#homeWorm');
const hctx = homeCanvas.getContext('2d');
const homeWorms = [
  { u: 0.2, v: 0, phase: 0, color: '#7ed957' },
  { u: 0.8, v: 0, phase: 2, color: '#ff9ec7' },
];
function toothPath(c, cx, cy, s) {
  c.beginPath();
  c.moveTo(cx - s, cy - s * 0.3);
  c.bezierCurveTo(cx - s, cy - s * 1.1, cx - s * 0.3, cy - s * 1.0, cx, cy - s * 0.75);
  c.bezierCurveTo(cx + s * 0.3, cy - s * 1.0, cx + s, cy - s * 1.1, cx + s, cy - s * 0.3);
  c.bezierCurveTo(cx + s, cy + s * 0.3, cx + s * 0.7, cy + s * 0.5, cx + s * 0.6, cy + s * 1.0);
  c.bezierCurveTo(cx + s * 0.5, cy + s * 1.3, cx + s * 0.25, cy + s * 1.2, cx + s * 0.15, cy + s * 0.7);
  c.quadraticCurveTo(cx, cy + s * 0.45, cx - s * 0.15, cy + s * 0.7);
  c.bezierCurveTo(cx - s * 0.25, cy + s * 1.2, cx - s * 0.5, cy + s * 1.3, cx - s * 0.6, cy + s * 1.0);
  c.bezierCurveTo(cx - s * 0.7, cy + s * 0.5, cx - s, cy + s * 0.3, cx - s, cy - s * 0.3);
  c.closePath();
}
function drawHome(now) {
  const c = hctx, w = homeCanvas.width, h = homeCanvas.height, t = now / 1000;
  c.clearRect(0, 0, w, h);
  const s = h * 0.33, cx = w / 2, cy = h * 0.5 + Math.sin(t * 2) * 4;
  toothPath(c, cx, cy, s);
  c.fillStyle = '#ffffff'; c.fill();
  c.lineWidth = 5; c.strokeStyle = '#d9d2f2'; c.stroke();
  circle(c, cx - s * 0.32, cy - s * 0.15, s * 0.09, '#2b2240');
  circle(c, cx + s * 0.32, cy - s * 0.15, s * 0.09, '#2b2240');
  circle(c, cx - s * 0.5, cy + s * 0.1, s * 0.1, 'rgba(255,120,150,0.5)');
  circle(c, cx + s * 0.5, cy + s * 0.1, s * 0.1, 'rgba(255,120,150,0.5)');
  c.strokeStyle = '#2b2240'; c.lineWidth = 4; c.lineCap = 'round';
  c.beginPath(); c.arc(cx, cy + s * 0.05, s * 0.18, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  starPath(c, cx + s * 0.95, cy - s * 0.95, s * 0.16, t); c.fillStyle = '#ffd43b'; c.fill();
  homeWorms.forEach((hw, i) => {
    const x = i === 0 ? cx - s * 1.3 : cx + s * 1.3;
    const y = cy + s * 0.55 + Math.sin(t * 3 + hw.phase) * 6;
    drawWorm(c, hw, x, y, s * 0.2, 0, 'happy', t, 1, 1);
  });
}

// ---------------------------------------------------------------- HUD / 화면 전환
const hud = $('#hud'), barFill = $('#barFill'), hintEl = $('#hint'), dbg = $('#debug');
function showHud(on) { hud.classList.toggle('show', !!on); }
const toothEls = $$('.tooth');
let hudPct = -1, hudKey = '';
function updateHud() {
  // 바뀐 것이 있을 때만 DOM을 건드립니다 (매 프레임 갱신 방지)
  const pct = Math.round(clamp(brushT / brushDuration(), 0, 1) * 200) / 2;
  if (pct !== hudPct) { hudPct = pct; barFill.style.width = pct + '%'; }
  const zoneClear = zoneIdx >= 0 && worms.every((w) => w.zone !== zoneIdx || w.state === 'gone' || w.state === 'flying');
  const key = zoneIdx + ':' + (zoneClear ? 1 : 0);
  if (key === hudKey) return;
  hudKey = key;
  toothEls.forEach((el) => {
    const z = Number(el.dataset.zone);
    el.classList.toggle('now', z === zoneIdx);
    el.classList.toggle('clean', z < zoneIdx || (z === zoneIdx && zoneClear));
    el.textContent = z < zoneIdx ? '✨' : '🦷';
  });
}
function setHint(text) {
  if (text === hintText) return;
  hintText = text;
  hintEl.textContent = text;
  hintEl.classList.toggle('show', !!text);
}
const SCREENS = ['home', 'loading', 'paused', 'done', 'error', 'settings'];
function showScreen(name) {
  SCREENS.forEach((s) => $('#' + s).classList.toggle('show', s === name));
  $('#gear').style.display = name === 'settings' || name === 'loading' ? 'none' : '';
}
function hideScreens() { showScreen(null); }

let sessionBusy = false;
async function startSession() {
  if (sessionBusy) return;
  sessionBusy = true;
  Sfx.unlock();
  Voice.unlock();
  showScreen('loading');
  $('#loadingMsg').textContent = '카메라를 켜고 있어요';
  try {
    await startCamera();
    $('#loadingMsg').textContent = '벌레 친구들을 부르고 있어요';
    await withTimeout(loadModel(), 90000, 'model');
    hideScreens();
    resetTracking();
    makeWorms();
    parts = []; bubbles = [];
    keepAwake();
    $('#exitBtn').classList.add('show');
    setState('findFace');
  } catch (e) {
    stopCamera();
    showError(e);
  } finally {
    sessionBusy = false;
  }
}
function finishSession() {
  stopCamera(); releaseAwake();
  state = 'done';
  showHud(false); setHint('');
  $('#exitBtn').classList.remove('show');
  renderWeek($('#doneWeek'));
  const n = Number(getStickers()[dayKey(new Date())]) || 1;
  $('#doneSticker').textContent = n > 1 ? '🌟' : '⭐';
  $('#doneMsg').textContent = n > 1 ? '오늘 ' + n + '번째 별 스티커!' : '오늘의 별 스티커를 받았어요';
  showScreen('done');
}
function goHome() {
  stopCamera(); releaseAwake(); Voice.stop(); hideCaption();
  state = 'home'; resumeState = null;
  worms = []; parts = []; bubbles = [];
  showHud(false); setHint('');
  $('#exitBtn').classList.remove('show');
  renderWeek($('#week'));
  showScreen('home');
}
function pauseSession() {
  if (!isLive()) return;
  resumeState = state;
  stopCamera(); releaseAwake(); Voice.stop(); hideCaption();
  state = 'paused';
  showHud(false); setHint('');
  $('#exitBtn').classList.remove('show');
  showScreen('paused');
}
async function resumeSession() {
  if (sessionBusy) return;
  sessionBusy = true;
  Sfx.unlock(); Voice.unlock();
  showScreen('loading');
  $('#loadingMsg').textContent = '카메라를 다시 켜고 있어요';
  try {
    await startCamera();
    await withTimeout(loadModel(), 90000, 'model');
    hideScreens();
    resetTracking();
    keepAwake();
    $('#exitBtn').classList.add('show');
    const prev = resumeState; resumeState = null;
    if (prev === 'brushing') {
      state = 'brushing'; hudKey = ''; hudPct = -1; showHud(true); updateHud();
      Voice.say(ZONE_LINES[Math.max(0, zoneIdx)]);
    } else if (prev === 'celebrate') {
      finishSession();
    } else {
      makeWorms(); parts = []; bubbles = [];
      setState('findFace');
    }
  } catch (e) {
    stopCamera();
    showError(e);
  } finally {
    sessionBusy = false;
  }
}

const ERRORS = {
  insecure: ['https 주소로 열어 주세요', '<p>카메라는 보안 주소(<b>https://</b>)에서만 켜져요. 배포한 https 주소로 다시 열어 주세요.</p>'],
  unsupported: ['Safari로 열어 주세요', '<p>이 화면에서는 카메라를 쓸 수 없어요. 아이폰 <b>Safari</b>(iOS 15 이상)로 열어 주세요.</p><p>카카오톡·인스타그램 안에서 열었다면, 메뉴에서 <b>Safari로 열기</b>를 눌러 주세요.</p>'],
  denied: ['카메라를 허용해 주세요', '<ol><li>Safari 주소창 왼쪽의 페이지 메뉴(<b>가가</b> 또는 <b>aA</b>)를 눌러요.</li><li><b>웹 사이트 설정 → 카메라 → 허용</b>을 골라요.</li><li>아래 <b>다시 시도</b>를 눌러요.</li></ol><p class="tiny">설정 앱 → 앱 → Safari → 카메라에서도 바꿀 수 있어요.</p>'],
  nocamera: ['카메라를 찾지 못했어요', '<p>전면 카메라가 있는 기기에서 열어 주세요.</p>'],
  busy: ['카메라를 다른 곳에서 쓰고 있어요', '<p>영상통화나 카메라 앱을 닫고 다시 시도해 주세요.</p>'],
  camera: ['카메라를 켜지 못했어요', '<p>Safari를 완전히 닫았다가 다시 열어 보세요.</p>'],
  model: ['준비 파일을 받지 못했어요', '<p>인터넷 연결을 확인하고 다시 시도해 주세요. 처음 한 번은 인터넷이 꼭 필요해요.</p>'],
  unknown: ['문제가 생겼어요', '<p>다시 시도해 주세요. 계속되면 Safari를 닫았다가 다시 열어 주세요.</p>'],
};
let lastErrorCode = '';
function showError(e) {
  const code = e && e.code && ERRORS[e.code] ? e.code : 'unknown';
  lastErrorCode = code;
  if (e && (e.cause || e)) console.warn('[brush-bugs]', code, e.cause || e);
  Voice.stop(); hideCaption(); releaseAwake();
  state = 'error';
  showHud(false); setHint('');
  $('#exitBtn').classList.remove('show');
  $('#errTitle').textContent = ERRORS[code][0];
  $('#errBody').innerHTML = ERRORS[code][1];
  $('#errRetry').style.display = code === 'nocamera' ? 'none' : '';
  showScreen('error');
}

// ---------------------------------------------------------------- 설정
function syncSettingsUI() {
  $$('.seg').forEach((seg) => {
    const key = seg.dataset.key;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(settings[key]) === b.dataset.val));
  });
  dbg.classList.toggle('show', !!settings.debug);
}
let settingsReturn = 'home';
function openSettings() {
  if (isLive()) pauseSession();
  settingsReturn = state === 'paused' ? 'paused' : state === 'done' ? 'done' : 'home';
  syncSettingsUI();
  showScreen('settings');
}
function closeSettings() {
  if (settingsReturn === 'paused') showScreen('paused');
  else if (settingsReturn === 'done') showScreen('done');
  else goHome();
}

// ---------------------------------------------------------------- 이벤트 연결
function bind() {
  const tap = (sel, fn) => $(sel).addEventListener('click', (e) => { e.preventDefault(); fn(); });
  tap('#startBtn', startSession);
  tap('#againBtn', startSession);
  tap('#homeBtn', goHome);
  tap('#resumeBtn', resumeSession);
  tap('#pausedHomeBtn', goHome);
  tap('#exitBtn', pauseSession);
  tap('#errHome', goHome);
  tap('#errRetry', () => { if (resumeState) resumeSession(); else startSession(); });
  tap('#closeSettings', closeSettings);
  tap('#resetStickers', () => { Store.set('bb.stickers', {}); renderWeek($('#week')); renderWeek($('#doneWeek')); });
  $$('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[seg.dataset.key] = Number(b.dataset.val);
      Store.set('bb.settings', settings);
      if (seg.dataset.key === 'voice' && !settings.voice) Voice.stop();
      syncSettingsUI();
    });
  });
  const gear = $('#gear');
  let holdTimer = 0;
  const cancelHold = () => { clearTimeout(holdTimer); gear.classList.remove('holding'); };
  gear.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gear.classList.add('holding');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { cancelHold(); openSettings(); }, 1200);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => gear.addEventListener(ev, cancelHold));
  gear.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  // 두 손가락 확대 방지 (iOS)
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (isLive()) pauseSession(); }
    else if (isLive()) keepAwake();
  });
  window.addEventListener('pagehide', () => { stopCamera(); });
  // 뒤로가기 캐시에서 돌아오면 카메라가 꺼져 있으므로 일시정지 화면을 보여 줍니다
  window.addEventListener('pageshow', (e) => { if (e.persisted && isLive()) pauseSession(); });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));
}

// ---------------------------------------------------------------- 메인 루프
let lastFrame = 0, fpsCount = 0, fpsAt = 0, fps = 0, loopErrors = 0;
function frame(now) {
  requestAnimationFrame(frame);
  try {
    // 느린 기기에서도 양치 시간이 실제 시간과 맞도록 0.12초까지는 그대로 반영합니다
    const realDt = lastFrame ? clamp((now - lastFrame) / 1000, 0, 0.5) : 1 / 60;
    const dt = Math.min(0.12, realDt);
    lastFrame = now;
    if (isLive()) {
      detect(now);
      sampleMotion(now);
      update(dt, now, realDt);
    } else if (state === 'home') {
      drawHome(now);
    }
    render(now);
    fpsCount++;
    if (now - fpsAt > 1000) {
      fps = fpsCount; fpsCount = 0; fpsAt = now;
      if (settings.debug) {
        dbg.textContent = [
          'v' + VERSION + ' ' + state + ' ' + (delegate || '-'),
          'fps ' + fps + '  detect ' + detectMs.toFixed(1) + 'ms  every ' + detectInterval + 'ms',
          'video ' + (video.videoWidth || 0) + 'x' + (video.videoHeight || 0) + '  view ' + Math.round(W) + 'x' + Math.round(H),
          'face ' + (faceVisible(now) ? 'Y' : 'N') + ' size ' + faceSize.toFixed(0) + '  open ' + (mouth ? mouth.ratio.toFixed(2) : '-') + (mouthOpen ? ' OPEN' : ''),
          'motion ' + motion.toFixed(1) + (motion > MOTION_T ? ' BRUSH' : '') + '  zone ' + zoneIdx + ' p ' + zoneP.toFixed(2),
        ].join('\n');
      }
    }
    loopErrors = 0;
  } catch (e) {
    loopErrors++;
    if (loopErrors < 5) console.error('[brush-bugs] frame', e);
  }
}

// ---------------------------------------------------------------- 시작
function init() {
  $('#ver').textContent = VERSION;
  Voice.init();
  bind();
  resize();
  syncSettingsUI();
  renderWeek($('#week'));
  if (/KAKAOTALK|Instagram|FBAN|FBAV|NAVER|Line\//i.test(navigator.userAgent)) {
    $('#homeNote').innerHTML = '앱 안의 브라우저에서는 카메라가 안 될 수 있어요.<br>메뉴에서 <b>Safari로 열기</b>를 눌러 주세요.';
  }
  requestAnimationFrame(frame);
  // 첫 화면이 뜬 뒤 미리 모델을 받아 두면 시작이 빨라집니다
  setTimeout(() => { loadModel().catch(() => {}); }, 400);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
init();

// 점검용 (보호자 설정의 '인식 상태 보기'와 테스트에서 사용)
window.__bb = {
  get state() { return state; },
  get mouth() { return mouth; },
  get mouthOpen() { return mouthOpen; },
  get lipBox() { return lipBox; },
  get ratio() { return mouth ? mouth.ratio : 0; },
  get motion() { return motion; },
  get delegate() { return delegate; },
  get worms() { return worms.map((w) => ({ id: w.id, zone: w.zone, state: w.state })); },
  get brushT() { return brushT; },
  get zone() { return zoneIdx; },
  get detectMs() { return detectMs; },
  get fps() { return fps; },
  get lastError() { return lastErrorCode; },
  loadModel: () => loadModel().then(() => delegate),
};
