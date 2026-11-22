// main.js — Electron main process for Breathmarks.
//
// Responsibilities
//   1. Create the window with the SmartSpectra preload bridge (bundled into
//      dist/preload.js together with our own small API) and bind the SDK's
//      IPC channel (`bindSmartSpectraIpc`), as in Presage's electron-quickstart.
//   2. Grant camera access ONLY after the user has given consent in the UI,
//      only for video (no microphone) and only to the bundled local page.
//   3. Store the API key encrypted with Electron safeStorage. Reading sessions
//      are never written to disk by the app; the only file it writes is the
//      report the reader chooses to save with "Share with the writer".
//      Nothing is sent anywhere by this file.

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session, ipcMain, safeStorage, dialog, shell } = require('electron');

const argv = process.argv.slice(1);
const FORCE_SIMULATED = argv.includes('--simulated');
const SIM_SPEED = Number((argv.find((a) => a.startsWith('--sim-speed=')) || '').split('=')[1]) || 1;

// Same packaged-build handling as the Presage sample: point the binding at the
// unpacked native runtime before requiring it.
if (app.isPackaged && !process.env.SMARTSPECTRA_CAPI_PATH) {
    const LIB = { darwin: 'libsmartspectra_capi.dylib', win32: 'smartspectra_capi.dll', linux: 'libsmartspectra_capi.so' }[process.platform];
    if (LIB) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
}

// The SDK is optional at runtime: if its native runtime cannot load (e.g. an
// unsupported platform) the app still runs in simulated mode.
let bindSmartSpectraIpc = null;
let sdkVersion = null;
let sdkLoadError = null;
try {
    ({ bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main'));
    sdkVersion = require('@smartspectra/node-sdk/package.json').version;
} catch (err) {
    sdkLoadError = String(err && err.message ? err.message : err);
    console.warn('[breathmarks] SmartSpectra SDK unavailable, simulated mode only:', sdkLoadError);
}

let cameraConsent = false;

const userDir = () => app.getPath('userData');
const keyFile = () => path.join(userDir(), 'api-key.bin');

function readSavedKey() {
    try {
        if (!fs.existsSync(keyFile()) || !safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(fs.readFileSync(keyFile()));
    } catch (err) {
        console.warn('[breathmarks] could not read saved key:', err.message);
        return null;
    }
}

function currentKey() {
    const env = (process.env.SMARTSPECTRA_API_KEY || '').trim();
    if (env) return { key: env, source: 'env' };
    const saved = readSavedKey();
    if (saved) return { key: saved, source: 'saved' };
    return { key: null, source: null };
}

function registerIpc() {
    ipcMain.handle('rp:get-config', () => {
        const { source } = currentKey();
        return {
            sdkAvailable: !!bindSmartSpectraIpc,
            sdkVersion,
            sdkLoadError,
            keySource: source,
            forceSimulated: FORCE_SIMULATED,
            simSpeed: SIM_SPEED,
            platform: process.platform,
            encryptionAvailable: safeStorage.isEncryptionAvailable(),
        };
    });

    // The renderer-side SDK takes the key in its constructor, so the key has
    // to reach the renderer. It is only handed out after camera consent.
    ipcMain.handle('rp:get-api-key', () => (cameraConsent ? currentKey().key : null));

    ipcMain.handle('rp:save-api-key', (_e, key) => {
        key = String(key || '').trim();
        if (!key) return { ok: false, error: 'Empty key' };
        if (!safeStorage.isEncryptionAvailable()) {
            return { ok: false, error: 'OS encryption is not available. Set the SMARTSPECTRA_API_KEY environment variable instead.' };
        }
        fs.mkdirSync(userDir(), { recursive: true });
        fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
        return { ok: true };
    });

    ipcMain.handle('rp:clear-api-key', () => {
        try { fs.rmSync(keyFile(), { force: true }); } catch { /* ignore */ }
        return { ok: true };
    });

    ipcMain.handle('rp:set-camera-consent', (_e, value) => {
        cameraConsent = value === true;
        return cameraConsent;
    });

    ipcMain.handle('rp:export', async (e, { defaultName, content }) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName });
        if (canceled || !filePath) return { ok: false };
        fs.writeFileSync(filePath, content);
        return { ok: true, filePath };
    });

}

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 980,
        minHeight: 680,
        backgroundColor: '#f4efe4',
        title: 'Breathmarks',
        webPreferences: {
            // dist/preload.js = @smartspectra/node-sdk/preload + our `window.breathmarks` API
            preload: path.join(__dirname, 'dist', 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    if (bindSmartSpectraIpc) bindSmartSpectraIpc(win);

    win.webContents.setWindowOpenHandler(({ url }) => {
        // Allow opening documentation links in the user's browser, nothing else.
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.loadFile(path.join(__dirname, 'index.html'));
    if (process.env.BREATHMARKS_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        const mediaTypes = (details && details.mediaTypes) || [];
        const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
        callback(cameraConsent && permission === 'media' && cameraOnly && url.startsWith('file://'));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
        if (permission === 'media') return cameraConsent && String(origin || '').startsWith('file://');
        return false;
    });

    registerIpc();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
