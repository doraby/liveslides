'use strict';

/* ============================ Config ============================ */

const LS = {
  anthropicKey: 'liveslides.anthropicKey',
  openaiKey: 'liveslides.openaiKey',
  model: 'liveslides.model',
  slideLang: 'liveslides.slideLang',
  sessions: 'liveslides.sessions',
};

const CHUNK_MS = 12_000;               // length of each audio chunk sent to Whisper
const SILENCE_PEAK_THRESHOLD = 3;      // byte-deviation (0-128) below which a chunk is treated as no-signal
const MAX_SESSIONS_KEPT = 20;
const ANTHROPIC_VERSION = '2023-06-01';

const TOOL_SCHEMA = {
  name: 'report_topic_analysis',
  description: 'Summarize the given transcript chunk into slide content.',
  input_schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Short topic label, 2-5 words, in the output language given in the system prompt.' },
      title: { type: 'string', description: 'Slide title, concise, suitable as a presentation headline, in the output language given in the system prompt.' },
      bullets: { type: 'array', items: { type: 'string' }, description: '3 to 5 short bullet points summarizing what was actually said, in the output language given in the system prompt. Never invent facts not present in the transcript.' },
      image_query: { type: 'string', description: 'A short ENGLISH image-search query (2-4 words) that would find photos illustrating this topic, regardless of the transcript or output language.' },
    },
    required: ['topic', 'title', 'bullets'],
  },
};

function buildSystemPrompt() {
  const lang = getSlideLang();
  const langInstruction = (!lang || lang === 'auto')
    ? 'Write the topic, title and bullets in the SAME LANGUAGE as the transcript.'
    : `Always write the topic, title and bullets in ${lang}, translating from the transcript's own language if it differs. The transcript itself may be in any language - translate its meaning faithfully, don't just transliterate.`;

  return `You are turning a chunk of live, real-time spoken-conversation transcript into one slide for a slide deck.
The transcript may be in any language. Produce: a short topic label, a slide title, and 3-5 concise bullet points summarizing the key points actually said. ${langInstruction}
Also produce a short ENGLISH image-search query (2-4 words), since image search only works in English.
Base bullets only on what was actually said in the transcript chunk - never invent facts. Keep titles and bullets short and readable on a presentation slide. Always call the report_topic_analysis tool with your answer.`;
}

/* ============================ State ============================ */

const S = {
  listening: false,
  micStream: null,
  recorderMime: '',
  activeRecorder: null,
  audioCtx: null,
  analyser: null,
  volumeInterval: null,
  chunkPeak: 0,
  fullTranscript: '',
  pending: '',
  slides: [],
  previewIndex: 0,
  currentTopic: null,
  startedAt: null,
  sessionId: null,
  debugLog: [],
};

/* ============================ Utilities ============================ */

function $(id) { return document.getElementById(id); }

function getAnthropicKey() { return localStorage.getItem(LS.anthropicKey) || ''; }
function getOpenaiKey() { return localStorage.getItem(LS.openaiKey) || ''; }
function getModel() { return localStorage.getItem(LS.model) || 'claude-sonnet-5'; }
function getSlideLang() { return localStorage.getItem(LS.slideLang) || 'auto'; }

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3500);
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================ Debug panel ============================ */

function logDebug(msg) {
  S.debugLog.push({ t: Date.now(), msg });
  if (S.debugLog.length > 100) S.debugLog.shift();
  renderDebug();
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch (e) { return ''; }
}

function renderDebug() {
  if (!$('debugBackdrop').classList.contains('open')) return; // skip work while closed

  const transcriptEl = $('debugTranscript');
  const said = S.fullTranscript.slice(0, S.fullTranscript.length - S.pending.length);
  transcriptEl.innerHTML = (said ? escapeHtml(said) : '') +
    (S.pending ? '<span class="pending-span">' + escapeHtml(S.pending) + '</span>' : '') ||
    '<span class="empty-note">Nothing transcribed yet.</span>';
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  const logEl = $('debugLogList');
  logEl.innerHTML = S.debugLog.slice().reverse().map((e) =>
    `<div class="log-row"><span class="log-time">${fmtTime(e.t)}</span>${escapeHtml(e.msg)}</div>`
  ).join('') || '<span class="empty-note">No activity yet.</span>';
}

function openDebug() { $('debugBackdrop').classList.add('open'); renderDebug(); }
function closeDebug() { $('debugBackdrop').classList.remove('open'); }

/* ============================ Settings modal ============================ */

function openSettings() {
  $('inOpenaiKey').value = getOpenaiKey();
  $('inAnthropicKey').value = getAnthropicKey();
  $('inModel').value = getModel();
  $('inSlideLang').value = getSlideLang();
  renderSessionsList();
  renderExportsAvailability();
  $('settingsBackdrop').classList.add('open');
}
function closeSettings() { $('settingsBackdrop').classList.remove('open'); }
function saveSettings() {
  localStorage.setItem(LS.openaiKey, $('inOpenaiKey').value.trim());
  localStorage.setItem(LS.anthropicKey, $('inAnthropicKey').value.trim());
  localStorage.setItem(LS.model, $('inModel').value.trim() || 'claude-sonnet-5');
  localStorage.setItem(LS.slideLang, $('inSlideLang').value);
  closeSettings();
  toast('Settings saved');
}
$('settingsBackdrop').addEventListener('click', (e) => { if (e.target.id === 'settingsBackdrop') closeSettings(); });
$('debugBackdrop').addEventListener('click', (e) => { if (e.target.id === 'debugBackdrop') closeDebug(); });

/* ============================ Mic + Whisper transcription ============================ */

function pickRecorderMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function extForMime(mime) {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

function setupVolumeMonitor(stream) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    S.audioCtx = new AudioCtx();
    const source = S.audioCtx.createMediaStreamSource(stream);
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 512;
    source.connect(S.analyser);
    const data = new Uint8Array(S.analyser.frequencyBinCount);
    S.volumeInterval = setInterval(() => {
      S.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const dev = Math.abs(data[i] - 128);
        if (dev > peak) peak = dev;
      }
      if (peak > S.chunkPeak) S.chunkPeak = peak;
    }, 100);
  } catch (e) {
    console.warn('Volume monitor unavailable:', e);
    logDebug('⚠ Could not start microphone level monitor: ' + e.message);
  }
}

function teardownVolumeMonitor() {
  if (S.volumeInterval) clearInterval(S.volumeInterval);
  S.volumeInterval = null;
  if (S.audioCtx) { try { S.audioCtx.close(); } catch (e) { /* ignore */ } }
  S.audioCtx = null;
  S.analyser = null;
}

function recordChunk(ms) {
  return new Promise((resolve) => {
    if (!S.listening || !S.micStream) return resolve(null);
    const chunks = [];
    let rec;
    try {
      rec = S.recorderMime ? new MediaRecorder(S.micStream, { mimeType: S.recorderMime }) : new MediaRecorder(S.micStream);
    } catch (e) { resolve(null); return; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => resolve(new Blob(chunks, { type: S.recorderMime || 'audio/webm' }));
    rec.onerror = () => resolve(null);
    S.activeRecorder = rec;
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, ms);
  });
}

async function recordingLoop() {
  while (S.listening) {
    S.chunkPeak = 0;
    const blob = await recordChunk(CHUNK_MS);
    const peak = S.chunkPeak;
    if (!blob || !S.listening) continue;
    if (blob.size < 1000) { logDebug(`Recorded chunk too small (${blob.size}B) — skipped.`); continue; }
    if (peak < SILENCE_PEAK_THRESHOLD) {
      logDebug(`⚠ No audio signal detected in this chunk (level ${peak}/128) — skipped, not sent to Whisper. Check your microphone input/permissions/device.`);
      continue;
    }
    try {
      logDebug(`Sending ${(blob.size / 1024).toFixed(1)}KB audio chunk to Whisper (mic level ${peak}/128)…`);
      const text = await transcribeChunk(blob);
      const clean = (text || '').trim();
      if (clean) {
        S.fullTranscript += clean + ' ';
        S.pending += clean + ' ';
        logDebug(`Transcribed: "${clean}"`);
        renderDebug();
        renderLiveTranscript();
      } else {
        logDebug('Transcribed: (empty result)');
      }
    } catch (err) {
      console.warn('Transcription failed:', err);
      logDebug('⚠ Transcription failed: ' + err.message);
      if (err.fatal) { toast('Transcription failed: ' + err.message, true); stopListening(); return; }
    }
  }
}

async function transcribeChunk(blob) {
  const ext = extForMime(S.recorderMime);
  const form = new FormData();
  form.append('file', blob, 'chunk.' + ext);
  form.append('model', 'whisper-1');
  const tail = S.fullTranscript.slice(-200);
  if (tail) form.append('prompt', tail);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + getOpenaiKey() },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(body);
    const err = new Error(`OpenAI API ${res.status}${res.status === 401 ? ' (check your API key)' : ''}`);
    err.fatal = res.status === 401 || res.status === 403;
    throw err;
  }
  const data = await res.json();
  return data.text || '';
}

/* ============================ Start / stop ============================ */

function toggleListening() {
  if (S.listening) stopListening();
  else startListening();
}

async function startListening() {
  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('This browser does not support microphone recording.', true);
    return;
  }
  if (!getOpenaiKey() || !getAnthropicKey()) {
    toast('Add your OpenAI and Anthropic API keys in Settings first.', true);
    openSettings();
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast('Microphone access denied.', true);
    return;
  }

  S.listening = true;
  S.micStream = stream;
  S.recorderMime = pickRecorderMime();
  S.fullTranscript = '';
  S.pending = '';
  S.slides = [];
  S.previewIndex = 0;
  S.currentTopic = null;
  S.startedAt = Date.now();
  S.sessionId = uid();
  S.debugLog = [];
  renderPreview();
  logDebug(`Listening started. Mic format: ${S.recorderMime || 'default'}. Tap + any time to generate a slide from what's been said so far.`);

  setupVolumeMonitor(stream);
  recordingLoop();

  $('listenBtnLabel').textContent = 'Stop listening';
  $('listenBtn').classList.add('active');
  $('listenIcon').outerHTML = '<span class="pulse" id="listenIcon"></span>';
  $('manualSlideBtn').hidden = false;
  $('liveTranscript').hidden = false;
  $('statusCaption').textContent = 'Listening — tap + to generate a slide';
  renderLiveTranscript();
}

function stopListening() {
  logDebug('Listening stopped.');
  S.listening = false;
  teardownVolumeMonitor();
  if (S.activeRecorder && S.activeRecorder.state !== 'inactive') { try { S.activeRecorder.stop(); } catch (e) { /* ignore */ } }
  if (S.micStream) { S.micStream.getTracks().forEach((t) => t.stop()); S.micStream = null; }

  $('listenBtnLabel').textContent = 'Start listening';
  $('listenBtn').classList.remove('active');
  const pulseEl = $('listenIcon');
  if (pulseEl) pulseEl.outerHTML = '<svg id="listenIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
  $('manualSlideBtn').hidden = true;
  $('liveTranscript').hidden = true;
  $('statusCaption').textContent = '';

  if (S.slides.length) {
    saveSessionToHistory();
    toast('Session saved. Export it from Settings.');
  }
}

function renderLiveTranscript() {
  const el = $('liveTranscript');
  if (!el || el.hidden) return;
  const said = S.fullTranscript.slice(0, S.fullTranscript.length - S.pending.length);
  el.innerHTML = (said ? escapeHtml(said) : '') +
    (S.pending ? '<span class="pending-span">' + escapeHtml(S.pending) + '</span>' : '') ||
    '<span class="empty-note">Listening…</span>';
  el.scrollTop = el.scrollHeight;
}

/* ============================ Slide generation (manual, on demand) ============================ */

async function manualSlide() {
  if (!S.listening) return;
  const chunk = S.pending.trim();
  if (!chunk) { toast("Nothing new said since the last slide yet.", true); return; }
  S.pending = '';
  renderLiveTranscript();

  const btn = $('manualSlideBtn');
  btn.disabled = true;
  toast('Generating slide…');
  logDebug(`Slide requested — sending to Claude: "${chunk}"`);

  try {
    const result = await analyzeTopic(chunk, S.currentTopic);
    if (result) {
      logDebug(`→ New slide: "${result.title}"`);
      await addSlide(result, chunk);
      S.currentTopic = result.topic;
    }
  } catch (err) {
    console.error('LiveSlides manual slide failed:', err);
    logDebug('⚠ Manual slide failed: ' + err.message);
    toast('Could not generate slide: ' + err.message, true);
    S.pending = chunk + ' ' + S.pending; // don't lose this transcript chunk on failure
    renderLiveTranscript();
    if (err.fatal) { stopListening(); return; }
  } finally {
    btn.disabled = false;
  }
}

async function analyzeTopic(chunk, currentTopic) {
  const userMsg = `Current topic so far: "${currentTopic || 'none yet'}"\n\nTranscript since the last slide:\n"""${chunk}"""\n\nSummarize this transcript chunk into slide content (topic/title/bullets).`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': getAnthropicKey(),
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 600,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: userMsg }],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'report_topic_analysis' },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Anthropic API ${res.status}${res.status === 401 ? ' (check your API key)' : ''}`);
    err.fatal = res.status === 401 || res.status === 403;
    console.error(body);
    throw err;
  }

  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'report_topic_analysis');
  if (!block) throw new Error('Unexpected API response (no tool result)');
  return block.input;
}

/* ============================ Slides ============================ */

async function addSlide(result, sourceChunk) {
  const slide = {
    id: uid(),
    topic: result.topic || 'Untitled topic',
    title: result.title || result.topic || 'Untitled',
    bullets: Array.isArray(result.bullets) ? result.bullets : [],
    imageQuery: result.image_query || result.topic || '',
    images: [],
    imagesLoading: true,
    sourceChunk,
    createdAt: Date.now(),
  };
  S.slides.push(slide);
  S.previewIndex = S.slides.length - 1;
  renderPreview();

  try {
    slide.images = await fetchCommonsImages(slide.imageQuery, 5);
  } catch (e) {
    console.warn('Image search failed:', e);
    slide.images = [];
  }
  slide.imagesLoading = false;
  renderPreview();
}

async function fetchCommonsImages(query, count) {
  if (!query) return [];
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: 'filetype:bitmap ' + query,
    gsrnamespace: '6',
    gsrlimit: String(count * 3),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '480',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
  const out = [];
  for (const p of pages) {
    const info = p.imageinfo && p.imageinfo[0];
    if (!info) continue;
    const thumb = info.thumburl || info.url;
    if (!thumb || !/\.(jpe?g|png|gif)(\?|$)/i.test(thumb)) continue;
    out.push({ url: thumb, title: p.title || '', pageUrl: info.descriptionurl || '' });
    if (out.length >= count) break;
  }
  return out;
}

function renderPreview() {
  const area = $('previewArea');
  const dots = $('previewDots');

  if (!S.slides.length) {
    area.innerHTML = `
      <div class="empty-slide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M3 15l5-4 4 3 5-5 4 4"/></svg>
        <div>No slides yet — start listening to generate your first one.</div>
      </div>`;
    dots.innerHTML = '';
    return;
  }

  const idx = Math.min(Math.max(S.previewIndex, 0), S.slides.length - 1);
  const slide = S.slides[idx];
  const bulletsHtml = slide.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  let imagesHtml = '';
  if (slide.imagesLoading) {
    imagesHtml = '<div class="slide-images">' + Array(5).fill('<div class="ph">…</div>').join('') + '</div>';
  } else if (slide.images.length) {
    imagesHtml = '<div class="slide-images">' + slide.images.map((img) =>
      `<img src="${img.url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'—'}))">`
    ).join('') + '</div>';
  }

  area.innerHTML = `
    <div class="slide">
      <div class="slide-head">
        <div class="slide-topic">${escapeHtml(slide.topic)}</div>
        <div class="slide-title">${escapeHtml(slide.title)}</div>
        <ul class="slide-bullets">${bulletsHtml}</ul>
      </div>
      ${imagesHtml}
    </div>`;

  dots.innerHTML = S.slides.map((s, i) =>
    `<button class="${i === idx ? 'active' : ''}" data-index="${i}" aria-label="Slide ${i + 1}"></button>`
  ).join('');
}

function goToSlide(i) {
  S.previewIndex = i;
  renderPreview();
}

/* ============================ Session history (localStorage) ============================ */

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(LS.sessions) || '[]'); } catch (e) { return []; }
}

function saveSessionToHistory() {
  const sessions = loadSessions();
  sessions.unshift({
    id: S.sessionId,
    startedAt: S.startedAt,
    endedAt: Date.now(),
    slides: S.slides,
    fullTranscript: S.fullTranscript,
  });
  while (sessions.length > MAX_SESSIONS_KEPT) sessions.pop();
  localStorage.setItem(LS.sessions, JSON.stringify(sessions));
}

function renderSessionsList() {
  const sessions = loadSessions();
  const list = $('sessionsList');
  if (!sessions.length) { list.innerHTML = '<div class="empty-note">No past sessions yet.</div>'; return; }
  list.innerHTML = '';
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `
      <div>
        <div>${fmtDate(s.startedAt)}</div>
        <div class="meta">${s.slides.length} slide${s.slides.length === 1 ? '' : 's'}</div>
      </div>
      <div><button class="btn" data-act="view">View</button></div>
    `;
    row.querySelector('[data-act="view"]').addEventListener('click', () => viewPastSession(s));
    list.appendChild(row);
  }
}

function viewPastSession(session) {
  if (S.listening) stopListening();
  S.slides = session.slides;
  S.previewIndex = S.slides.length - 1;
  S.sessionId = session.id;
  S.startedAt = session.startedAt;
  S.fullTranscript = session.fullTranscript || '';
  renderPreview();
  closeSettings();
  toast('Loaded past session — export it from Settings.');
}

function renderExportsAvailability() {
  const row = $('exportsRow');
  row.style.opacity = S.slides.length ? '1' : '.4';
}

/* ============================ Exports ============================ */

function currentSessionObject() {
  return {
    id: S.sessionId,
    startedAt: S.startedAt,
    endedAt: Date.now(),
    slides: S.slides,
    fullTranscript: S.fullTranscript,
  };
}

function exportJSON() {
  if (!S.slides.length) { toast('No slides to export yet.', true); return; }
  const blob = new Blob([JSON.stringify(currentSessionObject(), null, 2)], { type: 'application/json' });
  downloadBlob(blob, `liveslides-${dateStamp()}.json`);
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

async function imageToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed');
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function exportPDF() {
  if (!S.slides.length) { toast('No slides to export yet.', true); return; }
  if (!window.jspdf) { toast('PDF library did not load — check your connection.', true); return; }
  toast('Building PDF…');
  const { jsPDF } = window.jspdf;
  const W = 960, H = 540;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [W, H] });

  for (let i = 0; i < S.slides.length; i++) {
    const slide = S.slides[i];
    if (i > 0) doc.addPage([W, H], 'landscape');

    doc.setFillColor(245, 242, 234);
    doc.rect(0, 0, W, H, 'F');

    doc.setTextColor(196, 98, 45);
    doc.setFontSize(11);
    doc.text((slide.topic || '').toUpperCase(), 40, 40);

    doc.setTextColor(28, 26, 21);
    doc.setFontSize(26);
    doc.text(slide.title || '', 40, 70, { maxWidth: W - 80 });

    doc.setFontSize(13);
    let y = 110;
    for (const b of slide.bullets || []) {
      const lines = doc.splitTextToSize('• ' + b, W - 80);
      doc.text(lines, 40, y);
      y += lines.length * 18 + 4;
    }

    const imgs = (slide.images || []).slice(0, 5);
    if (imgs.length) {
      const boxW = 160, boxH = 120, gap = 10;
      const totalW = imgs.length * boxW + (imgs.length - 1) * gap;
      let x = (W - totalW) / 2;
      const imgY = H - boxH - 30;
      for (const img of imgs) {
        try {
          const dataUrl = await imageToDataURL(img.url);
          doc.addImage(dataUrl, x, imgY, boxW, boxH, undefined, 'FAST');
        } catch (e) { /* skip failed image */ }
        x += boxW + gap;
      }
    }
  }

  doc.save(`liveslides-${dateStamp()}.pdf`);
}

async function exportPPTX() {
  if (!S.slides.length) { toast('No slides to export yet.', true); return; }
  if (!window.PptxGenJS) { toast('PPTX library did not load — check your connection.', true); return; }
  toast('Building PPTX…');
  const pptx = new window.PptxGenJS();
  pptx.defineLayout({ name: 'LS', width: 10, height: 5.63 });
  pptx.layout = 'LS';

  for (const slide of S.slides) {
    const s = pptx.addSlide();
    s.background = { color: 'F5F2EA' };
    s.addText((slide.topic || '').toUpperCase(), { x: 0.4, y: 0.25, w: 9.2, h: 0.3, fontSize: 12, color: 'C4622D', bold: true });
    s.addText(slide.title || '', { x: 0.4, y: 0.55, w: 9.2, h: 0.8, fontSize: 26, color: '1C1A15', bold: true, fontFace: 'Georgia' });
    s.addText((slide.bullets || []).map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), {
      x: 0.4, y: 1.4, w: 9.2, h: 2.1, fontSize: 14, color: '1C1A15',
    });

    const imgs = (slide.images || []).slice(0, 5);
    if (imgs.length) {
      const boxW = 1.7, boxH = 1.28, gap = 0.15;
      const totalW = imgs.length * boxW + (imgs.length - 1) * gap;
      let x = (10 - totalW) / 2;
      const y = 5.63 - boxH - 0.3;
      for (const img of imgs) {
        try {
          const dataUrl = await imageToDataURL(img.url);
          s.addImage({ data: dataUrl, x, y, w: boxW, h: boxH });
        } catch (e) { /* skip failed image */ }
        x += boxW + gap;
      }
    }
  }

  pptx.writeFile({ fileName: `liveslides-${dateStamp()}.pptx` });
}

/* ============================ Init ============================ */

window.addEventListener('beforeunload', (e) => {
  if (S.listening) { e.preventDefault(); e.returnValue = ''; }
});

function wireUpButtons() {
  $('settingsBtn').addEventListener('click', openSettings);
  $('debugBtn').addEventListener('click', openDebug);
  $('debugCloseBtn').addEventListener('click', closeDebug);
  $('listenBtn').addEventListener('click', toggleListening);
  $('manualSlideBtn').addEventListener('click', manualSlide);
  $('settingsCloseBtn').addEventListener('click', closeSettings);
  $('settingsSaveBtn').addEventListener('click', saveSettings);
  $('exportJsonBtn').addEventListener('click', exportJSON);
  $('exportPdfBtn').addEventListener('click', exportPDF);
  $('exportPptxBtn').addEventListener('click', exportPPTX);
  $('previewDots').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) goToSlide(Number(btn.dataset.index));
  });
}

try {
  wireUpButtons();
  renderPreview();
} catch (e) {
  console.error('LiveSlides failed to initialize:', e);
  document.body.insertAdjacentHTML('afterbegin',
    '<div style="position:fixed;inset:0;z-index:999;background:#b3432b;color:#fff;padding:16px;font:14px/1.5 sans-serif;">LiveSlides failed to start: ' +
    String(e.message || e).replace(/</g, '&lt;') + '</div>');
}
