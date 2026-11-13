'use strict';

const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Debe ejecutarse antes de que app esté ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const APP_ORIGIN = 'app://simrocas';
const isSmoke = process.argv.includes('--smoke');

// Raíz web: en empaquetado un directorio con copia de la app; en dev, la raíz del repo.
const webRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app-web')
  : path.resolve(__dirname, '..');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.stl': 'application/octet-stream',
  '.map': 'application/json'
};

// Lista blanca de prefijos servibles: solo index.html y assets bajo esos dirs.
function resolveWebPath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\\')) return null;
  if (p.includes('\0')) return null;

  let clean = p.replace(/\\/g, '/');
  while (clean.startsWith('/')) clean = clean.slice(1);

  const normalized = path.posix.normalize(clean);
  if (normalized.startsWith('/') || normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    return null; // traversal / ruta absoluta
  }

  const ok =
    normalized === 'index.html' ||
    normalized.startsWith('css/') ||
    normalized.startsWith('js/') ||
    normalized.startsWith('vendor/');

  if (!ok) return null;
  const abs = path.join(webRoot, normalized);
  if (!abs.startsWith(webRoot + path.sep) && abs !== path.join(webRoot, 'index.html')) return null;
  return abs;
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== 'simrocas') {
        return new Response('Not found', { status: 404 });
      }
      let urlPath = u.pathname;
      if (urlPath === '/' || urlPath === '') urlPath = 'index.html';
      const ext = path.extname(urlPath).toLowerCase();
      if (!ext) return new Response('Not found', { status: 404 });

      const file = resolveWebPath(urlPath);
      if (!file) {
        return new Response('Forbidden', { status: 403 });
      }

      const headers = new Headers({
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream'
      });

      return net.fetch(pathToFileURL(file).toString(), { headers }).then((resp) => {
        if (!resp.ok) {
          return new Response('Not found', { status: 404, headers });
        }
        return new Response(resp.body, { status: 200, headers });
      });
    } catch (err) {
      console.error('[simrocas] app protocol error:', request.url, err);
      return new Response('Internal error', { status: 500 });
    }
  });
}

function smokeWaitFor(expr, timeoutMs, pollMs = 100) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const val = await win.webContents.executeJavaScript(expr, true);
        if (val) return resolve(val);
      } catch { /* renderer aún inicializando */ }
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !isSmoke,
    useContentSize: true,
    title: 'SimRocas',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(APP_ORIGIN + '/index.html');
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(isSmoke ? null : Menu.buildFromTemplate([]));
    registerAppProtocol();
    createWindow();

    const consoleErrors = [];
    const loadFailures = [];

    if (isSmoke) {
      win.webContents.on('console-message', (e) => {
        if (e.level && e.level.toLowerCase() === 'error') {
          consoleErrors.push(String(e.message || ''));
        }
      });
      win.webContents.on('did-fail-load', (e, code, desc, url) => {
        loadFailures.push({ code, desc, url });
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    if (!isSmoke) return;

    // ---- MODO SMOKE ----
    (async () => {
      const result = { ok: false, checks: {}, details: {} };
      try {
        await (await win.loadURLPromise || Promise.resolve());
      } catch { /* loadURL de arriba no devolvió promesa guardada; ignorado */ }

      // Esperar fin de carga.
      await new Promise((resolve) => {
        if (win.webContents.isLoading()) {
          win.webContents.once('did-finish-load', resolve);
          setTimeout(resolve, 20000);
        } else resolve();
      });

      const loaded = await smokeWaitFor('!!(window.app && window.app.terrain)', 20000, 200);
      result.checks.appLoaded = !!loaded;
      if (!loaded) {
        let diag = null;
        try {
          diag = await win.webContents.executeJavaScript(`(() => ({
            href: location.href,
            ready: document.readyState,
            hasSimRocas: typeof window.SimRocas,
            typeofApp: typeof window.app,
            scripts: [...document.scripts].map(s => s.src || 'inline')
          }))()`, true);
        } catch (err) { diag = 'diag failed: ' + err.message; }
        result.details.diag = diag;
        result.details.loadFailures = loadFailures;
        result.details.consoleErrors = consoleErrors;
        console.log(JSON.stringify(result, null, 2));
        app.exit(1);
        return;
      }

      const info = await win.webContents.executeJavaScript(`(() => ({
        title: document.title,
        crossOriginIsolated: self.crossOriginIsolated,
        sabType: typeof SharedArrayBuffer,
        hostPlatform: window.simrocasHost && window.simrocasHost.platform,
        hostIsDesktop: !!(window.simrocasHost && window.simrocasHost.isDesktop)
      }))()`, true);
      result.details.info = info;

      const traversal = await win.webContents.executeJavaScript(`(async () => {
        const t1 = fetch('app://simrocas/../package.json').then(r => r.status).catch(err => 'neterr:' + err.message);
        const t2 = fetch('app://simrocas/desktop/main.js').then(r => r.status).catch(err => 'neterr:' + err.message);
        return { traversal: await t1, mainjs: await t2 };
      })()`, true);
      result.details.traversal = traversal;

      const worker = await win.webContents.executeJavaScript(`new Promise(r => {
        let w;
        try { w = new Worker('js/worker.js?v=2'); }
        catch (err) { r('error:' + err.message); return; }
        w.onerror = e => r('error:' + (e.message || 'worker error'));
        setTimeout(() => { w.terminate(); r('ok'); }, 1500);
      })`, true);
      result.details.worker = worker;

      // Simulación corta en modo normal (no worker): 10 rocas.
      const simDone = await win.webContents.executeJavaScript(`(async () => {
        const input = document.getElementById('num-rocks');
        input.value = '10';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btn-run').click();
        const start = Date.now();
        while (Date.now() - start < 60000) {
          const status = (document.getElementById('simulation-status')||{}).textContent || '';
          if (status.includes('Completado')) return { done: true, status };
          await new Promise(r => setTimeout(r, 250));
        }
        return { done: false, status: (document.getElementById('simulation-status')||{}).textContent };
      })()`, true);
      result.details.simulation = simDone;

      result.checks.titleOk = info.title === 'SimRocas' || /SimRocas/.test(info.title);
      result.checks.crossOriginIsolated = info.crossOriginIsolated === true;
      result.checks.workerOk = worker === 'ok';
      result.checks.simulationCompleted = !!(simDone && simDone.done);
      result.checks.traversalBlocked =
        traversal && [traversal.traversal, traversal.mainjs].every(s => s === 403 || s === 404);

      result.ok =
        result.checks.appLoaded &&
        result.checks.titleOk &&
        result.checks.crossOriginIsolated &&
        result.checks.workerOk &&
        result.checks.simulationCompleted &&
        result.checks.traversalBlocked;
      result.details.consoleErrors = consoleErrors;
      result.details.loadFailures = loadFailures;
      result.details.versions = { electron: process.versions.electron };

      console.log('SMOKE_RESULT:' + JSON.stringify(result));
      app.exit(result.ok ? 0 : 1);
    })();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
