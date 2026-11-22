// reading.js
// Pure analysis for Breathmarks: turns one silent read-through into
// per-paragraph "breath marks". No DOM, so it runs under `node --test`.
//
// Everything is compared with the SAME reader's calm baseline (the 30 s
// before reading). Nothing here interprets emotions or health. The output is
// descriptive: "no breath for ~6 s", "pulse +8 vs calm", "steady".

'use strict';

// ---------------------------------------------------------------------------
// Manuscript
// ---------------------------------------------------------------------------

const JA_RE = /[぀-ヿ㐀-鿿]/g;

function isJapanese(text) {
    const ja = (String(text).match(JA_RE) || []).length;
    const latin = (String(text).match(/[A-Za-z]/g) || []).length;
    return ja > 20 && ja > latin * 0.5;
}

/** Remove a Project Gutenberg header/footer if the text has one. */
function stripGutenberg(text) {
    let t = String(text).replace(/\r\n?/g, '\n');
    const start = t.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
    if (start >= 0) t = t.slice(t.indexOf('\n', start) + 1);
    const end = t.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
    if (end >= 0) t = t.slice(0, end);
    return t;
}

/** Light Markdown cleanup: headings become titles, emphasis markers dropped. */
function stripMarkdown(line) {
    return line
        .replace(/^#{1,6}\s+/, '')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1$2')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

function countUnits(text, lang) {
    if (lang === 'ja') return (String(text).match(/[^\s　「」『』（）、。，．！？…―]/g) || []).length;
    return (String(text).match(/[A-Za-z0-9’'-]+/g) || []).length;
}

/**
 * Split text into paragraphs. Blank lines separate paragraphs; for Japanese
 * text (where one paragraph per line is common) every non-empty line that
 * starts with an indent or a quote also starts a paragraph.
 */
function parseManuscript(raw, { title = '', fileName = '' } = {}) {
    let text = stripGutenberg(raw).replace(/\r\n?/g, '\n');
    const lang = isJapanese(text) ? 'ja' : 'en';
    const lines = text.split('\n');
    const blocks = [];
    let cur = [];
    const flush = () => {
        const joined = lang === 'ja' ? cur.join('') : cur.join(' ');
        const t = joined.replace(/[ \t]+/g, ' ').trim();
        if (t) blocks.push(t);
        cur = [];
    };
    for (let line of lines) {
        line = stripMarkdown(line.replace(/\s+$/, ''));
        if (!line.trim()) { flush(); continue; }
        if (lang === 'ja' && cur.length && /^[　「『（]/.test(line)) flush();
        cur.push(lang === 'ja' ? line.trim() : line.trim());
    }
    flush();

    // A short first block in capitals or without final punctuation is the title.
    let docTitle = title;
    if (!docTitle && blocks.length > 1) {
        const first = blocks[0];
        const looksLikeTitle = first.length <= 80 && !/[.!?。！？」]$/.test(first);
        if (looksLikeTitle) docTitle = blocks.shift();
    }
    if (!docTitle) docTitle = fileName.replace(/\.(txt|md|markdown)$/i, '') || (lang === 'ja' ? '無題' : 'Untitled draft');

    const paragraphs = blocks.map((t, i) => ({ i, text: t, units: countUnits(t, lang) }));
    const totalUnits = paragraphs.reduce((a, p) => a + p.units, 0);
    // Rough reading speed for the time estimate only: 230 wpm / 500 chars per minute.
    const estMin = totalUnits / (lang === 'ja' ? 500 : 230);
    return { title: docTitle, lang, paragraphs, totalUnits, estMin };
}

// ---------------------------------------------------------------------------
// Small statistics helpers
// ---------------------------------------------------------------------------

function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function quantile(values, q) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const pos = (v.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function overlap(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// ---------------------------------------------------------------------------
// Breathing trace: detrend, find breaths, find pauses
// ---------------------------------------------------------------------------

/** Subtract a centred moving average (half-width `halfS` seconds). */
function detrend(trace, halfS = 4) {
    const n = trace.length;
    const out = new Array(n);
    let lo = 0;
    let hi = 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
        const t = trace[k].t;
        while (hi < n && trace[hi].t <= t + halfS) { sum += trace[hi].v; hi++; }
        while (lo < hi && trace[lo].t < t - halfS) { sum -= trace[lo].v; lo++; }
        out[k] = { t, v: trace[k].v - sum / Math.max(1, hi - lo) };
    }
    return out;
}

/** Peak-to-peak size of the detrended trace (robust: 5th to 95th percentile). */
function traceSpan(d) {
    if (d.length < 10) return null;
    const vals = d.map((p) => p.v);
    return quantile(vals, 0.95) - quantile(vals, 0.05);
}

/**
 * Breath onsets: upward crossings of the detrended trace with hysteresis
 * (it must go below -h and then above +h). Returns onset times.
 */
function breathOnsets(d, h) {
    const onsets = [];
    let armed = false;
    for (const p of d) {
        if (p.v < -h) armed = true;
        else if (armed && p.v > h) { onsets.push(p.t); armed = false; }
    }
    return onsets;
}

/**
 * Breath pauses ("held breath"): gaps between breaths that are long compared
 * with the reader's own calm rhythm AND where the chest trace stayed nearly
 * flat. Gaps overlapping "no face" time or speech are skipped.
 */
function findHolds(d, onsets, base, { a, b, excluded = [], minHoldS = 4, flatFrac = 0.25, raw = null } = {}) {
    if (!base || !base.span || !base.period) return [];
    // A pause of H seconds between two breaths makes the onset gap ≈ period + H.
    const minGap = Math.max(1.8 * base.period, base.period + minHoldS);
    const on = onsets.filter((t) => t >= a && t <= b);
    const holds = [];
    for (let k = 1; k < on.length; k++) {
        const g0 = on[k - 1];
        const g1 = on[k];
        if (g1 - g0 < minGap) continue;
        // Longest run inside the gap where the chest trace barely moves
        // (range within a ±1 s window below a quarter of the calm breath size).
        // Flatness is judged on the raw trace: the detrended one drifts during a pause.
        const seg = (raw || d).filter((p) => p.t > g0 && p.t < g1);
        let runStart = null;
        let best = null;
        for (let j = 0; j < seg.length; j++) {
            const t = seg[j].t;
            let lo = Infinity;
            let hi = -Infinity;
            for (let q = j; q >= 0 && seg[q].t >= t - 1; q--) { lo = Math.min(lo, seg[q].v); hi = Math.max(hi, seg[q].v); }
            for (let q = j; q < seg.length && seg[q].t <= t + 1; q++) { lo = Math.min(lo, seg[q].v); hi = Math.max(hi, seg[q].v); }
            const flat = hi - lo < flatFrac * base.span;
            if (flat && runStart == null) runStart = t;
            if ((!flat || j === seg.length - 1) && runStart != null) {
                const end = flat ? t : seg[j - 1].t;
                if (!best || end - runStart > best.dur) best = { start: runStart, end, dur: end - runStart };
                runStart = null;
            }
        }
        if (!best || best.dur < minHoldS) continue;
        const ex = excluded.reduce((s, e) => s + overlap(best.start, best.end, e.start, e.end), 0);
        if (ex > 0.3 * best.dur) continue;                 // camera lost the face or the reader spoke
        holds.push(best);
    }
    return holds;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Intervals where the validation status said "no face" (code 1). */
function awayIntervals(validation, endT) {
    const out = [];
    let open = null;
    for (const v of validation) {
        if (v.code === 1 && open == null) open = v.t;
        else if (v.code !== 1 && open != null) { out.push({ start: open, end: v.t }); open = null; }
    }
    if (open != null) out.push({ start: open, end: endT });
    return out;
}

/** Blink onsets from DetectionStatus samples (false -> true transitions). */
function blinkOnsets(blinking) {
    const out = [];
    let prev = false;
    for (const b of blinking) {
        if (b.d && !prev) out.push(b.t);
        prev = !!b.d;
    }
    return out;
}

/** Merge paragraph visits into per-paragraph lists of intervals. */
function visitsByParagraph(visits, n) {
    const by = Array.from({ length: n }, () => []);
    for (const v of visits) if (v.end > v.start && by[v.i]) by[v.i].push({ start: v.start, end: v.end });
    return by;
}

function computeBaseline(session) {
    const { baselineStart: a, baselineEnd: b } = session.phases;
    const sig = session.signals;
    const out = { pulse: null, breathRate: null, period: null, span: null, blinkRate: null, seconds: b - a };
    if (a == null || b == null || b <= a) return out;
    out.pulse = median(sig.pulse.filter((x) => x.s && x.t >= a && x.t <= b).map((x) => x.v));
    out.breathRate = median(sig.breathing.filter((x) => x.s && x.t >= a - 5 && x.t <= b + 5).map((x) => x.v));
    const tr = (sig.breathTrace || []).filter((p) => p.t >= a && p.t <= b);
    const d = detrend(tr);
    out.span = traceSpan(d);
    if (out.span) {
        const on = breathOnsets(d, 0.15 * out.span);
        const gaps = [];
        for (let k = 1; k < on.length; k++) gaps.push(on[k] - on[k - 1]);
        out.period = median(gaps);
        out.traceRate = out.period ? 60 / out.period : null;
    }
    if ((sig.blinking || []).length) {
        const bl = blinkOnsets(sig.blinking).filter((t) => t >= a && t <= b);
        out.blinkRate = (bl.length / (b - a)) * 60;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

const DEFAULTS = {
    pulseDelta: 6,        // bpm vs calm before a pulse mark is shown
    breathRel: 0.25,      // relative change in breaths/min
    breathAbs: 3,         // and at least this many breaths/min
    minDwellRate: 10,     // s on a paragraph before a breathing-rate mark is possible
    minDwellBlink: 15,
    minExpectedBlinks: 5,  // calm blink rate × dwell must predict at least this many
    awayMin: 3,           // s without a face before "looked away"
    slowFactor: 0.6,      // pace below 60 % of the reader's median -> "lingered"
    fastFactor: 1.8,      // pace above 180 % -> "skimmed"
};

function fmtS(s) {
    return `${Math.round(s)} s`;
}

/**
 * @param {object} session  { manuscript, phases, visits, validation, signals }
 * @returns analysis object (see README "How it responds to human signals")
 */
function analyzeReading(session, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const ms = session.manuscript;
    const n = ms.paragraphs.length;
    const sig = session.signals;
    const { readStart, readEnd } = session.phases;
    const base = computeBaseline(session);

    const away = awayIntervals(session.validation || [], readEnd);
    const talk = (sig.talkSegments || []).map((g) => ({ start: g.start, end: g.end }));
    const excluded = [...away, ...talk];

    // Breaths over the whole read (detrend once, so paragraph edges do not matter).
    const tr = (sig.breathTrace || []).filter((p) => p.t >= readStart - 5 && p.t <= readEnd + 5);
    const d = detrend(tr);
    const h = base.span ? 0.15 * base.span : (traceSpan(d) || 1) * 0.15;
    const onsets = breathOnsets(d, h);
    const holds = findHolds(d, onsets, base, { a: readStart, b: readEnd, excluded, raw: tr });
    const blinks = blinkOnsets(sig.blinking || []);
    const hasBlink = (sig.blinking || []).length > 0;

    const visits = visitsByParagraph(session.visits || [], n);
    const unitName = ms.lang === 'ja' ? 'chars' : 'words';

    const paras = ms.paragraphs.map((p) => {
        const iv = visits[p.i];
        const dwell = iv.reduce((s, v) => s + (v.end - v.start), 0);
        const within = (t) => iv.some((v) => t >= v.start && t < v.end);
        const ovl = (s0, s1) => iv.reduce((s, v) => s + overlap(s0, s1, v.start, v.end), 0);

        const r = {
            i: p.i,
            dwellS: dwell,
            units: p.units,
            pace: dwell > 0 ? p.units / (dwell / 60) : null,
            pulse: null, pulseDelta: null,
            breathRate: null, breathDelta: null, breaths: 0,
            holds: [],
            blinkRate: null,
            awayS: away.reduce((s, a) => s + ovl(a.start, a.end), 0),
            talkS: talk.reduce((s, a) => s + ovl(a.start, a.end), 0),
            marks: [],
            enough: false,
            steady: false,
        };
        if (dwell <= 0) return r;

        // Pulse: the SDK reports a ~12 s average, so look a little past the paragraph.
        const pv = sig.pulse.filter((x) => x.s && iv.some((v) => x.t >= v.start + 2 && x.t <= v.end + 6)).map((x) => x.v);
        r.pulse = median(pv);
        if (r.pulse != null && base.pulse != null) r.pulseDelta = r.pulse - base.pulse;

        // Breathing rate from the chest trace inside this paragraph.
        const on = onsets.filter(within);
        r.breaths = on.length;
        if (dwell >= cfg.minDwellRate && on.length >= 2 && r.talkS < 0.3 * dwell) {
            r.breathRate = (on.length / dwell) * 60;
            if (base.traceRate) r.breathDelta = r.breathRate - base.traceRate;
        }

        // Pauses: a pause belongs to the paragraph it overlaps most.
        r.holds = holds.filter((hd) => {
            let best = -1;
            let bestOv = 0;
            visits.forEach((list, j) => {
                const o = list.reduce((s, v) => s + overlap(hd.start, hd.end, v.start, v.end), 0);
                if (o > bestOv) { bestOv = o; best = j; }
            });
            return best === p.i;
        });

        if (hasBlink && dwell >= cfg.minDwellBlink) r.blinkRate = (blinks.filter(within).length / dwell) * 60;

        // ---- marks (descriptive only) ----
        const m = r.marks;
        const longest = r.holds.reduce((x, hd) => Math.max(x, hd.dur), 0);
        if (longest > 0) {
            m.push({ kind: 'hold', strong: true, value: longest, text: r.holds.length > 1 ? `no breath for ~${Math.round(longest)} s (×${r.holds.length})` : `no breath for ~${Math.round(longest)} s`, textJa: r.holds.length > 1 ? `息が止まった（約${Math.round(longest)}秒・${r.holds.length}回）` : `息が止まった（約${Math.round(longest)}秒）` });
        }
        if (r.pulseDelta != null && Math.abs(r.pulseDelta) >= cfg.pulseDelta) {
            const sgn = r.pulseDelta > 0 ? '+' : '−';
            m.push({ kind: r.pulseDelta > 0 ? 'pulse-up' : 'pulse-down', strong: Math.abs(r.pulseDelta) >= 10, value: r.pulseDelta, text: `pulse ${sgn}${Math.round(Math.abs(r.pulseDelta))} vs calm`, textJa: `脈拍 ${sgn}${Math.round(Math.abs(r.pulseDelta))}（平常時比）` });
        }
        if (!r.holds.length && r.breathDelta != null && Math.abs(r.breathDelta) >= cfg.breathAbs && Math.abs(r.breathDelta) >= cfg.breathRel * base.traceRate) {
            m.push({ kind: r.breathDelta < 0 ? 'breath-slow' : 'breath-fast', strong: false, value: r.breathDelta, text: `breathing ${r.breathDelta < 0 ? 'slowed' : 'quickened'} (${Math.round(r.breathRate)}/min, calm ${Math.round(base.traceRate)})`, textJa: `呼吸が${r.breathDelta < 0 ? 'ゆっくりに' : '速めに'}（毎分${Math.round(r.breathRate)}回・平常${Math.round(base.traceRate)}）` });
        }
        if (r.blinkRate != null && base.blinkRate != null && base.blinkRate >= 6 && (base.blinkRate * dwell) / 60 >= cfg.minExpectedBlinks) {
            if (r.blinkRate <= 0.5 * base.blinkRate) m.push({ kind: 'blink-low', strong: false, value: r.blinkRate, text: `fewer blinks (${Math.round(r.blinkRate)}/min, calm ${Math.round(base.blinkRate)})`, textJa: `まばたきが減った（毎分${Math.round(r.blinkRate)}回・平常${Math.round(base.blinkRate)}）` });
            else if (r.blinkRate >= 1.8 * base.blinkRate && r.blinkRate - base.blinkRate >= 8) m.push({ kind: 'blink-high', strong: false, value: r.blinkRate, text: `more blinks (${Math.round(r.blinkRate)}/min, calm ${Math.round(base.blinkRate)})`, textJa: `まばたきが増えた（毎分${Math.round(r.blinkRate)}回・平常${Math.round(base.blinkRate)}）` });
        }
        if (r.awayS >= cfg.awayMin) m.push({ kind: 'away', strong: false, value: r.awayS, text: `looked away ~${fmtS(r.awayS)}`, textJa: `画面から目を離した（約${Math.round(r.awayS)}秒）` });
        if (r.talkS >= 0.3 * dwell) m.push({ kind: 'talk', strong: false, value: r.talkS, text: 'spoke or read aloud here (breathing not counted)', textJa: '声を出した（呼吸は数えていない）' });

        r.enough = r.pulse != null || r.breaths >= 2;
        return r;
    });

    // Pace relative to this reader's own median pace.
    const paces = paras.filter((r) => r.pace && r.units >= (ms.lang === 'ja' ? 40 : 15)).map((r) => r.pace);
    const medPace = median(paces);
    for (const r of paras) {
        if (!medPace || !r.pace || r.units < (ms.lang === 'ja' ? 20 : 8)) continue;
        if (r.pace < cfg.slowFactor * medPace) r.marks.push({ kind: 'linger', strong: false, value: medPace / r.pace, text: `lingered (${(medPace / r.pace).toFixed(1)}× usual time)`, textJa: `じっくり読んだ（いつもの${(medPace / r.pace).toFixed(1)}倍）` });
        else if (r.pace > cfg.fastFactor * medPace) r.marks.push({ kind: 'skim', strong: false, value: r.pace / medPace, text: 'read quickly (skimmed?)', textJa: 'さっと読んだ（読み飛ばし？）' });
    }
    const ORDER = ['hold', 'pulse-up', 'pulse-down', 'breath-slow', 'breath-fast', 'blink-low', 'blink-high', 'linger', 'skim', 'away', 'talk'];
    for (const r of paras) {
        r.marks.sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind));
        r.steady = r.enough && r.marks.length === 0;
        if (r.dwellS <= 0) r.marks.push({ kind: 'unread', strong: false, text: 'not on screen', textJa: '表示されなかった' });
        else if (!r.enough && !r.marks.length) r.marks.push({ kind: 'nodata', strong: false, text: 'not enough signal', textJa: '信号が足りない' });
    }

    return {
        baseline: base,
        paragraphs: paras,
        holds,
        onsets,
        away,
        medianPace: medPace,
        unitName,
        totalS: readEnd - readStart,
        summary: summarize(paras),
    };
}

/** Top passages and flat stretches, from (possibly reader-edited) paragraphs. */
function summarize(paras, removed = new Set()) {
    const kept = paras.filter((r) => !removed.has(r.i));
    const held = kept
        .map((r) => ({ i: r.i, longest: r.holds.reduce((x, h) => Math.max(x, h.dur), 0), count: r.holds.length }))
        .filter((x) => x.longest > 0)
        .sort((a, b) => b.longest - a.longest)
        .slice(0, 3);
    const pulse = kept
        .filter((r) => r.marks.some((m) => m.kind === 'pulse-up'))
        .sort((a, b) => b.pulseDelta - a.pulseDelta)
        .slice(0, 3)
        .map((r) => ({ i: r.i, delta: r.pulseDelta }));
    const flats = [];
    let run = null;
    for (const r of paras) {
        const flat = !removed.has(r.i) && r.steady;
        if (flat) { if (run) run.to = r.i; else run = { from: r.i, to: r.i }; }
        else { if (run && run.to - run.from >= 2) flats.push(run); run = null; }
    }
    if (run && run.to - run.from >= 2) flats.push(run);
    return { held, pulse, flats };
}

// ---------------------------------------------------------------------------
// Shareable report (what the writer receives). Derived marks only: no raw
// pulse/breathing series, no timestamps, no video.
// ---------------------------------------------------------------------------

function buildReport(session, analysis, removed = new Set(), { readerName = '', noteLang = 'en' } = {}) {
    const ms = session.manuscript;
    return {
        format: 'breathmarks-report',
        version: 1,
        title: ms.title,
        lang: ms.lang,
        vertical: !!ms.vertical,
        createdAt: new Date().toISOString().slice(0, 10),
        source: session.source,            // 'live' | 'simulated'
        noteLang: noteLang === 'ja' ? 'ja' : 'en',
        reader: readerName || null,
        paragraphs: ms.paragraphs.map((p) => {
            const r = analysis.paragraphs[p.i];
            if (removed.has(p.i)) return { i: p.i, text: p.text, withheld: true, marks: [] };
            return {
                i: p.i,
                text: p.text,
                steady: r.steady,
                marks: r.marks.map(({ kind, strong, text, textJa }) => ({ kind, strong: !!strong, text, textJa: textJa || text })),
            };
        }),
        summary: summarize(analysis.paragraphs, removed),
        note: 'Compared only with this reader\'s own calm 30 seconds before reading. Camera estimates, not medical data, not emotions.',
    };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Note text in the report's note language. */
function noteText(m, lang) {
    return lang === 'ja' ? (m.textJa || m.text) : m.text;
}

const WORDS = {
    en: { steady: 'steady', withheld: 'no note shared' },
    ja: { steady: '平静', withheld: '共有されなかった' },
};

function summaryLines(rep, lang = rep.noteLang || 'en') {
    const L = [];
    const s = rep.summary;
    const pn = (i) => `¶${i + 1}`;
    if (lang === 'ja') {
        if (s.held.length) L.push(`息が止まった：${s.held.map((h) => `${pn(h.i)}（約${Math.round(h.longest)}秒）`).join('，')}`);
        if (s.pulse.length) L.push(`脈拍が上がった：${s.pulse.map((p) => `${pn(p.i)}（+${Math.round(p.delta)}）`).join('，')}`);
        if (s.flats.length) L.push(`平静が続いた：${s.flats.map((f) => `${pn(f.from)}〜${pn(f.to)}`).join('，')}`);
        if (!L.length) L.push('平常時と比べて目立った段落はなかった．');
        return L;
    }
    if (s.held.length) L.push(`Breath paused: ${s.held.map((h) => `${pn(h.i)} (~${Math.round(h.longest)} s)`).join(', ')}`);
    if (s.pulse.length) L.push(`Pulse rose: ${s.pulse.map((p) => `${pn(p.i)} (+${Math.round(p.delta)})`).join(', ')}`);
    if (s.flats.length) L.push(`Steady stretches: ${s.flats.map((f) => `${pn(f.from)}–${pn(f.to)}`).join(', ')}`);
    if (!L.length) L.push('No paragraph stood out from the reader\'s calm baseline.');
    return L;
}

function reportToMarkdown(rep) {
    const out = [];
    out.push(`# Breath marks: ${rep.title}`, '');
    if (rep.source === 'simulated') out.push('> **SIMULATED** — generated signals for demonstration, not a real reader.', '');
    out.push(...summaryLines(rep).map((l) => `- ${l}`), '');
    out.push(`_${rep.note}_`, '', '---', '');
    for (const p of rep.paragraphs) {
        const W = WORDS[rep.noteLang === 'ja' ? 'ja' : 'en'];
        const marks = p.withheld ? W.withheld : p.marks.length ? p.marks.map((m) => noteText(m, rep.noteLang)).join(' · ') : W.steady;
        out.push(`**¶${p.i + 1}** — ✎ ${marks}`, '', p.text, '');
    }
    out.push('---', 'Made with Breathmarks (Presage SmartSpectra SDK).', '');
    return out.join('\n');
}

function reportToHTML(rep) {
    const vertical = rep.vertical && rep.lang === 'ja';
    const W = WORDS[rep.noteLang === 'ja' ? 'ja' : 'en'];
    const rows = rep.paragraphs.map((p) => {
        const cls = p.withheld ? 'withheld' : p.marks.some((m) => m.strong) ? 'strong' : p.marks.length ? 'marked' : 'steady';
        const notes = p.withheld ? `<span class="n quiet">${W.withheld}</span>`
            : p.marks.length ? p.marks.map((m) => `<span class="n${m.strong ? ' s' : ''}">${esc(noteText(m, rep.noteLang))}</span>`).join('')
                : `<span class="n quiet">${W.steady}</span>`;
        return `<section class="p ${cls}"><aside><b>¶${p.i + 1}</b>${notes}</aside><p>${esc(p.text)}</p></section>`;
    }).join('\n');
    const sim = rep.source === 'simulated' ? '<div class="sim">SIMULATED — generated signals for demonstration, not a real reader.</div>' : '';
    return `<!doctype html>
<html lang="${rep.lang === 'ja' ? 'ja' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breath marks: ${esc(rep.title)}</title>
<style>
:root{--paper:#f6f1e6;--ink:#211d18;--muted:#6f675c;--red:#b22d22;--rule:#e2d8c6}
body{margin:0;background:var(--paper);color:var(--ink);font:19px/1.7 Literata,Georgia,"Shippori Mincho","Yu Mincho","Hiragino Mincho ProN",serif}
.wrap{max-width:980px;margin:0 auto;padding:48px 24px 80px}
h1{font-weight:400;font-size:36px;margin:0 0 6px}
.sum{border-top:2px solid var(--ink);border-bottom:1px solid var(--rule);padding:12px 0;margin:18px 0 28px}
.sum li{margin:2px 0}.note{color:var(--muted);font-size:15px;font-style:italic}
.sim{background:#fff3c4;border:1px solid #d9b84c;padding:8px 12px;margin:12px 0;font-family:system-ui,sans-serif;font-size:14px}
.p{display:grid;grid-template-columns:210px 1fr;gap:24px;padding:6px 0}
.p aside{font:18px/1.35 Kalam,"Klee One","Segoe Print","Bradley Hand",cursive;color:var(--red);text-align:right;padding-top:4px}
.p aside b{display:block;font:600 13px/1.4 system-ui,sans-serif;color:var(--muted);letter-spacing:.06em}
.p aside .n{display:block}.p aside .quiet{color:var(--muted);font-size:17px}
.p p{margin:0;border-left:3px solid transparent;padding-left:14px}
.p.strong p{border-left-color:var(--red)}.p.marked p{border-left-color:#e3a49b}
.p.withheld p{color:var(--muted)}
${vertical ? `.body{writing-mode:vertical-rl;height:78vh;overflow-x:auto;font-family:"Shippori Mincho","Yu Mincho","Hiragino Mincho ProN","Noto Serif CJK JP",serif}
.p{display:block;margin-left:1.2em}.p aside{text-align:left;font-size:16px;margin-left:.6em}.p p{border-left:0;border-right:3px solid transparent;padding:0 .5em 0 0}
.p.strong p{border-right-color:var(--red)}.p.marked p{border-right-color:#e3a49b}` : ''}
@media (max-width:700px){.p{grid-template-columns:1fr;gap:4px}.p aside{text-align:left}}
footer{margin-top:40px;color:var(--muted);font-size:14px}
</style></head><body><div class="wrap">
<p class="note">Breath marks from a reader${rep.reader ? `: ${esc(rep.reader)}` : ''} · ${esc(rep.createdAt)}</p>
<h1>${esc(rep.title)}</h1>${sim}
<ul class="sum">${summaryLines(rep).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p class="note">${esc(rep.note)}</p>
<div class="body">
${rows}
</div>
<footer>Made with Breathmarks · Presage SmartSpectra SDK. The reader chose what to share.</footer>
</div></body></html>
`;
}

module.exports = {
    parseManuscript, isJapanese, stripGutenberg, countUnits,
    median, quantile, detrend, traceSpan, breathOnsets, findHolds, awayIntervals, blinkOnsets,
    computeBaseline, analyzeReading, summarize, buildReport, reportToMarkdown, reportToHTML, summaryLines, noteText, WORDS,
    DEFAULTS,
};
