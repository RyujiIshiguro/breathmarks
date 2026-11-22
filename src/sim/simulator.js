// simulator.js
// SIMULATED signal source for development, screenshots and tests.
//
// It mimics the event surface of the SmartSpectra renderer SDK
// (`processingStatus`, `validationStatus`, `metrics`, `error`) and encodes its
// synthetic samples with the SDK's own `Metrics` protobuf class, so the app
// decodes them with `decodeMetrics()` exactly like live data. The values come
// from a fixed script keyed to the paragraph on screen. They are NOT
// measurements of anyone, and the UI labels them SIMULATED everywhere.

'use strict';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const V_OK = 0;
const V_NO_FACE = 1;
const V_CAMERA_TUNING = 10;
const HINTS = { [V_OK]: 'OK', [V_NO_FACE]: 'No face found', [V_CAMERA_TUNING]: 'Camera is adjusting, please wait' };

/**
 * Default script for a manuscript of n paragraphs: three "tense" paragraphs
 * (a held breath, pulse up, fewer blinks), one paragraph where the reader
 * looks away for a few seconds, everything else calm.
 */
function defaultPlan(n) {
    const pick = (f) => Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))));
    const beats = [...new Set([pick(0.38), pick(0.64), pick(0.86)])];
    let away = pick(0.5);
    if (beats.includes(away)) away = Math.min(n - 1, away + 1);
    return { beats, away, skim: [pick(0.2)] };
}

class SimulatedSource {
    /**
     * @param {object} opts
     * @param {(obj: object) => Uint8Array} opts.encode
     * @param {number} [opts.speed=1]  simulated seconds per real second
     * @param {number} [opts.seed=11]
     * @param {{pulse?:boolean, blinking?:boolean, talking?:boolean}} [opts.metrics]
     */
    constructor({ encode, speed = 1, seed = 11, metrics = {} } = {}) {
        this.isSimulated = true;
        this._encode = encode;
        this._speed = speed;
        this._rand = mulberry32(seed);
        this._metrics = { pulse: true, blinking: true, talking: true, ...metrics };
        this._listeners = new Map();
        this.processingStatus = 0;
        this._timer = null;
        this._startEpochUs = Date.now() * 1000;
        this._plan = { beats: [], away: -1, skim: [] };
        this._resetState();
    }

    _resetState() {
        this._tau = 0;
        this._next = { pulse: 1, breathing: 1, trace: 0, face: 0 };
        this._phase = 'check';
        this._para = -1;
        this._paraStart = 0;
        this._pulse = 76;
        this._phi = 0;                 // breathing phase (cycles)
        this._hold = null;             // { start, end, level }
        this._valCode = null;
        this._blinkUntil = -1;
        this._nextBlink = 2;
        this._rateWindow = [];         // recent breath onsets for the 30 s rate
    }

    on(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(cb);
        return this;
    }

    _emit(event, ...args) {
        for (const cb of this._listeners.get(event) ?? []) {
            try { cb(...args); } catch (e) { console.error('[sim] listener error', e); }
        }
    }

    _setStatus(s) { this.processingStatus = s; this._emit('processingStatus', s); }

    nowUs() { return this._startEpochUs + Math.round(this._tau * 1e6); }

    /** 'check' | 'baseline' | 'read' */
    setPhase(phase) { this._phase = phase; }

    /** Tell the script which paragraphs are tense etc. */
    setPlan(plan) { this._plan = { beats: [], away: -1, skim: [], ...plan }; }

    /** Called by the app whenever the paragraph on screen changes. */
    setParagraph(i) {
        if (i === this._para) return;
        this._para = i;
        this._paraStart = this._tau;
        if (this._phase === 'read' && this._plan.beats.includes(i)) {
            const start = this._tau + 3 + this._rand() * 2;
            this._hold = { start, end: start + 6 + this._rand() * 2.5, level: null };
        }
    }

    // Kept for interface compatibility with LiveSource.
    setGuide() { }

    async start() {
        this._resetState();
        this._startEpochUs = Date.now() * 1000;
        this._setStatus(2);
        await new Promise((r) => setTimeout(r, 300));
        this._setStatus(3);
        const TICK_MS = 100;
        this._timer = setInterval(() => this._tick((TICK_MS / 1000) * this._speed), TICK_MS);
    }

    async stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this._setStatus(4);
        this._setStatus(1);
    }

    destroy() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this._listeners.clear();
    }

    // --- script --------------------------------------------------------------

    _tense() { return this._phase === 'read' && this._plan.beats.includes(this._para); }

    _validationAt(tau) {
        if (tau < 2) return V_CAMERA_TUNING;
        if (this._phase === 'read' && this._para === this._plan.away) {
            const r = tau - this._paraStart;
            if (r > 4 && r < 9) return V_NO_FACE;
        }
        return V_OK;
    }

    _pulseTarget() {
        if (this._phase !== 'read') return 72;
        return this._tense() ? 82 + 4 * Math.min(1, (this._tau - this._paraStart) / 10) : 73;
    }

    _breathHz() {
        // 14 breaths/min calm; slightly slower while absorbed in a tense passage.
        return (this._tense() ? 11 : 14) / 60;
    }

    _blinkInterval() {
        if (this._phase !== 'read') return 4;          // ~15 / min
        return this._tense() ? 18 : 5.5;                // ~3 / min vs ~11 / min
    }

    _tick(dt) {
        const r = this._rand;
        const t1 = this._tau + dt;
        const ts = (tau) => this._startEpochUs + Math.round(tau * 1e6);
        const out = { breathing: { rate: [], upperTrace: [] }, cardio: { pulseRate: [] }, face: { talking: [], blinking: [] } };

        const code = this._validationAt(t1);
        if (code !== this._valCode) {
            this._valCode = code;
            this._emit('validationStatus', code, ts(t1), HINTS[code]);
        }
        const noFace = code === V_NO_FACE;

        const k = 1 - Math.exp(-dt / 5);
        this._pulse += (this._pulseTarget() - this._pulse) * k;

        if (this._metrics.pulse && !noFace) {
            while (this._next.pulse <= t1) {
                const tau = this._next.pulse;
                const conf = Math.min(90, Math.max(0, (tau - 3) / 9) * 90);
                out.cardio.pulseRate.push({ value: this._pulse + (r() - 0.5) * 1.4, confidence: conf, stable: conf >= 50, timestamp: ts(tau) });
                this._next.pulse += 1;
            }
        } else this._next.pulse = Math.max(this._next.pulse, Math.ceil(t1));

        // chest trace at 10 Hz: a sine, frozen during a scripted pause
        while (this._next.trace <= t1) {
            const tau = this._next.trace;
            const h = this._hold;
            let v;
            if (h && tau >= h.start && tau < h.end) {
                if (h.level == null) h.level = 0.5 + 0.5 * Math.sin(2 * Math.PI * this._phi);
                v = h.level;
            } else {
                const prevPhi = this._phi;
                this._phi += this._breathHz() * 0.1;
                if (Math.floor(prevPhi + 0.25) !== Math.floor(this._phi + 0.25)) this._rateWindow.push(tau);
                v = 0.5 + 0.5 * Math.sin(2 * Math.PI * this._phi);
                if (h && tau >= h.end) this._hold = null;
            }
            if (!noFace) out.breathing.upperTrace.push({ value: v + (r() - 0.5) * 0.03, stable: tau > 30, timestamp: ts(tau) });
            this._next.trace = Math.round((this._next.trace + 0.1) * 10) / 10;
        }

        // breathing rate: 30 s average of the scripted breaths, once per second
        while (this._next.breathing <= t1) {
            const tau = this._next.breathing;
            this._rateWindow = this._rateWindow.filter((t) => t > tau - 30);
            const rate = this._rateWindow.length * 2;
            const conf = tau < 30 ? 0 : 76;
            if (!noFace) out.breathing.rate.push({ value: rate + (r() - 0.5) * 0.4, confidence: conf, stable: conf >= 45, timestamp: ts(tau) });
            this._next.breathing += 1;
        }

        // face: blinking + talking status at 10 Hz
        while (this._next.face <= t1) {
            const tau = this._next.face;
            if (tau >= this._nextBlink) {
                this._blinkUntil = tau + 0.2;
                this._nextBlink = tau + this._blinkInterval() * (0.6 + 0.8 * r());
            }
            if (!noFace) {
                if (this._metrics.blinking) out.face.blinking.push({ detected: tau < this._blinkUntil, stable: true, timestamp: ts(tau) });
                if (this._metrics.talking) out.face.talking.push({ detected: false, stable: true, timestamp: ts(tau) });
            }
            this._next.face = Math.round((this._next.face + 0.1) * 10) / 10;
        }

        this._tau = t1;
        this._emit('metrics', this._encode(out), ts(t1));
    }
}

module.exports = { SimulatedSource, mulberry32, defaultPlan };
