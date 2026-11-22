// app.js — Breathmarks renderer controller.
//
// Flow (reader):  home -> consent -> baseline (30 s calm) -> read -> review
//                 (private; keep/remove marks) -> share (export) .
// Flow (writer):  home -> open a shared report -> writer's view.
//
// Signals come from LiveSource (SmartSpectra SDK, real camera) or
// SimulatedSource (scripted, labelled SIMULATED everywhere).

'use strict';

const { decodeMetrics, Metrics } = require('@smartspectra/node-sdk/messages');
const { SignalStore } = require('../core/signals');
const R = require('../core/reading');
const { SimulatedSource, defaultPlan } = require('../sim/simulator');
const { samples } = require('../samples');
const { drawSpark, drawStrip } = require('./draw');

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const bridge = window.breathmarks || null;      // null in a plain browser
const params = new URLSearchParams(location.search);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Vertical Japanese: set 1–2 digit numbers upright (縦中横). Presentation only; the text is unchanged.
const tcy = (html) => html.replace(/(^|[^0-9A-Za-z])([0-9]{1,2})(?![0-9A-Za-z])/g, '$1<span class="tcy">$2</span>');
const bodyHtml = (text, vertical) => (vertical ? tcy(esc(text)) : esc(text));

// ---------------------------------------------------------------------------
// Settings (non-sensitive, per computer). The API key is never stored here.
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'bm.settings.v1';
const DEFAULT_SETTINGS = { pulse: true, blinking: true, talking: true, telemetry: false, bundles: false, preview: 'blur', cameraId: '' };
function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch { /* storage unavailable */ }
}

const BASELINE_S = 30;

const S = {
    config: null,
    settings: loadSettings(),
    screen: 'home',
    source: null,
    sourceKind: null,
    store: new SignalStore(),
    stream: null,
    manuscript: null,
    layout: 'horizontal',
    simPlan: null,
    session: null,
    para: -1,
    visit: null,
    validation: { code: null },
    okSeconds: 0,
    lastLoopT: null,
    analysis: null,
    removed: new Set(),
    report: null,
    reportFromPreview: false,
    revise: new Set(),
    readStartedAt: 0,
    noteLang: 'en',            // margin note language; English by default
};

const ValidationText = {
    0: ['ok', 'Signal looks good'],
    1: ['err', 'No face found. Face the camera.'],
    2: ['err', 'More than one face. Only the reader should be in view.'],
    3: ['warn', 'Center your face in the frame.'],
    4: ['warn', 'Adjust your distance to the camera.'],
    5: ['warn', 'Too dark. Add light in front of you.'],
    6: ['warn', 'Too bright. Move away from light behind you.'],
    7: ['warn', 'Upper chest not visible. Move back a little.'],
    10: ['warn', 'Camera is adjusting…'],
    11: ['warn', 'Frame rate is low. More light usually helps.'],
    12: ['warn', 'Hold still for a moment.'],
    13: ['warn', 'Move a little further from the camera.'],
    14: ['warn', 'Move a little closer to the camera.'],
    15: ['warn', 'Move down, or tilt the camera up.'],
    16: ['warn', 'Move up, or tilt the camera down.'],
    17: ['warn', 'Face the camera.'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowT() {
    if (!S.source || S.store.originUs == null) return 0;
    return (S.source.nowUs() - S.store.originUs) / 1e6;
}

function newId() {
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    return 'bm_' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const CRUMBS = {
    home: '',
    consent: 'Before you read',
    baseline: 'Your calm reference',
    read: '',
    review: 'Your marks (private)',
    writer: 'Writer’s view',
};

function setScreen(name) {
    S.screen = name;
    document.body.dataset.screen = name;
    $('#crumb').textContent = name === 'read' && S.manuscript ? S.manuscript.title : CRUMBS[name] ?? '';
    placePreview();
    updateSourceBadges();
    window.scrollTo(0, 0);
}

function showError(title, text) {
    $('#error-title').textContent = title;
    $('#error-text').textContent = text;
    $('#error-banner').hidden = false;
}
function hideError() { $('#error-banner').hidden = true; }

function isSimView() {
    if (S.sourceKind === 'simulated') return true;
    if (S.screen === 'review' && S.session?.source === 'simulated') return true;
    if (S.screen === 'writer' && S.report?.source === 'simulated') return true;
    return false;
}

function updateSourceBadges() {
    const sim = isSimView();
    $('#sim-tag').hidden = !sim;
    const pill = $('#source-pill');
    if (S.sourceKind === 'live' && S.source) { pill.hidden = false; pill.className = 'pill live'; pill.textContent = 'Camera on'; }
    else if (sim) { pill.hidden = false; pill.className = 'pill sim'; pill.textContent = 'Simulated'; }
    else pill.hidden = true;
    const stop = $('#btn-stop-camera');
    stop.hidden = !S.source;
    stop.textContent = S.sourceKind === 'live' ? 'Stop camera' : 'Exit simulation';
}

// ---------------------------------------------------------------------------
// Preview video (one element, moved between screens)
// ---------------------------------------------------------------------------
const video = document.createElement('video');
video.autoplay = true; video.muted = true; video.playsInline = true;
const placeholder = document.createElement('div');
placeholder.className = 'preview-placeholder';
const hiddenNote = document.createElement('div');
hiddenNote.className = 'preview-placeholder hidden-note';
hiddenNote.textContent = 'Preview hidden. The camera is still in use.';
const valOverlay = document.createElement('div');
valOverlay.className = 'validation validation-overlay';

function placePreview() {
    const slot = $(`.preview-slot[data-slot="${S.screen}"]`);
    if (!slot) return;
    slot.replaceChildren();
    const hasVideo = !!video.srcObject;
    slot.classList.toggle('has-video', hasVideo);
    if (hasVideo) slot.append(video, hiddenNote);
    else {
        placeholder.textContent = S.sourceKind === 'simulated' ? 'SIMULATED signals. The camera is not in use.' : 'Camera preview appears here.';
        slot.append(placeholder);
    }
    if (S.screen === 'baseline') slot.append(valOverlay);
}

function setPreviewMode(mode) {
    S.settings.preview = mode;
    saveSettings();
    document.body.dataset.preview = mode;
    $$('button[data-preview]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preview === mode)));
}

function attachStream(stream) {
    S.stream = stream;
    video.srcObject = stream;
    video.play().catch(() => {});
    placePreview();
}

// ---------------------------------------------------------------------------
// Manuscript
// ---------------------------------------------------------------------------
function loadManuscript(text, { title = '', fileName = '', sample = null } = {}) {
    const ms = R.parseManuscript(text, { title, fileName });
    if (!ms.paragraphs.length) { showError('Nothing to read', 'The text has no paragraphs. Separate paragraphs with a blank line.'); return; }
    hideError();
    S.manuscript = ms;
    S.noteLang = 'en';
    S.layout = sample?.vertical || ms.lang === 'ja' ? 'vertical' : 'horizontal';
    S.simPlan = sample?.simPlan || defaultPlan(ms.paragraphs.length);
    renderConsent();
    goConsent();
}

function renderConsent() {
    const ms = S.manuscript;
    $('#consent-title').textContent = ms.title;
    const mins = Math.max(1, Math.round(ms.estMin));
    $('#draft-meta').textContent = `You are about to read · ${ms.paragraphs.length} paragraphs · about ${mins} min · ${ms.lang === 'ja' ? 'Japanese' : 'English'}`;
    $('#layout-row').hidden = ms.lang !== 'ja';
    $$('button[data-layout]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layout === S.layout)));
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsText(file, 'utf-8');
    });
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
function encodeSim(obj) { return Metrics.encode(Metrics.fromObject(obj)).finish(); }

function setValidation(code) {
    if (code === S.validation.code) return;
    S.validation.code = code;
    if (S.session) S.session.validation.push({ t: nowT(), code });
    const [cls, text] = ValidationText[code] ?? ['warn', `Status ${code}`];
    valOverlay.className = `validation validation-overlay ${cls}`;
    valOverlay.textContent = text;
    $('#rs-dot').className = `dot ${cls === 'ok' ? '' : cls}`;
    $('#rs-text').textContent = text;
}

function wireSource(src) {
    src.on('metrics', (buf) => {
        let m;
        try { m = decodeMetrics(buf); } catch (e) { console.error('decode failed', e); return; }
        S.store.ingest(m);
    });
    src.on('validationStatus', (code) => setValidation(code));
    src.on('error', (code, message) => {
        const { explainError } = require('../live/liveSource');
        const { name, text } = explainError(code, message);
        showError(`SmartSpectra: ${name}`, text);
    });
    src.on('streamAvailable', (stream) => attachStream(stream));
    src.on('processingStatus', async (status) => {
        if (status === 5 && src === S.source && S.sourceKind === 'live') {
            await stopSource();
            S.sourceKind = null;
            updateSourceBadges();
            goConsent();
        }
    });
}

async function startSource(kind) {
    hideError();
    await stopSource();
    const metrics = { pulse: S.settings.pulse, blinking: S.settings.blinking, talking: S.settings.talking, bundles: S.settings.bundles };
    if (kind === 'simulated') {
        const speed = Number(params.get('speed')) || S.config?.simSpeed || 1;
        S.source = new SimulatedSource({ encode: encodeSim, speed, metrics });
        S.source.setPlan(S.simPlan || defaultPlan(S.manuscript.paragraphs.length));
    } else {
        const ok = await bridge.setCameraConsent(true);
        const apiKey = ok ? await bridge.getApiKey() : null;
        if (!apiKey) { showError('No API key', 'Add your Presage API key in Settings, or try with simulated signals.'); return false; }
        const { LiveSource } = require('../live/liveSource');
        try {
            S.source = new LiveSource({ apiKey, metrics, telemetry: S.settings.telemetry, deviceId: S.settings.cameraId || null });
        } catch (e) { showError('Could not create the SDK', e.message); return false; }
    }
    S.sourceKind = kind;
    wireSource(S.source);
    S.store.reset();
    S.validation.code = null;
    S.okSeconds = 0;
    S.lastLoopT = null;
    S.session = {
        id: newId(),
        createdAt: new Date().toISOString(),
        source: kind,
        sdkVersion: S.config?.sdkVersion ?? null,
        requested: metrics,
        manuscript: { ...S.manuscript, vertical: S.layout === 'vertical' },
        phases: { baselineStart: null, baselineEnd: null, readStart: null, readEnd: null },
        visits: [],
        validation: [],
    };
    renderBaseline();
    setScreen('baseline');
    try {
        const hostStream = await S.source.start();
        if (hostStream) attachStream(hostStream);
        if (S.store.originUs == null) S.store.setOrigin(S.source.nowUs());
        S.source.setPhase('baseline');
    } catch (e) {
        const { explainError } = kind === 'live' ? require('../live/liveSource') : { explainError: () => ({ name: 'Error', text: e.message }) };
        const info = e.code != null ? explainError(e.code, e.message) : { name: 'Start failed', text: e.message };
        showError(`Could not start: ${info.name}`, info.text);
        await stopSource();
        S.sourceKind = null;
        goConsent();
        return false;
    }
    return true;
}

async function stopSource() {
    const src = S.source;
    S.source = null;
    if (src) {
        try { await src.stop(); } catch (e) { console.warn('stop failed', e); }
        try { src.destroy(); } catch { /* ignore */ }
    }
    if (S.stream) { for (const tr of S.stream.getTracks?.() ?? []) tr.stop(); }
    S.stream = null;
    video.srcObject = null;
    if (bridge && S.sourceKind === 'live') await bridge.setCameraConsent(false);
    updateSourceBadges();
    placePreview();
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------
function renderBaseline() {
    $('#base-count').textContent = String(BASELINE_S);
    $('#base-bar').style.setProperty('--p', '0%');
    $('#btn-start-read').disabled = true;
    for (const id of ['#ro-pulse', '#ro-breath', '#ro-blink']) $(id).textContent = 'waiting…';
}

function updateBaseline(t, dt) {
    // Count calm time while the SDK reports a good signal. If no validation
    // status has arrived yet but samples are flowing, count that too.
    const flowing = S.store.breathTrace.length > 0 && t - S.store.lastSampleT < 3;
    if (S.validation.code === 0 || (S.validation.code == null && flowing)) {
        if (S.session.phases.baselineStart == null) S.session.phases.baselineStart = t;
        S.okSeconds += dt;
    }
    const left = Math.max(0, Math.ceil(BASELINE_S - S.okSeconds));
    $('#base-count').textContent = String(left);
    $('#base-bar').style.setProperty('--p', `${Math.min(100, (S.okSeconds / BASELINE_S) * 100)}%`);
    const ready = S.okSeconds >= BASELINE_S;
    $('#btn-start-read').disabled = !ready;
    $('#base-hint').textContent = ready ? 'Ready when you are.' : 'Available after 30 seconds of good signal.';

    const p = S.store.latest('pulse', { stableOnly: true });
    $('#ro-pulse').textContent = p ? `${Math.round(p.v)} bpm` : 'warming up';
    const b = S.store.latest('breathing', { stableOnly: true });
    $('#ro-breath').textContent = b ? `${Math.round(b.v)} /min` : 'warming up';
    if (!S.settings.blinking) $('#ro-blink').textContent = 'off';
    else if (S.store.blinking.length && S.session.phases.baselineStart != null) {
        const a = S.session.phases.baselineStart;
        const n = R.blinkOnsets(S.store.blinking).filter((x) => x >= a).length;
        $('#ro-blink').textContent = t - a > 8 ? `${Math.round((n / (t - a)) * 60)} /min` : 'counting';
    }
    drawSpark($('#base-trace'), S.store.breathTrace, t, 20);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
function renderReader() {
    const el = $('#reader');
    const ms = S.manuscript;
    el.classList.toggle('vertical', S.layout === 'vertical');
    el.lang = ms.lang;
    const v = S.layout === 'vertical';
    el.innerHTML = `<h1 class="rtitle">${bodyHtml(ms.title, v)}</h1>` + ms.paragraphs.map((p) => `<p data-i="${p.i}">${bodyHtml(p.text, v)}</p>`).join('');
}

function beginReading() {
    const t = nowT();
    const ph = S.session.phases;
    if (ph.baselineStart == null) ph.baselineStart = 0;
    ph.baselineEnd = t;
    ph.readStart = t;
    S.source.setPhase('read');
    S.para = -1;
    S.visit = null;
    renderReader();
    setScreen('read');
    S.readStartedAt = performance.now();
    $('#key-hint').textContent = S.layout === 'vertical' ? '← or Space: next paragraph · →: back · Esc: finish' : '→ or Space: next paragraph · ←: back · Esc: finish';
    $('#key-hint').classList.remove('gone');
    focusPara(0);
    $('#reader').focus();
}

function closeVisit(t) {
    if (S.visit) {
        S.visit.end = t;
        if (S.visit.end > S.visit.start) S.session.visits.push(S.visit);
        S.visit = null;
    }
}

function focusPara(i) {
    const n = S.manuscript.paragraphs.length;
    if (i < 0 || i >= n || i === S.para) return;
    const t = nowT();
    closeVisit(t);
    S.visit = { i, start: t, end: null };
    S.para = i;
    S.source?.setParagraph(i);
    $$('#reader p').forEach((p) => {
        const j = Number(p.dataset.i);
        p.classList.toggle('focus', j === i);
        if (j === i) p.classList.add('read');
    });
    const el = $(`#reader p[data-i="${i}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    $('#rs-pos').textContent = `¶ ${i + 1} / ${n}`;
}

function step(dir) {
    const n = S.manuscript.paragraphs.length;
    if (dir > 0 && S.para >= n - 1) { finishReading(); return; }
    focusPara(Math.max(0, Math.min(n - 1, S.para + dir)));
}

async function finishReading() {
    if (S.screen !== 'read' || !S.session) return;
    const t = nowT();
    closeVisit(t);
    S.session.phases.readEnd = t;
    S.store.finalize();
    S.session.signals = S.store.toJSON();
    await stopSource();
    S.sourceKind = null;
    try {
        S.analysis = R.analyzeReading(S.session);
    } catch (e) {
        console.error(e);
        showError('Could not analyse the reading', e.message);
        goHome();
        return;
    }
    S.removed = new Set();
    renderReview();
    setScreen('review');
    requestAnimationFrame(() => drawStrip($('#strip'), S.session, S.analysis));
}

// ---------------------------------------------------------------------------
// Margin rendering (shared by the reader's review and the writer's view)
// ---------------------------------------------------------------------------
function renderSummary(ul, rep) {
    const lines = R.summaryLines(rep, S.noteLang);
    ul.lang = S.noteLang;
    ul.innerHTML = lines.map((line) => {
        const m = line.match(/^(.+?)(: |：)(.*)$/);
        return m ? `<li><span class="hand">✎</span><b>${esc(m[1])}</b>${m[2]}${esc(m[3])}</li>` : `<li>${esc(line)}</li>`;
    }).join('');
}

/** Small deterministic tilt/offset per note, so the margin looks hand-written. */
function inkStyle(i, k) {
    const h = Math.sin((i + 1) * 12.9898 + (k + 1) * 78.233) * 43758.5453;
    const f = h - Math.floor(h);
    const g = (h * 7.13) - Math.floor(h * 7.13);
    return `--r:${((f - 0.5) * 1.6).toFixed(2)}deg;--dx:${((g - 0.5) * 6).toFixed(1)}px`;
}

function syncNotesToggle(lang) {
    const show = lang === 'ja';
    $$('[data-notes-row]').forEach((row) => { row.hidden = !show; });
    $$('button[data-notes]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.notes === S.noteLang)));
}

function renderManuscript(box, rep, mode) {
    const W = R.WORDS[S.noteLang];
    const vertical = !!rep.vertical && rep.lang === 'ja';
    box.classList.toggle('vertical', vertical);
    box.classList.toggle('notes-ja', S.noteLang === 'ja');
    box.lang = rep.lang;
    box.innerHTML = rep.paragraphs.map((p) => {
        const strong = p.marks.some((m) => m.strong);
        const cls = p.withheld ? 'withheld' : strong ? 'strong' : p.marks.length ? 'marked' : 'steady';
        const nl = ` lang="${S.noteLang}"`;
        let notes;
        if (p.withheld) notes = `<span class="note-hand quiet"${nl} style="${inkStyle(p.i, 0)}">${W.withheld}</span>`;
        else if (p.marks.length) notes = p.marks.map((m, k) => `<span class="note-hand${m.strong ? ' strong' : ''}${m.kind === 'nodata' || m.kind === 'unread' ? ' quiet' : ''}"${nl} style="${inkStyle(p.i, k)}">${esc(R.noteText(m, S.noteLang))}</span>`).join('');
        else notes = `<span class="note-hand quiet"${nl} style="${inkStyle(p.i, 0)}">${W.steady}</span>`;
        let ctl = '';
        if (mode === 'reader') {
            const hasNotes = S.analysis.paragraphs[p.i].marks.length > 0;
            if (hasNotes || p.withheld) ctl = `<button class="link ctl" data-toggle="${p.i}">${p.withheld ? 'share this note' : 'keep private'}</button>`;
        } else {
            ctl = `<button class="link revise-btn" data-revise="${p.i}">${S.revise.has(p.i) ? '✓ revise' : 'revise'}</button>`;
        }
        const rv = mode === 'writer' && S.revise.has(p.i) ? ' revise' : '';
        return `<section class="mp ${cls}${rv}" data-i="${p.i}"><aside><span class="pn">¶${p.i + 1}</span>${notes}${ctl}</aside><p>${bodyHtml(p.text, vertical)}</p></section>`;
    }).join('');
}

function readerReport() {
    return R.buildReport(S.session, S.analysis, S.removed, { readerName: $('#share-name').value.trim(), noteLang: S.noteLang });
}

function renderReview() {
    const rep = readerReport();
    const ms = S.manuscript;
    const a = S.analysis;
    $('#review-title').textContent = `Your breath marks: ${ms.title}`;
    const mins = Math.max(1, Math.round(a.totalS / 60));
    const marked = rep.paragraphs.filter((p) => p.marks.some((m) => !['nodata', 'unread'].includes(m.kind))).length;
    $('#review-sub').textContent = `${ms.paragraphs.length} paragraphs · read in about ${mins} min · ${marked} with a mark${S.session.source === 'simulated' ? ' · SIMULATED signals' : ''}`;
    syncNotesToggle(ms.lang);
    renderSummary($('#review-summary'), rep);
    const b = a.baseline;
    const parts = [];
    if (b.pulse != null) parts.push(`pulse ${Math.round(b.pulse)} bpm`);
    if (b.traceRate) parts.push(`breathing ${Math.round(b.traceRate)}/min`);
    if (b.blinkRate != null) parts.push(`blinks ${Math.round(b.blinkRate)}/min`);
    $('#review-base').textContent = `Your calm reference (the ${Math.round(b.seconds)} s before reading): ${parts.join(' · ') || 'not enough signal'}. Every mark compares a paragraph with this reference only. Camera estimates, not medical data; they do not read emotions.`;
    renderManuscript($('#review-ms'), rep, 'reader');
}

function renderWriter() {
    const rep = S.report;
    $('#writer-title').textContent = rep.title;
    $('#writer-meta').textContent = `Breath marks from ${rep.reader ? rep.reader : 'your reader'} · ${rep.createdAt}${rep.source === 'simulated' ? ' · SIMULATED (not a real reader)' : ''}${S.reportFromPreview ? ' · preview, not yet shared' : ''}`;
    syncNotesToggle(rep.lang);
    renderSummary($('#writer-summary'), rep);
    $('#writer-note').textContent = rep.note;
    renderManuscript($('#writer-ms'), rep, 'writer');
}

function openReport(obj) {
    if (!obj || obj.format !== 'breathmarks-report' || !Array.isArray(obj.paragraphs)) {
        showError('Not a Breathmarks file', 'Open the .breathmarks.json file your reader saved.');
        return;
    }
    hideError();
    S.report = obj;
    S.noteLang = obj.noteLang === 'ja' ? 'ja' : 'en';
    S.reportFromPreview = false;
    S.revise = new Set();
    renderWriter();
    setScreen('writer');
}

// ---------------------------------------------------------------------------
// Share / export
// ---------------------------------------------------------------------------
function slug(s) {
    return String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'draft';
}

async function saveFile(name, content, mime) {
    if (bridge) {
        const res = await bridge.exportFile(name, content);
        return res.ok ? res.filePath : null;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return name;
}

async function exportAs(kind) {
    const rep = readerReport();
    const base = `${slug(rep.title)}.breathmarks`;
    let saved;
    if (kind === 'html') saved = await saveFile(`${base}.html`, R.reportToHTML(rep), 'text/html');
    else if (kind === 'json') saved = await saveFile(`${base}.json`, JSON.stringify(rep, null, 2), 'application/json');
    else saved = await saveFile(`${base}.md`, R.reportToMarkdown(rep), 'text/markdown');
    $('#share-status').textContent = saved ? `Saved: ${saved}. Send it to the writer however you like.` : 'Not saved.';
}

function goHome() {
    S.manuscript = null;
    setScreen('home');
}

function goConsent() {
    $('#consent-check').checked = false;
    updateConsentState();
    setScreen('consent');
}

function deleteEverything() {
    if (!confirm('Delete these readings and marks? Nothing has been shared. This cannot be undone.')) return;
    S.session = null;
    S.analysis = null;
    S.removed = new Set();
    S.store.reset();
    goHome();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function refreshKeyStatus() {
    const el = $('#key-status');
    if (!bridge) { el.textContent = 'Browser preview: the camera mode needs the desktop app.'; return; }
    S.config = await bridge.getConfig();
    const src = S.config.keySource;
    el.textContent = src === 'env' ? 'Using the SMARTSPECTRA_API_KEY environment variable.'
        : src === 'saved' ? 'A key is saved (encrypted) on this computer.' : 'No key set.';
    updateConsentState();
}

async function openSettings() {
    const st = S.settings;
    $('#set-pulse').checked = st.pulse;
    $('#set-blink').checked = st.blinking;
    $('#set-talk').checked = st.talking;
    $('#set-telemetry').checked = st.telemetry;
    $('#set-bundles').checked = st.bundles;
    const lock = !!S.source;
    for (const id of ['#set-pulse', '#set-blink', '#set-talk', '#set-telemetry', '#set-camera', '#set-bundles']) $(id).disabled = lock;
    await refreshKeyStatus();
    await fillCameras();
    $('#about-line').textContent = `Breathmarks 0.1.0 · SmartSpectra SDK ${S.config?.sdkVersion ?? 'not loaded'}${lock ? ' · Signal settings are locked while the camera is on.' : ''}`;
    $('#settings').showModal();
}

async function fillCameras() {
    const sel = $('#set-camera');
    sel.replaceChildren(new Option('Default camera', ''));
    try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        devs.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    } catch { /* not available */ }
    sel.value = S.settings.cameraId || '';
}

function bindSettings() {
    const chk = (id, key) => $(id).addEventListener('change', (e) => { S.settings[key] = e.target.checked; saveSettings(); });
    chk('#set-pulse', 'pulse');
    chk('#set-blink', 'blinking');
    chk('#set-talk', 'talking');
    chk('#set-telemetry', 'telemetry');
    chk('#set-bundles', 'bundles');
    $('#set-camera').addEventListener('change', (e) => { S.settings.cameraId = e.target.value; saveSettings(); });
    $('#key-save').addEventListener('click', async () => {
        if (!bridge) return;
        const res = await bridge.saveApiKey($('#key-input').value);
        $('#key-input').value = '';
        if (!res.ok) showError('Key not saved', res.error || '');
        await refreshKeyStatus();
    });
    $('#key-clear').addEventListener('click', async () => {
        if (!bridge) return;
        await bridge.clearApiKey();
        await refreshKeyStatus();
    });
}

function liveAvailable() {
    return !!(bridge && S.config && S.config.sdkAvailable && !S.config.forceSimulated);
}

function updateConsentState() {
    const note = $('#consent-key-note');
    let msg = '';
    if (!bridge) msg = 'Browser preview: only simulated signals are available here. Run the desktop app (npm start) to use the camera.';
    else if (!S.config?.sdkAvailable) msg = `The SmartSpectra SDK could not be loaded on this computer, so only simulated signals are available. ${S.config?.sdkLoadError ?? ''}`;
    else if (S.config.forceSimulated) msg = 'Started with --simulated: the camera is disabled for this run.';
    else if (!S.config.keySource) msg = 'No Presage API key yet. Add one in Settings to use the camera, or try with simulated signals.';
    note.hidden = !msg;
    note.textContent = msg;
    $('#btn-live').disabled = !(liveAvailable() && S.config.keySource && $('#consent-check').checked);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
function loop() {
    const t = nowT();
    const dt = S.lastLoopT == null ? 0 : Math.max(0, Math.min(1, t - S.lastLoopT));
    S.lastLoopT = S.source ? t : null;
    if (S.source && S.screen === 'baseline' && S.session) updateBaseline(t, dt);
    if (S.source && S.screen === 'read') {
        drawSpark($('#rs-trace'), S.store.breathTrace, t, 20);
        if (performance.now() - S.readStartedAt > 7000) $('#key-hint').classList.add('gone');
    }
    requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bindUi() {
    $('#nav-home').addEventListener('click', async () => {
        if (S.source && !confirm('Stop the camera and leave this reading?')) return;
        await stopSource(); S.sourceKind = null; goHome();
    });
    $('#nav-settings').addEventListener('click', openSettings);
    $('#btn-paste').addEventListener('click', () => { $('#paste-box').hidden = !$('#paste-box').hidden; $('#paste-text').focus(); });
    $('#btn-paste-go').addEventListener('click', () => loadManuscript($('#paste-text').value, { title: $('#paste-title').value.trim() }));
    $('#file-draft').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (f) loadManuscript(await readFileAsText(f), { fileName: f.name });
    });
    $$('[data-sample]').forEach((b) => b.addEventListener('click', () => {
        const s = samples.find((x) => x.id === b.dataset.sample);
        loadManuscript(s.text, { sample: s });
    }));
    for (const id of ['#file-report', '#file-report-2']) {
        $(id).addEventListener('change', async (e) => {
            const f = e.target.files[0];
            e.target.value = '';
            if (!f) return;
            try { openReport(JSON.parse(await readFileAsText(f))); } catch (err) { showError('Could not open the file', err.message); }
        });
    }

    $$('button[data-layout]').forEach((b) => b.addEventListener('click', () => { S.layout = b.dataset.layout; renderConsent(); }));
    $('#consent-check').addEventListener('change', updateConsentState);
    $('#btn-live').addEventListener('click', () => startSource('live'));
    $('#btn-sim').addEventListener('click', () => startSource('simulated'));
    $('#btn-back-home').addEventListener('click', goHome);

    $$('button[data-preview]').forEach((b) => b.addEventListener('click', () => setPreviewMode(b.dataset.preview)));
    $('#btn-start-read').addEventListener('click', beginReading);

    $('#reader').addEventListener('click', (e) => {
        const p = e.target.closest('p[data-i]');
        if (p) focusPara(Number(p.dataset.i));
    });
    $('#btn-finish').addEventListener('click', finishReading);

    $('#review-ms').addEventListener('click', (e) => {
        const b = e.target.closest('[data-toggle]');
        if (!b) return;
        const i = Number(b.dataset.toggle);
        if (S.removed.has(i)) S.removed.delete(i); else S.removed.add(i);
        renderReview();
    });
    $('#writer-ms').addEventListener('click', (e) => {
        const b = e.target.closest('[data-revise]');
        if (!b) return;
        const i = Number(b.dataset.revise);
        if (S.revise.has(i)) S.revise.delete(i); else S.revise.add(i);
        renderWriter();
    });
    $$('button[data-notes]').forEach((b) => b.addEventListener('click', () => {
        S.noteLang = b.dataset.notes;
        if (S.screen === 'writer') {
            if (S.reportFromPreview) S.report = readerReport();
            renderWriter();
        } else if (S.analysis) renderReview();
    }));
    $('#btn-share').addEventListener('click', () => { $('#share-status').textContent = ''; $('#share').showModal(); });
    $('#btn-delete').addEventListener('click', deleteEverything);
    $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.export)));
    $('#btn-copy-summary').addEventListener('click', async () => {
        const rep = readerReport();
        const text = [`Breath marks: ${rep.title}`, ...R.summaryLines(rep, S.noteLang), rep.note].join('\n');
        try { await navigator.clipboard.writeText(text); $('#share-status').textContent = 'Summary copied.'; } catch { $('#share-status').textContent = 'Could not copy.'; }
    });
    $('#btn-preview-writer').addEventListener('click', () => {
        S.report = readerReport();
        S.reportFromPreview = true;
        S.revise = new Set();
        $('#share').close();
        renderWriter();
        setScreen('writer');
    });
    $('#btn-writer-home').addEventListener('click', () => {
        if (S.reportFromPreview && S.analysis) { renderReview(); setScreen('review'); requestAnimationFrame(() => drawStrip($('#strip'), S.session, S.analysis)); }
        else goHome();
    });

    $('#btn-stop-camera').addEventListener('click', async () => {
        if (S.screen === 'read') { await finishReading(); return; }
        await stopSource();
        S.sourceKind = null;
        S.session = null;
        updateSourceBadges();
        goConsent();
    });
    $('#error-close').addEventListener('click', hideError);
    $('#error-settings').addEventListener('click', () => { hideError(); openSettings(); });
    $('#error-sim').addEventListener('click', () => { if (S.manuscript) startSource('simulated'); else hideError(); });

    document.addEventListener('keydown', (e) => {
        if (S.screen !== 'read' || $('#settings').open) return;
        const vertical = S.layout === 'vertical';
        const next = vertical ? ['ArrowLeft', 'ArrowDown', ' ', 'PageDown', 'Enter'] : ['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'];
        const prev = vertical ? ['ArrowRight', 'ArrowUp', 'PageUp'] : ['ArrowLeft', 'ArrowUp', 'PageUp'];
        if (next.includes(e.key)) { e.preventDefault(); step(1); }
        else if (prev.includes(e.key)) { e.preventDefault(); step(-1); }
        else if (e.key === 'Escape') finishReading();
    });
    window.addEventListener('resize', () => { if (S.screen === 'review' && S.analysis) drawStrip($('#strip'), S.session, S.analysis); });
    window.addEventListener('beforeunload', () => { if (S.source) { try { S.source.destroy(); } catch { /* ignore */ } } });
    bindSettings();
}

async function init() {
    S.config = bridge ? await bridge.getConfig() : { sdkAvailable: false, keySource: null, simSpeed: 1 };
    setPreviewMode(S.settings.preview);
    bindUi();
    setScreen('home');
    requestAnimationFrame(loop);
    // Hooks for scripts/screenshots.mjs (harmless otherwise).
    window.__bm = { S, loadManuscript, samples, startSource, beginReading, focusPara, finishReading, openReport, setPreviewMode, readerReport, renderReview };
}

init();
