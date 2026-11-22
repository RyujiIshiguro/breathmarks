// Drives the real Electron app in SIMULATED mode and saves PNG screenshots to
// docs/screenshots/. No camera and no API key are used.
//   xvfb-run -a npm run screenshots      (headless Linux)
//   npm run screenshots                  (desktop)

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });

let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright'); }
const electronPath = require('electron');
const SPEED = 8;

const app = await playwright._electron.launch({
    executablePath: electronPath,
    args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), root, `--sim-speed=${SPEED}`],
    cwd: root,
    env: { ...process.env, SMARTSPECTRA_API_KEY: '' },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE ERROR:', m.text()); });
const W = 1440;
const H = 900;
await page.setViewportSize({ width: W, height: H }).catch(() => {});
await page.waitForSelector('#btn-paste');
await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
await page.evaluate(() => window.__bm.setPreviewMode('blur'));
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name, opts = {}) => { await page.screenshot({ path: path.join(out, name), ...opts }); console.log('saved', name); };
const simT = () => page.evaluate(() => {
    const S = window.__bm.S;
    return S.source && S.store.originUs != null ? (S.source.nowUs() - S.store.originUs) / 1e6 : 0;
});
const waitSim = async (target) => { while ((await simT()) < target) await wait(60); };

async function readThrough({ dwell, shots = {}, key = 'ArrowRight' }) {
    const n = await page.evaluate(() => window.__bm.S.manuscript.paragraphs.length);
    for (let i = 0; i < n; i++) {
        const t0 = await simT();
        const d = dwell(i);
        if (shots[i]) {
            await waitSim(t0 + shots[i].at);
            await shots[i].fn();
        }
        await waitSim(t0 + d);
        if (i < n - 1) await page.keyboard.press(key);
    }
}

// 1. Home
await shot('01-home.png');

// 2. Consent for the English sample
await page.click('[data-sample="ferry"]');
await page.waitForSelector('body[data-screen="consent"]');
await page.check('#consent-check');
await wait(200);
await shot('02-consent.png');

// 3. Calm reference
await page.click('#btn-sim');
await page.waitForSelector('body[data-screen="baseline"]');
await page.waitForFunction(() => !document.querySelector('#btn-start-read').disabled, null, { timeout: 60000 });
await wait(300);
await shot('03-baseline.png');

// 4. Reading. Dwell follows word count; paragraphs 2–4 are read quickly.
await page.click('#btn-start-read');
await page.waitForSelector('body[data-screen="read"]');
const words = await page.evaluate(() => window.__bm.S.manuscript.paragraphs.map((p) => p.units));
await readThrough({
    dwell: (i) => {
        const base = Math.max(7, (words[i] / 210) * 60);
        return [1, 2, 3].includes(i) ? base * 0.45 : [5, 8, 11].includes(i) ? base * 1.3 + 6 : base;
    },
    shots: {
        5: { at: 6, fn: () => shot('04-reading.png') },
        7: { at: 6.5, fn: () => shot('05-reading-looked-away.png', { clip: { x: W - 420, y: H - 120, width: 420, height: 120 } }) },
    },
});
await page.keyboard.press('ArrowRight');   // past the last paragraph = finish
await page.waitForSelector('body[data-screen="review"]');
await wait(500);
await shot('06-review.png');

// 5. Keep one note private, show the manuscript margin
await page.click('#review-ms [data-toggle="3"]').catch(() => {});
await wait(200);
await page.evaluate(() => document.querySelector('#review-ms .mp[data-i="4"]').scrollIntoView({ block: 'start' }));
await wait(200);
await shot('07-review-margin.png');
await page.evaluate(() => window.scrollTo(0, 0));

// 6. Share dialog
await page.click('#btn-share');
await page.fill('#share-name', 'Aya');
await wait(200);
await shot('08-share.png');

// 7. Writer's view (preview), with one paragraph flagged for revision
await page.click('#btn-preview-writer');
await page.waitForSelector('body[data-screen="writer"]');
await page.click('#writer-ms [data-revise="2"]');
await wait(200);
await shot('09-writer.png');

// 8. Japanese, vertical (the author's short story)
await page.click('#nav-home');
await page.waitForSelector('body[data-screen="home"]');
await page.click('[data-sample="earphones"]');
await page.check('#consent-check');
await page.click('#btn-sim');
await page.waitForFunction(() => !document.querySelector('#btn-start-read').disabled, null, { timeout: 60000 });
await page.click('#btn-start-read');
await page.waitForSelector('body[data-screen="read"]');
const units = await page.evaluate(() => window.__bm.S.manuscript.paragraphs.map((p) => p.units));
await readThrough({
    key: 'ArrowLeft',
    dwell: (i) => Math.max(9, (units[i] / 420) * 60) * ([3, 5].includes(i) ? 1.5 : 1) + ([3, 5].includes(i) ? 7 : 0),
    shots: { 3: { at: 5, fn: () => shot('10-vertical-reading.png') } },
});
await page.keyboard.press('ArrowLeft');
await page.waitForSelector('body[data-screen="review"]');
await wait(500);
await page.evaluate(() => document.querySelector('#review-ms').scrollIntoView({ block: 'start' }));
await wait(200);
await shot('11-vertical-review.png');
await page.click('button[data-notes="ja"]');
await wait(300);
await page.evaluate(() => document.querySelector('#review-ms').scrollIntoView({ block: 'start' }));
await wait(200);
await shot('12-vertical-review-ja-notes.png');

await app.close();
