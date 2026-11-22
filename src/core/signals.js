// signals.js
// Accumulates decoded SmartSpectra `Metrics` payloads into simple per-signal
// time series (seconds since session start). Pure JS, no DOM, so it can be
// unit-tested with `node --test` and shared by live and simulated sources.
//
// The SDK's `metrics` event delivers a *windowed* slice since the previous
// emit (see the Presage electron-quickstart renderer.js), so we append and
// de-duplicate by timestamp instead of replacing.

'use strict';

/** Convert a protobuf int64 (number, bigint or protobufjs Long) to a number. */
function tsToNumber(ts) {
    if (ts == null) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'bigint') return Number(ts);
    if (typeof ts.toNumber === 'function') return ts.toNumber();
    return Number(ts);
}

// Gaps in talking shorter than this are treated as the same utterance
// (talking detection naturally flickers between words).
const TALK_MERGE_GAP_S = 0.8;

class SignalStore {
    constructor() {
        this.reset();
    }

    reset(originUs = null) {
        this.originUs = originUs;     // epoch µs that maps to t = 0
        this.pulse = [];              // { t, v, c, s }
        this.breathing = [];          // { t, v, c, s, r }  r = reliable (not contaminated by speech)
        this.breathTrace = [];        // { t, v }
        this.talking = [];            // { t, d }  d = detected
        this.blinking = [];           // { t, d }  d = eyes closed in a blink
        this.talkSegments = [];       // { start, end }  closed + one open segment (end = null)
        this._last = { pulse: -Infinity, breathing: -Infinity, breathTrace: -Infinity, talking: -Infinity, blinking: -Infinity };
        this.lastSampleT = 0;
    }

    setOrigin(originUs) {
        if (this.originUs == null) this.originUs = originUs;
    }

    toT(ts) {
        const us = tsToNumber(ts);
        if (this.originUs == null) this.originUs = us;
        return (us - this.originUs) / 1e6;
    }

    /**
     * Ingest one decoded Metrics object.
     * @returns {{pulse:number, breathing:number, talking:number}} counts of new samples
     */
    ingest(m) {
        const added = { pulse: 0, breathing: 0, talking: 0 };
        if (!m || typeof m !== 'object') return added;

        for (const x of m.cardio?.pulseRate ?? []) {
            const t = this.toT(x.timestamp);
            if (t <= this._last.pulse) continue;
            this._last.pulse = t;
            this.pulse.push({ t, v: x.value, c: x.confidence ?? 0, s: !!x.stable });
            added.pulse++;
            this._bump(t);
        }

        // Talking first, so breathing samples in the same packet can be
        // classified against up-to-date speech activity.
        for (const x of m.face?.talking ?? []) {
            const t = this.toT(x.timestamp);
            if (t <= this._last.talking) continue;
            this._last.talking = t;
            this.talking.push({ t, d: !!x.detected });
            this._updateTalkSegments(t, !!x.detected);
            added.talking++;
            this._bump(t);
        }

        for (const x of m.face?.blinking ?? []) {
            const t = this.toT(x.timestamp);
            if (t <= this._last.blinking) continue;
            this._last.blinking = t;
            this.blinking.push({ t, d: !!x.detected });
            this._bump(t);
        }

        for (const x of m.breathing?.rate ?? []) {
            const t = this.toT(x.timestamp);
            if (t <= this._last.breathing) continue;
            this._last.breathing = t;
            // Breathing rate is a 30-second average and the model card lists
            // "Talking" as a condition where it does not work. Mark samples
            // whose window overlaps meaningful speech as not reliable.
            const r = this.talkFraction(t - 30, t) < 0.15;
            this.breathing.push({ t, v: x.value, c: x.confidence ?? 0, s: !!x.stable, r });
            added.breathing++;
            this._bump(t);
        }

        for (const x of m.breathing?.upperTrace ?? []) {
            const t = this.toT(x.timestamp);
            if (t <= this._last.breathTrace) continue;
            this._last.breathTrace = t;
            this.breathTrace.push({ t, v: x.value });
            this._bump(t);
        }
        return added;
    }

    _bump(t) {
        if (t > this.lastSampleT) this.lastSampleT = t;
    }

    _updateTalkSegments(t, detected) {
        const segs = this.talkSegments;
        const open = segs.length && segs[segs.length - 1].end == null ? segs[segs.length - 1] : null;
        if (detected) {
            if (open) { open.lastOn = t; return; }
            const prev = segs[segs.length - 1];
            if (prev && t - prev.end <= TALK_MERGE_GAP_S) {
                prev.end = null;           // re-open: short gap between words
                prev.lastOn = t;
                return;
            }
            segs.push({ start: t, end: null, lastOn: t });
        } else if (open) {
            if (t - open.lastOn >= TALK_MERGE_GAP_S) open.end = open.lastOn;
        }
    }

    /** Close any open talking segment (call at session end). */
    finalize() {
        const segs = this.talkSegments;
        const last = segs[segs.length - 1];
        if (last && last.end == null) last.end = last.lastOn;
    }

    /** True when speech was detected within `withinS` seconds before `t`. */
    isTalking(t = this.lastSampleT, withinS = 1.0) {
        for (let i = this.talking.length - 1; i >= 0; i--) {
            const x = this.talking[i];
            if (x.t < t - withinS) break;
            if (x.d) return true;
        }
        return false;
    }

    /** Length (s) of the current uninterrupted speaking stretch, or 0. */
    currentTalkStretch(t = this.lastSampleT) {
        const segs = this.talkSegments;
        const last = segs[segs.length - 1];
        if (!last || last.end != null) return 0;
        if (t - last.lastOn > TALK_MERGE_GAP_S * 2) return 0;
        return Math.max(0, last.lastOn - last.start);
    }

    /** Fraction of [a, b] covered by talking segments. */
    talkFraction(a, b) {
        if (b <= a) return 0;
        let covered = 0;
        for (const s of this.talkSegments) {
            const end = s.end == null ? s.lastOn : s.end;
            const lo = Math.max(a, s.start);
            const hi = Math.min(b, end);
            if (hi > lo) covered += hi - lo;
        }
        return covered / (b - a);
    }

    latest(series, { stableOnly = false } = {}) {
        const arr = this[series];
        for (let i = arr.length - 1; i >= 0; i--) {
            if (!stableOnly || arr[i].s) return arr[i];
        }
        return null;
    }

    /** Median of stable values of a series within [a, b]. */
    median(series, a, b, { reliableOnly = false } = {}) {
        const vals = this[series]
            .filter((x) => x.t >= a && x.t <= b && x.s && (!reliableOnly || x.r !== false))
            .map((x) => x.v)
            .sort((p, q) => p - q);
        if (!vals.length) return null;
        const mid = vals.length >> 1;
        return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    }

    toJSON() {
        return {
            originUs: this.originUs,
            pulse: this.pulse,
            breathing: this.breathing,
            talking: this.talking,
            talkSegments: this.talkSegments.map(({ start, end, lastOn }) => ({ start, end: end ?? lastOn })),
            blinking: this.blinking,
            // Kept in memory for the analysis only. The shared report never contains it.
            breathTrace: this.breathTrace,
        };
    }
}

module.exports = { SignalStore, tsToNumber, TALK_MERGE_GAP_S };
