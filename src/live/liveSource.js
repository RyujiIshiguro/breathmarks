// liveSource.js
// Thin wrapper around the SmartSpectra renderer SDK
// (`@smartspectra/node-sdk/renderer`), written against the official
// electron-quickstart sample and the Node.js API reference:
//   https://github.com/Presage-Security/SmartSpectra/tree/main/nodejs/samples/electron-quickstart
//   https://smartspectra.presagetech.com/docs/nodejs/api-reference
//
// It exposes the same small interface as SimulatedSource so the rest of the
// app does not care where signals come from.

'use strict';

const {
    SmartSpectraSDK,
    MetricType,
    SmartSpectraErrorCode,
    breathingMetrics,
    cardioMetrics,
    faceMetrics,
} = require('@smartspectra/node-sdk/renderer');

/**
 * Build the requested metric list.
 *
 * Default (data minimisation): the documented default breathing bundle
 * (chest trace, abdomen trace, breathing rate) plus the individual codes the
 * app uses: PULSE_RATE, BLINKING and TALKING. The Node metrics guide says
 * codes can be hand-picked "for finer control". Expressions, HRV, face
 * landmarks and the arterial pressure trace are NOT requested.
 *
 * Fallback (`bundles: true`, a Settings switch): request the whole documented
 * bundles exactly as in Presage's samples, in case the SDK rejects
 * hand-picked codes on some accounts. Unused fields are ignored.
 */
function requestedMetricsFor({ pulse = true, blinking = true, talking = true, bundles = false }) {
    const list = [...breathingMetrics];
    if (pulse) list.push(...(bundles ? cardioMetrics : [MetricType.PULSE_RATE]));
    if (bundles && (blinking || talking)) list.push(...faceMetrics);
    else {
        if (blinking) list.push(MetricType.BLINKING);
        if (talking) list.push(MetricType.TALKING);
    }
    return [...new Set(list)];
}

const ERROR_NAMES = Object.fromEntries(Object.entries(SmartSpectraErrorCode).map(([k, v]) => [v, k]));

class LiveSource {
    /**
     * @param {object} opts
     * @param {string} opts.apiKey
     * @param {{pulse:boolean, talking:boolean}} opts.metrics
     * @param {boolean} opts.telemetry     SDK telemetry opt-in (default off in this app)
     * @param {string|null} opts.deviceId   camera deviceId, or null for the SDK default
     */
    constructor({ apiKey, metrics, telemetry = false, deviceId = null }) {
        this.isSimulated = false;
        this._deviceId = deviceId;
        this._hostStream = null;
        this._offsetUs = 0;
        this._calibrated = false;
        this.requested = requestedMetricsFor(metrics);
        this.sdk = new SmartSpectraSDK({
            apiKey,
            requestedMetrics: this.requested,
            enableAccumulatedOutput: false,
            enableTelemetry: !!telemetry,
        });
        // Calibrate our marker clock against the SDK's metric timestamps
        // (both are documented as epoch microseconds; this guards against drift).
        this.sdk.on('metrics', (_buf, timestampUs) => {
            if (!this._calibrated && Number.isFinite(Number(timestampUs))) {
                this._offsetUs = Number(timestampUs) - Date.now() * 1000;
                if (Math.abs(this._offsetUs) > 5e6) this._offsetUs = 0; // not the same clock; ignore
                this._calibrated = true;
            }
        });
    }

    on(event, cb) {
        this.sdk.on(event, cb);
        return this;
    }

    get processingStatus() {
        return this.sdk.processingStatus;
    }

    nowUs() {
        return Date.now() * 1000 + this._offsetUs;
    }

    // The simulated source follows a script keyed to these calls; live
    // signals need none of them.
    setPhase() { }
    setPlan() { }
    setParagraph() { }
    setGuide() { }

    async start() {
        if (this._deviceId) {
            // Host-supplied stream (camera picker). The host owns its lifecycle.
            this._hostStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    deviceId: { exact: this._deviceId },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 },
                },
            });
            this.sdk.useMediaStream(this._hostStream);
        }
        await this.sdk.start();
        return this._hostStream; // null when the SDK acquired the camera itself
    }

    async stop() {
        try { await this.sdk.stop(); } finally { this._releaseHostStream(); }
    }

    destroy() {
        try { this.sdk.destroy(); } catch { /* already destroyed */ }
        this._releaseHostStream();
    }

    _releaseHostStream() {
        if (this._hostStream) {
            for (const tr of this._hostStream.getTracks()) tr.stop();
            this._hostStream = null;
        }
    }
}

/** Human-readable explanation for SDK error codes we expect people to hit. */
function explainError(code, message) {
    const name = ERROR_NAMES[code] ?? String(code);
    const tips = {
        kAuthenticationFailed: 'The API key was rejected. Check it in Settings (copy it again from physiology.presagetech.com).',
        kCreditExhausted: 'Your Presage plan has no measurement credits left. Use simulated signals, or ask on the Presage Discord.',
        kNetworkError: 'The SDK could not reach Presage to verify your key. Check your internet connection.',
        kServerError: 'Presage\'s server returned an error. Try again in a minute.',
        kMetricNotAuthorized: 'Your key is not enabled for one of the requested signals. Turn off "Pulse rate", "Blinks" or "Speech detection" in Settings and try again.',
        kConfigurationFailed: 'The SDK rejected the requested signals. In Settings, try the "full metric bundles" switch, or turn off "Blinks" / "Speech detection".',
        kInputUnavailable: 'The camera could not be opened. Close other apps that use the camera, or pick another camera.',
        kSustainedLowFrameRate: 'The camera frame rate stayed too low. More light on your face usually fixes this.',
    };
    return { name, text: tips[name] ?? message ?? 'Unknown error' };
}

module.exports = { LiveSource, requestedMetricsFor, explainError };
