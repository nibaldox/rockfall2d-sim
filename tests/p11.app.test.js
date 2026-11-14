'use strict';
// P1.1 (paquete B): control «Generar banco–berma», invalidación 6c en las 15
// vías de mutación del perfil, bloqueo durante la corrida, versionado e I-A.
// SimRocas.BenchProfile es un DOBLE que cumple el §2 del contrato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { ROOT, loadScripts, createContext, runScript } = require('./helpers/load');

const BASE = '1fc23718';
const show = file => execFileSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 });
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const hooks = { alerts: [], docListeners: {}, clipboard: '', base: false };
globalThis.__p11 = hooks;
hooks.FileReader = class { readAsText(file) { this.onload({ target: { result: file.text } }); } };
hooks.navigator = { clipboard: { readText() { return { then(fn) { fn(hooks.clipboard); return { catch() {} }; } }; } } };
// Carga del árbol de trabajo o, con hooks.base, de la base 1fc23718 (I-A).
hooks.load = (files, options) => {
    if (!hooks.base) return loadScripts(files, options);
    const context = createContext(options);
    for (const file of files) vm.runInContext(show(file), context, { filename: `${BASE}:${file}` });
    return context;
};
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0]
    .replace("loadScripts(['js/stats.js'", "globalThis.__p11.load(['js/stats.js'")
    .replace('postMessage() {}', 'postMessage(message) { this.message = message; }')
    .replace('alert() {}', 'alert(m) { globalThis.__p11.alerts.push(String(m)); }')
    .replace('getElementById: element, addEventListener() {}',
        'getElementById: element, activeElement: { tagName: \'BODY\' }, addEventListener(type, fn) { globalThis.__p11.docListeners[type] = fn; }')
    .replace('Blob: class {}', 'Blob: class {}, addEventListener() {}, FileReader: globalThis.__p11.FileReader, navigator: globalThis.__p11.navigator');
const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), __dirname);
const parity = path.join(__dirname, 'worker.parity.test.js');
const workerSource = fs.readFileSync(parity, 'utf8').split('// --- Paridad (protocolo')[0];
const { runWorker } = new Function('require', '__dirname', workerSource + '\nreturn { runWorker };')(createRequire(parity), __dirname);

const PROFILE = [{ x: 0, y: 120 }, { x: 40, y: 100 }, { x: 80, y: 70 }, { x: 120, y: 45 },
    { x: 160, y: 25 }, { x: 200, y: 15 }, { x: 260, y: 10 }, { x: 350, y: 8 }, { x: 450, y: 8 }];
const OTHER = [{ x: 0, y: 50 }, { x: 30, y: 20 }, { x: 90, y: 0 }];

// Doble de SimRocas.BenchProfile (§2): descenso hacia +X, bancos desde arriba.
function benchDouble() {
    return {
        calls: [],
        generate(p) {
            this.calls.push(p);
            const { benches: n, benchHeight: h, faceAngleDeg: a, bermWidth: w, baseElevation: z0 } = p;
            if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, error: 'benches debe ser un entero entre 1 y 50' };
            if (!(h > 0) || !(a > 0 && a < 90) || !(w >= 0) || !Number.isFinite(z0)) return { ok: false, error: 'parámetros inválidos' };
            const top = p.topPlatform === undefined ? 20 : p.topPlatform;
            const floor = p.floorLength === undefined ? 30 : p.floorLength;
            const b = h / Math.tan(a * Math.PI / 180);
            const points = [], roles = [], benchMeta = [];
            let x = p.startX === undefined ? 0 : p.startX, y = z0 + n * h;
            const push = (px, py, role) => {
                const last = points[points.length - 1];
                if (last && Math.abs(last.x - px) < 1e-9) return;
                if (last) roles.push(role);
                points.push({ x: px, y: py });
            };
            push(x, y);
            x += top; push(x, y, 'platform');
            for (let i = 1; i <= n; i++) {
                const meta = { index: i, crestX: x, crestY: y, height: h, faceAngleDeg: a, nominalWidth: w, effectiveWidth: w };
                x += b; y -= h; push(x, y, 'face');
                Object.assign(meta, { toeX: x, toeY: y, bermStartX: x, bermEndX: x + w });
                benchMeta.push(meta);
                if (i < n) { x += w; push(x, y, 'berm'); }
            }
            x += floor; push(x, y, 'floor');
            return { ok: true, points, roles, benchMeta, params: { ...p }, schemaVersion: 'bench-profile.v1' };
        }
    };
}

function make({ worker = false, base = false } = {}) {
    hooks.base = base;
    hooks.docListeners = {};
    let f, ctx;
    try {
        const terrainCode = base ? show('js/terrain.js') : read('js/terrain.js');
        ctx = createContext({ env: 'browser' });
        vm.runInContext(terrainCode, ctx, { filename: 'js/terrain.js' });
        runScript(ctx, 'js/physics.js');
        runScript(ctx, 'js/simulation.js');
        f = fixture(worker);
    } finally { hooks.base = false; }
    f.global = f.app.runSimulation.constructor('return globalThis')();
    f.global.SimRocas.RNG_ALGORITHM = ctx.SimRocas.RNG_ALGORITHM;
    f.global.SimRocas.TerrainPresets = ctx.SimRocas.TerrainPresets;
    f.Terrain = ctx.SimRocas.Terrain;
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    const app = f.app;
    app.terrain = terrain;
    app.physics = new ctx.SimRocas.PhysicsEngine();
    app.simulation = new ctx.SimRocas.Simulation(terrain, app.physics);
    app.releasePoint = { x: 10, y: 130 };
    app.selectedPresetType = 'roca-suave';
    app.selectedSegmentIndex = -1;
    app.renderer.autoScale = () => { app.renderer.autoScaled = (app.renderer.autoScaled || 0) + 1; };
    app.updateTerrainInfo = () => {}; app.updateSegmentsList = () => {}; app.updateZoomInfo = () => {};
    app.canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
    app.canvas.width = 800; app.canvas.height = 600;
    terrain.canvas = app.canvas;
    f.element('tab-terrain').classList.add('active');
    f.element('num-rocks').value = '3';
    f.element('max-duration').value = '5';
    f.element('rock-shape').value = 'polygon';
    f.element('downhill-mode').value = 'auto';
    delete app.getSimulationParams;
    app.stats.compute = function (rocks, releasePoint, info) {
        this.calls++; this.info = info;
        this.results = { status: 'completo', population: { rest: 1, sources: [0], directionResolved: true }, reachBounds: null, warnings: [] };
    };
    app.setupTerrainControls(); app.setupSegmentEditor(); app.setupToolbarRight();
    app.setupKeyboardShortcuts(); app.setupCanvasInteraction();
    f.keydown = e => hooks.docListeners.keydown({ preventDefault() {}, ...e });
    if (!base) { f.bench = benchDouble(); f.global.SimRocas.BenchProfile = f.bench; }
    hooks.alerts.length = 0;
    return f;
}

function fillBench(f, values = {}) {
    const v = { 'bench-count': '3', 'bench-height': '10', 'bench-face-angle': '45', 'bench-berm-width': '6',
        'bench-base-elevation': '100', 'bench-top-platform': '20', 'bench-floor-length': '30', ...values };
    for (const [id, value] of Object.entries(v)) f.element(id).value = value;
}

const otherTerrain = f => { const t = new f.Terrain(); t.setPoints(OTHER.map(p => ({ ...p }))); return t; };
const mouse = { clientX: 300, clientY: 200, preventDefault() {} };
// Las 15 vías: 14 de M8 §3 (13 y 14 se cubren aparte, sobre app-profile3d.js y app-stl.js) más «Generar».
const WAYS = {
    '1 agregar punto': f => { f.element('input-x').value = '500'; f.element('input-y').value = '5'; f.element('btn-add-point').click(); },
    '2 limpiar perfil': f => f.element('btn-clear-terrain').click(),
    '3a importar JSON': f => f.element('file-input').listeners.change({ target: { files: [{ name: 'p.json', text: otherTerrain(f).toJSON() }] } }),
    '3b importar CSV': f => f.element('file-input').listeners.change({ target: { files: [{ name: 'p.csv', text: otherTerrain(f).toCSV() }] } }),
    '4 pegar coordenadas': f => { hooks.clipboard = '500\t5\n510\t4\n'; f.element('btn-paste-coords').click(); },
    '5 aplicar tipo a un rango': f => {
        f.app.selectedPresetType = 'concreto'; f.element('seg-from').value = '0'; f.element('seg-to').value = '1';
        f.element('btn-apply-preset').click();
    },
    '6 rugosidad del tramo': f => { f.app.selectedSegmentIndex = 0; f.element('segment-roughness').value = '20'; f.element('segment-roughness').listeners.input(); },
    '7 deshacer (botón)': f => f.element('tool-undo').click(),
    '8 deshacer (Ctrl+Z)': f => f.keydown({ ctrlKey: true, key: 'z' }),
    '9 aleatorio (botón)': f => f.element('tool-random').click(),
    '10 aleatorio (tecla T)': f => f.keydown({ key: 't' }),
    '11a clic en canvas agrega': f => f.app.canvas.listeners.click({ ...mouse }),
    '11b clic en canvas borra': f => { f.app.activeTool = 'tool-delete'; f.app.terrain.findNearestPoint = () => 2; f.app.canvas.listeners.click({ ...mouse }); },
    '12 clic derecho borra': f => { f.app.terrain.findNearestPoint = () => 2; f.app.canvas.listeners.contextmenu({ ...mouse }); },
    '15 generar banco–berma': f => { fillBench(f); f.element('btn-bench-generate').click(); }
};

function arm(f) {
    f.marker = { params: {}, benchMeta: [], pointsKey: 'x' };
    f.app._benchProfile = f.marker;
    f.app._resultsValid = true;
    f.app.stats.results = { old: true };
    f.app.renderer.probabilityPercentiles = { old: true };
    return f.app.terrain.toJSON();
}

for (const [name, act] of Object.entries(WAYS)) {
    test(`vía ${name}: invalida los resultados y anula _benchProfile`, () => {
        const f = make();
        const before = arm(f);
        act(f);
        assert.notEqual(f.app.terrain.toJSON(), before, 'el perfil debe cambiar');
        assert.equal(f.app._resultsValid, false);
        assert.equal(f.app.stats.results, null);
        assert.equal(f.app.renderer.probabilityPercentiles, null);
        if (name.startsWith('15')) assert.notEqual(f.app._benchProfile, f.marker);
        else assert.equal(f.app._benchProfile, null);
    });

    test(`vía ${name}: bloqueada durante una corrida, con aviso en el estado`, () => {
        const f = make();
        const before = arm(f);
        f.app.simulation.isRunning = true;
        f.element('simulation-status').textContent = 'Simulando...';
        act(f);
        assert.equal(f.app.terrain.toJSON(), before);
        assert.equal(f.app._benchProfile, f.marker);
        assert.equal(f.app._resultsValid, true);
        assert.deepEqual(f.app.stats.results, { old: true });
        assert.match(f.element('simulation-status').textContent, /bloquead/i);
        assert.equal(f.bench.calls.length, 0);
    });
}

test('vías 13 y 14 (DEM 3D y STL): guarda de bloqueo antes de setPoints e invalidación después', () => {
    for (const file of ['js/app-profile3d.js', 'js/app-stl.js']) {
        const source = read(file);
        const at = source.indexOf('this.terrain.setPoints(');
        assert.ok(at > 0, file);
        assert.equal(source.split('this.terrain.setPoints(').length, 2, file);
        const guard = source.lastIndexOf('if (SimRocas.ProfileEdit.blocked(this)) return;', at);
        assert.ok(guard > 0 && at - guard < 400, `${file}: guarda`);
        const after = source.slice(at, at + 200);
        assert.match(after, /this\.terrain\.setPoints\([^\n]*\);\s*\n\s*SimRocas\.ProfileEdit\.changed\(this\);/, `${file}: invalidación`);
    }
});

test('ProfileEdit.changed invalida y ProfileEdit.blocked avisa también con el Worker activo', () => {
    const f = make();
    arm(f);
    const edit = f.global.SimRocas.ProfileEdit;
    edit.changed(f.app);
    assert.equal(f.app._benchProfile, null);
    assert.equal(f.app.stats.results, null);
    assert.equal(edit.blocked(f.app), false);
    f.app._workerActive = true;
    assert.equal(edit.blocked(f.app), true);
    assert.match(f.element('simulation-status').textContent, /bloquead/i);
});

test('zoom y desplazamiento no invalidan ni anulan _benchProfile', () => {
    const f = make();
    arm(f);
    const points = JSON.stringify(f.app.terrain.points);
    f.element('tool-zoom-in').click();
    f.element('tool-zoom-out').click();
    f.app.canvas.listeners.wheel({ ...mouse, deltaY: -100 });
    f.app.terrain.setOffset(33, 44);
    assert.equal(JSON.stringify(f.app.terrain.points), points);
    assert.equal(f.app._benchProfile, f.marker);
    assert.equal(f.app._resultsValid, true);
    assert.deepEqual(f.app.stats.results, { old: true });
});

test('Generar: reemplaza el perfil por la API de Terrain, materiales por rol, fuente, +x, tabla y _benchProfile', () => {
    const f = make();
    const { app } = f;
    const calls = [];
    for (const name of ['setPoints', 'addPoint', 'applyPresetToRange', 'clear']) {
        const original = app.terrain[name];
        app.terrain[name] = function (...args) { calls.push(name); return original.apply(this, args); };
    }
    fillBench(f);
    f.element('btn-bench-generate').click();
    assert.deepEqual(hooks.alerts, []);
    assert.deepEqual(JSON.parse(JSON.stringify(f.bench.calls)), [{ benches: 3, benchHeight: 10, faceAngleDeg: 45, bermWidth: 6,
        baseElevation: 100, topPlatform: 20, floorLength: 30 }]);
    const expected = benchDouble().generate(f.bench.calls[0]);
    assert.ok(calls.includes('setPoints'));
    assert.deepEqual(JSON.parse(JSON.stringify(app.terrain.points)), expected.points);
    assert.equal(app.terrain.points.length, 8);
    for (let i = 1; i < app.terrain.points.length; i++) assert.ok(app.terrain.points[i].x > app.terrain.points[i - 1].x);
    // Correspondencia documentada: cara = roca-dura; berma y plataforma = relleno (grava); piso = suelo.
    const material = { face: 'roca-dura', berm: 'relleno', platform: 'relleno', floor: 'suelo' };
    const presets = f.global.SimRocas.TerrainPresets;
    assert.deepEqual(expected.roles, ['platform', 'face', 'berm', 'face', 'berm', 'face', 'floor']);
    app.terrain.segments.forEach((segment, i) => {
        const type = material[expected.roles[i]];
        assert.equal(segment.type, type, `tramo ${i}`);
        assert.equal(segment.cn, presets[type].cn);
        assert.equal(segment.ct, presets[type].ct);
        assert.equal(segment.roughness, presets[type].roughness);
    });
    // Fuente sobre la plataforma superior (x en [0, 20], cota de la plataforma 130).
    assert.ok(app.releasePoint.x >= 0 && app.releasePoint.x <= 20);
    assert.ok(app.releasePoint.y >= 130);
    assert.equal(f.element('release-x').value, app.releasePoint.x.toFixed(1));
    assert.equal(f.element('release-y').value, app.releasePoint.y.toFixed(1));
    assert.equal(app.renderer.autoScaled, 1);
    assert.equal(f.element('downhill-mode').value, '+x');
    assert.match(f.element('simulation-status').textContent, /\+X/);
    assert.deepEqual(JSON.parse(JSON.stringify(app._benchProfile)), { params: expected.params, benchMeta: expected.benchMeta,
        pointsKey: JSON.stringify(expected.points) });
    assert.deepEqual(Object.keys(app._benchProfile), ['params', 'benchMeta', 'pointsKey']);
    const table = f.element('bench-meta-table');
    for (const head of ['Banco', 'Cresta', 'Pata', 'Altura', 'Ángulo', 'Berma']) assert.ok(table.innerHTML.includes(head), head);
    assert.equal(table.innerHTML.split('<tr>').length - 1, 4);
    assert.notEqual(table.style.display, 'none');
    // Los metadatos no viajan en toJSON.
    assert.deepEqual(Object.keys(JSON.parse(app.terrain.toJSON())), ['points', 'segments', 'scale']);
    // Una edición posterior anula los metadatos y oculta la tabla.
    WAYS['1 agregar punto'](f);
    assert.equal(app._benchProfile, null);
    assert.equal(table.style.display, 'none');
});

test('Generar queda registrado para deshacer: el botón y Ctrl+Z restauran el perfil, la fuente y el sentido previos', () => {
    for (const undo of [f => f.element('tool-undo').click(), f => f.keydown({ ctrlKey: true, key: 'z' })]) {
        const f = make();
        f.app.terrain.applyPresetToRange('concreto', 1, 2);
        const before = f.app.terrain.toJSON();
        fillBench(f);
        f.element('btn-bench-generate').click();
        assert.notEqual(f.app.terrain.toJSON(), before);
        undo(f);
        assert.equal(f.app.terrain.toJSON(), before);
        assert.deepEqual({ ...f.app.releasePoint }, { x: 10, y: 130 });
        assert.equal(f.element('downhill-mode').value, 'auto');
        assert.equal(f.app._benchProfile, null);
        assert.equal(f.app._resultsValid, false);
        // Un segundo deshacer vuelve a la conducta previa: quita el último punto.
        undo(f);
        assert.equal(f.app.terrain.points.length, PROFILE.length - 1);
    }
});

test('un error del generador da alert y no cambia el perfil ni invalida (I-E)', () => {
    const cases = [
        f => fillBench(f, { 'bench-count': '0' }),
        f => fillBench(f, { 'bench-face-angle': '90' }),
        f => { fillBench(f); f.bench.generate = () => { throw new Error('fallo interno'); }; },
        f => { fillBench(f); f.bench.generate = () => ({ ok: true, points: [{ x: 0, y: 1 }, { x: 0, y: 0 }], roles: ['face'], benchMeta: [], params: {} }); },
        f => { fillBench(f); f.bench.generate = () => ({ ok: true, points: [{ x: 0, y: 1 }, { x: NaN, y: 0 }], roles: ['face'], benchMeta: [], params: {} }); },
        f => { fillBench(f); f.global.SimRocas.BenchProfile = undefined; }
    ];
    for (const prepare of cases) {
        const f = make();
        const before = arm(f);
        prepare(f);
        f.element('btn-bench-generate').click();
        assert.equal(hooks.alerts.length, 1);
        assert.match(hooks.alerts[0], /banco–berma/);
        assert.equal(f.app.terrain.toJSON(), before);
        assert.equal(f.app._benchProfile, f.marker);
        assert.equal(f.app._resultsValid, true);
        assert.deepEqual({ ...f.app.releasePoint }, { x: 10, y: 130 });
        assert.equal(f.element('downhill-mode').value, 'auto');
    }
});

// --- I-A: sin usar el generador, igual que 1fc23718 con la misma semilla ---
function print(rocks) {
    return JSON.stringify(rocks.map(r => [r.id, r.parentId, r.x, r.y, r.finalX, r.finalY, r.rotation, r.bounces,
        r.maxKineticEnergy, r.stepsTaken, r.color, r.shape, r.trajectory.length]));
}
function runSeeded(worker, base) {
    const f = make({ worker, base });
    f.element('sim-seed').value = '20261112';
    const out = { terrainJSON: f.app.terrain.toJSON() };
    f.app.runSimulation();
    assert.deepEqual(hooks.alerts, []);
    let rocks;
    if (worker) {
        const message = f.workers[0].message;
        out.message = JSON.stringify(message);
        const done = runWorker(JSON.parse(out.message)).find(m => m.type === 'complete');
        rocks = done.rocks;
        f.workers[0].onmessage({ data: done });
    } else {
        let guard = 0;
        while (f.app.simulation.isRunning && guard++ < 200000) f.app.simulation.step();
        rocks = f.app.simulation.rocks;
    }
    assert.ok(rocks.length >= 3);
    out.print = print(rocks);
    out.seed = f.app._runInfo.seed;
    out.segments = JSON.stringify(f.app._runInfo.segments);
    return out;
}

test('I-A: sin usar el generador, hilo y Worker con semilla coinciden con 1fc23718', () => {
    const results = {};
    for (const worker of [false, true]) {
        const now = runSeeded(worker, false);
        const base = runSeeded(worker, true);
        assert.deepEqual(now, base, worker ? 'Worker' : 'hilo');
        results[worker] = now;
    }
    assert.equal(results.false.print, results.true.print);
    assert.equal(results.false.terrainJSON, results.true.terrainJSON);
    assert.equal(JSON.parse(results.true.message).terrainJSON, results.true.terrainJSON);
});

// --- UI y versionado ---
test('index.html: grupo «Generar banco–berma» en la pestaña Perfil y versionado P1.1', () => {
    const html = read('index.html');
    const group = /<div class="control-group" id="bench-generator">[\s\S]*?id="bench-meta-table"[^\n]*\n\s*<\/div>\n/.exec(html);
    assert.ok(group);
    assert.ok(html.indexOf('id="btn-paste-coords"') < group.index && group.index < html.indexOf('id="file-input"'));
    for (const id of ['bench-count', 'bench-height', 'bench-face-angle', 'bench-berm-width', 'bench-base-elevation',
        'bench-top-platform', 'bench-floor-length', 'btn-bench-generate', 'bench-meta-table']) {
        assert.equal(html.split(`id="${id}"`).length, 2, id);
    }
    for (const label of ['Generar banco–berma', 'N.º de bancos', 'Altura de banco (m)', 'Ángulo de cara (°)',
        'Ancho de berma (m)', 'Cota base (m)', 'Plataforma superior (m)', 'Piso (m)', '>Generar<']) assert.ok(group[0].includes(label), label);
    assert.doesNotMatch(group[0], /#[0-9a-fA-F]{3,6}\b|rgb\(/);
    const scripts = [...html.matchAll(/<script src="(js\/[\w.-]+\.js)\?v=(\d+)"/g)].map(m => [m[1], Number(m[2])]);
    const order = scripts.map(s => s[0]);
    const versions = Object.fromEntries(scripts);
    assert.equal(order.indexOf('js/bench-profile.js'), order.indexOf('js/terrain.js') + 1);
    assert.ok(order.indexOf('js/bench-profile.js') < order.indexOf('js/app.js'));
    const before = Object.fromEntries([...show('index.html').matchAll(/<script src="(js\/[\w.-]+\.js)\?v=(\d+)"/g)].map(m => [m[1], Number(m[2])]));
    const changed = file => show(file) !== read(file);
    const expected = { ...before, 'js/bench-profile.js': 2, 'js/app.js': 21, 'js/terrain.js': 9, 'js/stats.js': 13, 'js/bench-retention.js': 1,
        'js/physics.js': 15, 'js/simulation.js': 14, 'js/renderer.js': 8 }; // P1.3: app 21, stats 13, physics 15, simulation 14 y renderer 8; // P1.2: bench-profile 2, app 20, stats 12 y bench-retention 1
    for (const [file, v] of [['js/app-stl.js', 3], ['js/app-profile3d.js', 3], ['js/app-worker.js', 12]]) if (changed(file)) expected[file] = v;
    assert.deepEqual(versions, expected);
    // worker.js carga terrain.js con el ?v= del Worker: WORKER_VERSION sube de 11 a 12.
    assert.match(read('js/worker.js'), /importScripts\('terrain\.js' \+ _v/);
    assert.match(show('js/app-worker.js'), /^const WORKER_VERSION = 11;$/m);
    assert.match(read('js/app-worker.js'), /^const WORKER_VERSION = 13;$/m); // P1.3 (X5)
    // P1.3: physics, simulation, renderer y worker cambian por los colectores; se preserva el invariante histórico de P1.1: 1fc23718 contra 841fe984 (commit de P1.1).
    for (const file of ['js/physics.js', 'js/simulation.js', 'js/renderer.js', 'js/worker.js']) assert.equal(show(file), execFileSync('git', ['show', `841fe984:${file}`], { cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 }), file);
    // P1.2: stats cambia; se preserva el invariante histórico de P1.1
    assert.equal(show('js/stats.js'), execFileSync('git', ['show', '841fe984:js/stats.js'], { cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 }), 'js/stats.js');
});
