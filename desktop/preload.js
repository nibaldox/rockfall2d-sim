// Puente mínimo seguro: solo API limitada de Electron, sin Node expuesto.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('simrocasHost', {
  platform: process.platform,
  isDesktop: true,
  versions: {
    electron: process.versions.electron
  }
});
