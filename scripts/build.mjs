// Bundles the renderer (browser) and the preload (sandboxed Electron preload).
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
    entryPoints: [path.join(root, 'src/renderer/app.js')],
    bundle: true,
    outfile: path.join(root, 'dist/renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    logLevel: 'warning',
});

await build({
    entryPoints: [path.join(root, 'src/preload.js')],
    bundle: true,
    outfile: path.join(root, 'dist/preload.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    target: 'node20',
    logLevel: 'warning',
});

console.log('built dist/renderer.js and dist/preload.js');
