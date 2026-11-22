// preload.js — bundled by esbuild into dist/preload.js.
//
// Electron sandboxed preloads cannot require packages from node_modules at
// runtime, so we bundle the SmartSpectra preload bridge (which exposes
// `window.__smartspectraBridge`, see @smartspectra/node-sdk/preload) together
// with the small `window.breathmarks` API this app uses for consent, key
// storage and saving the report the reader chooses to share.

'use strict';

require('@smartspectra/node-sdk/preload');

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('breathmarks', {
    getConfig: () => ipcRenderer.invoke('rp:get-config'),
    getApiKey: () => ipcRenderer.invoke('rp:get-api-key'),
    saveApiKey: (key) => ipcRenderer.invoke('rp:save-api-key', key),
    clearApiKey: () => ipcRenderer.invoke('rp:clear-api-key'),
    setCameraConsent: (value) => ipcRenderer.invoke('rp:set-camera-consent', value === true),
    exportFile: (defaultName, content) => ipcRenderer.invoke('rp:export', { defaultName, content }),
});
