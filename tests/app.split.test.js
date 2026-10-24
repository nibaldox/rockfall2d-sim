'use strict';

/**
 * Test de la división de js/app.js en mixins (T0.9).
 *
 * Garantiza que la división no cambia el conjunto de métodos de
 * SimRocas.App.prototype y que cada bloque vive en su archivo:
 *   - js/app-stl.js:    setupStlControls, _buildContours
 *   - js/app-worker.js: runSimulationWithWorker, _workerRockShapeVertices,
 *                       _renderWorkerFrame
 * Ambos mixins son Object.assign(SimRocas.App.prototype, {...}) y se cargan
 * después de js/app.js en index.html.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScripts } = require('./helpers/load');

const STL_METHODS = ['setupStlControls', '_buildContours'];
const WORKER_METHODS = ['runSimulationWithWorker', '_workerRockShapeVertices', '_renderWorkerFrame'];
// T3.4/T3.6: métodos de los nuevos mixins (añadidos a App.prototype, no sacados
// de app.js; por eso no ilegalan el conjunto del árbol pre-refactor).
const MODES_METHODS = ['setupModeControls', '_coerceDisplayMode', 'setDisplayMode'];
const IMPORT_METHODS = ['setup3dImportControls', '_start3dImport', '_cancel3dImport'];
// T4.6: métodos del mixin de simulación 3D (js/app-sim3d.js) — añadidos a
// App.prototype, nada se mudó fuera de app.js.
const SIM3D_METHODS = [
    'setupSim3dControls',
    // zonas de liberación (+ ganchos de automatización)
    'sim3dStartZone', 'sim3dStartPointMode', 'sim3dAddZoneLocal',
    'sim3dAddPointLocal', 'sim3dFinishZone', 'sim3dCancelZone',
    'sim3dDeleteZone', 'sim3dClearZones',
    // corrida con el pool de workers
    'sim3dRun', 'sim3dCancelRun',
    // privados de apoyo
    '_sim3dOnContainerClick', '_sim3dSyncZones', '_sim3dUpdateZonesList',
    '_sim3dZoneOptions', '_sim3dCollectParams', '_sim3dShowProgress',
    '_sim3dUpdateProgress', '_sim3dShowResults', '_sim3dShowTracks',
    '_sim3dApplyMap', '_sim3dDownloadText', '_sim3dExportAsc',
    '_sim3dExportCsv', '_syncReleaseAfterProfile', '_sim3dStatus',
    '_sim3dError',
];
const MOVED_METHODS = [...STL_METHODS, ...WORKER_METHODS];

// Lista literal capturada del árbol pre-refactor (T0.9), en el orden de
// definición de class App. El refactor no debe alterar este conjunto.
const EXPECTED = [
    'constructor', 'init', 'setupTabs', 'setupSubTabs', 'showResultsTab',
    'setupSidebarResize', 'loadTheme', 'setupThemeToggle',
    'setupTerrainControls', 'setupSegmentEditor', 'updateSegmentsList',
    'setupParameterControls', 'updateMultiReleaseList',
    'setupSimulationControls', 'setupTimelineControls', 'activateTimeline',
    'hideTimeline', 'playTimeline', 'pauseTimeline', '_timelineStep',
    'renderTimelineFrame', 'setupToolbarControls', 'setupToolbarRight',
    'updateZoomInfo', 'setupExportControls', 'setupKeyboardShortcuts',
    'setupBarrierControls', 'setupDashboardControls',
    'showResultsDashboard', 'hideResultsDashboard', 'exportDashboardPNG',
    'updateBarrierList', 'setupCanvasInteraction', 'setupResize',
    'generateRandomTerrain', 'loadDefaultTerrain', 'updateReleasePoint',
    'updateTerrainInfo', 'getSimulationParams', 'runSimulation',
    'runSimulationWithWorker', '_workerRockShapeVertices',
    '_renderWorkerFrame', 'animate', '_animateChunked', 'stopSimulation',
    'resetSimulation', '_buildContours', 'setupStlControls', 'render',
    '_doRender',
    // T3.4/T3.6: métodos añadidos por los mixins js/app-modes.js y
    // js/app-import.js (nada se mudó fuera de app.js; sólo se agregan).
    'setupModeControls', '_coerceDisplayMode', 'setDisplayMode', '_activateTab',
    '_enterMode3d', 'get3dViewer',
    'setup3dImportControls', '_start3dImport', '_cancel3dImport',
    '_finish3dImport', '_localBoundsFromDisplay', '_value3d', '_parse3dCellSize','_show3dProgress',
    '_update3dProgress', '_hide3dImportPanels', '_render3dInfo',
    '_render3dWarnings', '_apply3dColorMode', '_show3dErrorState',
    '_clear3dError', '_show3dError',
    // T3.5/T3.7: trazado de perfil 3D + vista en planta (js/app-profile3d.js).
    'setupProfile3dControls', 'profile3dStartDrawing', 'profile3dAddLocalPoint',
    'profile3dUndoVertex', 'profile3dCancelProfile', 'profile3dFinish',
    'profile3dSendTo2d', 'profile3dClearSection', 'togglePlanView',
    '_contoursWanted', '_renderContours', '_updateProfile3dPanel',
    '_syncProfile3dOverlay', '_profile3dUpdateInfo', '_showProfile3dStatus',
    '_profile3dOnContainerClick',
    // T4.6: simulación 3D (js/app-sim3d.js).
    ...SIM3D_METHODS
];

const APP_SCRIPTS = [
    'js/terrain.js', 'js/stl.js', 'js/physics.js', 'js/simulation.js',
    'js/renderer.js', 'js/stats.js', 'js/app.js'
];
const APP_STL = 'js/app-stl.js';
const APP_WORKER = 'js/app-worker.js';
const APP_MODES = 'js/app-modes.js';
const APP_IMPORT = 'js/app-import.js';
const APP_PROFILE3D = 'js/app-profile3d.js';
const APP_SIM3D = 'js/app-sim3d.js';

// Stub mínimo: al cargarse, js/app.js sólo usa document.addEventListener
// (registro de DOMContentLoaded). El constructor no corre en el test.
const DOM_STUB = { document: { addEventListener() {}, getElementById() { return null; } } };

function exists(rel) {
    return fs.existsSync(path.join(__dirname, '..', rel));
}

// Orden de index.html: base + mixins cuando existan.
function scriptOrder(withMixins) {
    const files = [...APP_SCRIPTS];
    if (withMixins) {
        for (const f of [APP_STL, APP_WORKER, APP_MODES, APP_IMPORT, APP_PROFILE3D, APP_SIM3D]) {
            if (exists(f)) files.push(f);
        }
    }
    return files;
}

function load(withMixins) {
    return loadScripts(scriptOrder(withMixins), { env: 'browser', extra: DOM_STUB });
}

test('T0.9: SimRocas.App.prototype conserva exactamente el conjunto de métodos del árbol pre-refactor', () => {
    const ctx = load(true);
    assert.ok(ctx.SimRocas && ctx.SimRocas.App, 'SimRocas.App debe existir');
    const actual = new Set(Object.getOwnPropertyNames(ctx.SimRocas.App.prototype));
    const expected = new Set(EXPECTED);
    const missing = [...expected].filter(m => !actual.has(m));
    const extra = [...actual].filter(m => !expected.has(m));
    assert.deepEqual(missing, [], 'métodos que desaparecieron');
    assert.deepEqual(extra, [], 'métodos nuevos inesperados');
});

test('T0.9: los métodos de importación STL provienen de js/app-stl.js, no de js/app.js', () => {
    const ctx = load(false);
    const proto = ctx.SimRocas.App.prototype;
    const present = STL_METHODS.filter(m => typeof proto[m] === 'function');
    assert.deepEqual(present, [],
        'T0.9 (RED antes del refactor): setupStlControls/_buildContours deben salir de js/app.js y vivir en js/app-stl.js');
});

test('T0.9: los métodos de ejecución con Worker provienen de js/app-worker.js, no de js/app.js', () => {
    const ctx = load(false);
    const proto = ctx.SimRocas.App.prototype;
    const present = WORKER_METHODS.filter(m => typeof proto[m] === 'function');
    assert.deepEqual(present, [],
        'T0.9 (RED antes del refactor): los métodos del worker deben salir de js/app.js y vivir en js/app-worker.js');
});

test('T0.9: cargado el orden completo, todos los métodos movidos están presentes', () => {
    const ctx = load(true);
    const proto = ctx.SimRocas.App.prototype;
    const missing = MOVED_METHODS.filter(m => typeof proto[m] !== 'function');
    assert.deepEqual(missing, [], 'los mixins deben instalar todos los métodos movidos');
});

test('T3.4/T3.6: cargado el orden completo, los mixins nuevos instalan sus métodos', () => {
    const ctx = load(true);
    const proto = ctx.SimRocas.App.prototype;
    const missing = [...MODES_METHODS, ...IMPORT_METHODS].filter(m => typeof proto[m] !== 'function');
    assert.deepEqual(missing, [], 'app-modes.js y app-import.js deben instalar sus métodos');
});

test('T3.6: js/app-import.js expone la versión del worker en SimRocas.IMPORT_WORKER_VERSION', () => {
    const ctx = load(true);
    // Valor de cache-busting: debe ser un entero positivo (sube con cada cambio del worker).
    assert.ok(Number.isInteger(ctx.SimRocas.IMPORT_WORKER_VERSION) && ctx.SimRocas.IMPORT_WORKER_VERSION >= 1);
});

/* -------------------------------------------------------------- T4.6: sim 3D */

test('T4.6: js/app-sim3d.js expone la versión del worker de simulación 3D', () => {
    const ctx = load(true);
    assert.ok(Number.isInteger(ctx.SimRocas.SIM3D_WORKER_VERSION) && ctx.SimRocas.SIM3D_WORKER_VERSION >= 1);
});

test('T4.6: SetupSim3d (release placement) coloca la liberación sobre el terreno', () => {
    const ctx = load(true);
    const RP = ctx.SimRocas.ReleasePlacement;
    assert.ok(RP && typeof RP.fromProfile === 'function');
    // Perfil 2D descendente: {x, y} con elevación en y.
    const points = [{ x: 0, y: 59 }, { x: 50, y: 40 }, { x: 100, y: 0 }];
    const heightAt = (x) => 59 - 0.2 * x;
    // Caída libre: x = x0 + 2 % de la longitud, y = cota del terreno + 5 m.
    const fall = RP.fromProfile(points, 'freefall', heightAt);
    assert.equal(fall.x, 2); // 0 + 0.02 * 100
    assert.ok(Number.isFinite(fall.terrainY) && Math.abs(fall.terrainY - 58.6) < 1e-9);
    assert.ok(fall.y > fall.terrainY + 4.9, 'liberación muy arriba del terreno: ' + fall.y);
    // Desprendimiento: apoyada en el terreno (y = cota).
    const det = RP.fromProfile(points, 'detachment', heightAt);
    assert.equal(det.x, 2);
    assert.equal(det.y, det.terrainY);
    // Terreno sin dato (NaN): se usa la cota del extremo del perfil (0 m) como
    // fallback → y = 0 + 5 en caída libre (nunca por DEBAJO).
    const noData = RP.fromProfile(points, 'freefall', () => NaN);
    assert.equal(noData.y, 5);
    assert.ok(noData.y > 0);
});
