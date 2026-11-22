// draw.js — the two small canvases: a live chest-movement line and the
// whole-read strip on the review screen.

'use strict';

function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
}

function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
}

/** Thin line of the last `windowS` seconds of the chest trace. */
function drawSpark(canvas, trace, nowT, windowS = 20, color = css('--ink-2')) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const t0 = nowT - windowS;
    const pts = [];
    for (let k = trace.length - 1; k >= 0; k--) {
        const p = trace[k];
        if (p.t < t0) break;
        if (p.t <= nowT) pts.push(p);
    }
    pts.reverse();
    if (pts.length < 3) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    const span = Math.max(1e-6, hi - lo);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    pts.forEach((p, i) => {
        const x = ((p.t - t0) / windowS) * w;
        const y = h - 3 - ((p.v - lo) / span) * (h - 6);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    return true;
}

/**
 * Whole-read strip: chest trace (normalised per 20 s so drift doesn't flatten
 * it), paragraph boundaries with numbers, red bands where breath paused,
 * hatched where the face was out of view.
 */
function drawStrip(canvas, session, analysis) {
    const { ctx, w, h } = fitCanvas(canvas);
    const C = { ink: css('--ink'), ink2: css('--ink-2'), muted: css('--muted'), rule: css('--rule'), red: css('--red') };
    ctx.clearRect(0, 0, w, h);
    const a = session.phases.readStart;
    const b = session.phases.readEnd;
    if (!(b > a)) return;
    const padL = 8;
    const padR = 8;
    const top = 10;
    const bottom = h - 22;
    const x = (t) => padL + ((t - a) / (b - a)) * (w - padL - padR);

    // away (no face)
    ctx.fillStyle = 'rgba(123,115,102,.18)';
    for (const iv of analysis.away) ctx.fillRect(x(Math.max(a, iv.start)), top, Math.max(1, x(Math.min(b, iv.end)) - x(Math.max(a, iv.start))), bottom - top);
    // pauses
    ctx.fillStyle = 'rgba(179,38,30,.16)';
    for (const hd of analysis.holds) ctx.fillRect(x(hd.start), top, Math.max(2, x(hd.end) - x(hd.start)), bottom - top);

    // paragraph boundaries + numbers (first visit of each paragraph)
    ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let lastLabelX = -100;
    const firsts = new Map();
    for (const v of session.visits) if (!firsts.has(v.i)) firsts.set(v.i, v);
    for (const v of session.visits) {
        const px = x(v.start);
        ctx.strokeStyle = C.rule;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
    }
    for (const [i, v] of firsts) {
        const mid = x((v.start + v.end) / 2);
        if (mid - lastLabelX < 22) continue;
        const marked = analysis.paragraphs[i]?.marks.some((m) => m.strong);
        ctx.fillStyle = marked ? C.red : C.muted;
        ctx.fillText(`¶${i + 1}`, mid, h - 6);
        lastLabelX = mid;
    }

    // trace, normalised in 20 s chunks
    const tr = (session.signals.breathTrace || []).filter((p) => p.t >= a && p.t <= b);
    if (tr.length > 3) {
        ctx.strokeStyle = C.ink2;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let chunk = [];
        let started = false;
        const flush = () => {
            if (!chunk.length) return;
            let lo = Infinity;
            let hi = -Infinity;
            for (const p of chunk) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
            const span = Math.max(1e-6, hi - lo);
            for (const p of chunk) {
                const y = bottom - 6 - ((p.v - lo) / span) * (bottom - top - 12);
                if (!started) { ctx.moveTo(x(p.t), y); started = true; } else ctx.lineTo(x(p.t), y);
            }
            chunk = [];
        };
        let c0 = tr[0].t;
        for (const p of tr) {
            if (p.t - c0 > 20) { flush(); c0 = p.t; }
            chunk.push(p);
        }
        flush();
        ctx.stroke();
    }
}

module.exports = { drawSpark, drawStrip, fitCanvas };
