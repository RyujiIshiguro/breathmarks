'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decodeMetrics, Metrics } = require('@smartspectra/node-sdk/messages');
const { SignalStore } = require('../src/core/signals');
const { SimulatedSource, defaultPlan } = require('../src/sim/simulator');
const R = require('../src/core/reading');
const { requestedMetricsFor } = require('../src/live/liveSource');

const T0 = 1_800_000_000_000_000;

function simulateRead({ n = 12, dwell = 20, plan } = {}) {
    const src = new SimulatedSource({ encode: (o) => Metrics.encode(Metrics.fromObject(o)).finish() });
    const st = new SignalStore();
    const validation = [];
    src.on('metrics', (b) => st.ingest(decodeMetrics(b)));
    src.on('validationStatus', (code, ts) => validation.push({ t: (Number(ts) - T0) / 1e6, code }));
    src._startEpochUs = T0;
    st.reset(T0);
    const step = (s) => { for (let i = 0; i < s * 10; i++) src._tick(0.1); };
    const text = Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}. ` + 'word '.repeat(60)).join('\n\n');
    const manuscript = R.parseManuscript(text, { title: 'Test' });
    src.setPlan(plan || defaultPlan(n));
    src.setPhase('baseline');
    const phases = { baselineStart: 2, baselineEnd: null, readStart: null, readEnd: null };
    step(40);
    phases.baselineEnd = src._tau;
    phases.readStart = src._tau;
    src.setPhase('read');
    const visits = [];
    for (let i = 0; i < n; i++) {
        const start = src._tau;
        src.setParagraph(i);
        step(dwell);
        visits.push({ i, start, end: src._tau });
    }
    phases.readEnd = src._tau;
    st.finalize();
    return { source: 'simulated', manuscript, phases, visits, validation, signals: st.toJSON() };
}

test('manuscript parsing: title, paragraphs, Gutenberg header, Japanese', () => {
    const en = R.parseManuscript('THE NIGHT FERRY\n\nFirst para line one\nline two.\n\nSecond para.');
    assert.strictEqual(en.title, 'THE NIGHT FERRY');
    assert.strictEqual(en.paragraphs.length, 2);
    assert.strictEqual(en.paragraphs[0].text, 'First para line one line two.');
    const pg = R.parseManuscript('junk\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nTitle\n\nBody text here.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nlicense');
    assert.strictEqual(pg.title, 'Title');
    assert.deepStrictEqual(pg.paragraphs.map((p) => p.text), ['Body text here.']);
    const ja = R.parseManuscript('題\n\n　これは一行目の文です。段落の区切りを確かめます。\n　これは二行目の文です。字下げで段落が分かれます。');
    assert.strictEqual(ja.lang, 'ja');
    assert.strictEqual(ja.title, '題');
    assert.strictEqual(ja.paragraphs.length, 2);
});

test('the author\'s Japanese sample is split only at sentence ends and otherwise unaltered', () => {
    const { samples } = require('../src/samples');
    const s = samples.find((x) => x.id === 'earphones');
    const ms = R.parseManuscript(s.text);
    assert.strictEqual(ms.title, 'イヤホンと電車');
    assert.strictEqual(ms.lang, 'ja');
    assert.strictEqual(ms.paragraphs.length, 6);
    for (const p of ms.paragraphs) assert.match(p.text, /．$/);
    const body = s.text.split('\n').slice(1).join('');
    assert.strictEqual(ms.paragraphs.map((p) => p.text).join(''), body);
    assert.ok(body.startsWith('『扉が閉まりまーす』') && body.endsWith('『君の行動は，』ーー僕の唇は動かない．'));
});

test('Japanese margin notes are available alongside English ones', () => {
    const s = simulateRead({ plan: { beats: [2], away: -1 } });
    const a = R.analyzeReading(s);
    const hold = a.paragraphs[2].marks.find((m) => m.kind === 'hold');
    assert.match(hold.textJa, /^息が止まった（約\d+秒）$/);
    const rep = R.buildReport(s, a, new Set(), { noteLang: 'ja' });
    assert.strictEqual(rep.noteLang, 'ja');
    assert.match(R.reportToMarkdown(rep), /息が止まった/);
    assert.match(R.summaryLines(rep, 'ja')[0], /^息が止まった：¶3/);
});

test('requested metrics: minimal by default, bundles on request', () => {
    assert.deepStrictEqual(requestedMetricsFor({}).sort((a, b) => a - b), [0, 1, 2, 12, 13, 15]);
    const b = requestedMetricsFor({ bundles: true });
    assert.ok(b.includes(14) && b.includes(16));
});

test('baseline: calm pulse, breathing rhythm and blink rate are recovered', () => {
    const s = simulateRead();
    const base = R.computeBaseline(s);
    assert.ok(Math.abs(base.pulse - 72) < 3, `pulse ${base.pulse}`);
    assert.ok(Math.abs(base.traceRate - 14) < 1.5, `trace rate ${base.traceRate}`);
    assert.ok(base.blinkRate > 8 && base.blinkRate < 25, `blinks ${base.blinkRate}`);
});

test('held breath, pulse and away marks land on the scripted paragraphs only', () => {
    const plan = { beats: [4, 8], away: 6, skim: [] };
    const s = simulateRead({ plan });
    const a = R.analyzeReading(s);
    const holdParas = a.paragraphs.filter((p) => p.marks.some((m) => m.kind === 'hold')).map((p) => p.i);
    assert.deepStrictEqual(holdParas, [4, 8]);
    for (const i of [4, 8]) {
        const p = a.paragraphs[i];
        const hold = p.marks.find((m) => m.kind === 'hold');
        assert.match(hold.text, /no breath for ~\d+ s/);
        assert.ok(p.holds[0].dur > 4 && p.holds[0].dur < 10, `hold ${p.holds[0].dur}`);
        assert.ok(p.marks.some((m) => m.kind === 'pulse-up'), `pulse mark on ${i}`);
        assert.ok(p.marks.some((m) => m.kind === 'blink-low'), `blink mark on ${i}`);
    }
    assert.ok(a.paragraphs[6].marks.some((m) => m.kind === 'away'));
    assert.ok(a.paragraphs[1].steady, 'calm paragraph is steady');
    assert.strictEqual(a.summary.held.length, 2);
    assert.ok(a.summary.flats.length >= 1);
    // wording stays descriptive
    for (const p of a.paragraphs) for (const m of p.marks) assert.doesNotMatch(m.text, /stress|anx|fear|emotion|excit|bored/i);
});

test('reader control: removed paragraphs are withheld and raw data never leaves', () => {
    const s = simulateRead({ plan: { beats: [3], away: -1 } });
    const a = R.analyzeReading(s);
    const rep = R.buildReport(s, a, new Set([3]));
    assert.strictEqual(rep.paragraphs[3].withheld, true);
    assert.strictEqual(rep.paragraphs[3].marks.length, 0);
    assert.strictEqual(rep.summary.held.length, 0);
    const json = JSON.stringify(rep);
    assert.doesNotMatch(json, /breathTrace|pulseRate|"t":/);
    const md = R.reportToMarkdown(rep);
    assert.match(md, /SIMULATED/);
    assert.match(md, /no note shared/);
    const html = R.reportToHTML(rep);
    assert.match(html, /<!doctype html>/);
    assert.doesNotMatch(html, /<script/i);
});
