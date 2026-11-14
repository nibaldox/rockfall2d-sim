'use strict';
// P1.3 (paquete C): sección «Colectores», invalidación y bloqueo, transporte
// congelado a motor, Worker y Stats, validación de crossings, dibujo, tabla de
// envolventes, CSV de cruces, versionado e I-A. results.collectors es un DOBLE
// con la forma del §4 del contrato; el motor y Stats reales son de A y B.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// El harness (fixture, make, runWorker, hooks) es el de P1.1, con la base 9232d1fe.
const BASE = '9232d1fe';
const p11 = path.join(__dirname, 'p11.app.test.js');
const harness = fs.readFileSync(p11, 'utf8').split('const otherTerrain')[0].replace("'1fc23718'", `'${BASE}'`);
assert.ok(harness.includes(`const BASE = '${BASE}'`));
const { test, make, hooks, show, read, runWorker } = new Function('require', '__dirname',
    harness + '\nreturn { test, make, hooks, show, read, runWorker };')(createRequire(p11), __dirname);

const plain = v => JSON.parse(JSON.stringify(v));
const BLOCKED = 'Edición de colectores bloqueada durante la corrida; detén la simulación para editar';
const env = (n, p50, p95, p99) => ({ p50, p95, p99, n, insufficient: { p95: n < 20, p99: n < 100 } });
const counts = (released, roots) => ({ crossingsTotal: 31, piecesCrossing: 19, rootsCrossing: roots, released, restBeforeLine: 4,
    censoredWithoutCrossing: { culled: 1, maxTime: 2, maxSteps: 0 }, byCorrection: 3, upward: 5, dropped: 0 });
// Doble de results.collectors (§4). El primero trae números en los percentiles
// insuficientes a propósito: la tabla no debe mostrarlos (I-D).
const DEFINITION = 'Percentil tipo 7 de Hyndman–Fan (interpolación lineal)';
const RESULT_COLLECTORS = [
    { id: 'c1', label: 'Pie <1>', x: 100, sample: 'first-downhill-per-piece', n: 19,
        envelopes: { height: env(19, 1.5, 77.77, 88.88), top: env(19, 2, 77.77, 88.88), speed: env(19, 8.25, 77.77, 88.88), energy: env(19, 12.5, 77.77, 88.88) },
        counts: counts(30, 17), definition: DEFINITION },
    { id: 'c2', label: 'Camino', x: 300, sample: 'first-any-per-piece', n: 150,
        envelopes: { height: env(150, 0.5, 3.25, 4.75), top: env(150, 1, 3.75, 5.25), speed: env(150, 6, 14.5, 18.25), energy: env(150, 20, 95.5, 130.25) },
        counts: counts(200, 140), definition: DEFINITION }
];
function withCollectorStats(f, collectors = RESULT_COLLECTORS) {
    f.app.stats.compute = function (rocks, releasePoint, info) {
        this.calls++; this.info = info;
        this.results = { status: 'completo', population: { rest: 1, sources: [0], directionResolved: true }, reachBounds: null, warnings: [] };
        if (info && info.collectors && info.collectors.length) this.results.collectors = plain(collectors);
    };
}
function setup(options) {
    const f = make(options);
    f.app.setupBarrierControls();
    f.api = f.global.SimRocas.Collectors;
    f.add = (x, label = '') => {
        f.element('collector-x').value = x; f.element('collector-label').value = label;
        f.element('btn-add-collector').click();
    };
    return f;
}
function finish(f, worker, mutate) {
    if (worker) {
        const done = runWorker(plain(f.workers[0].message)).find(m => m.type === 'complete');
        if (mutate) mutate(done.rocks);
        f.workers[0].onmessage({ data: done });
    } else {
        let guard = 0;
        while (f.app.simulation.isRunning && guard++ < 200000) f.app.simulation.step();
    }
}

test('index.html: sección «Colectores» en Barreras con <label>, tabla de envolventes, botón de cruces y versionado P1.3', () => {
    const html = read('index.html');
    const section = /^ {20}<div class="section" id="collectors-section">\n[\s\S]*?id="collector-list"[^\n]*\n {20}<\/div>\n/m.exec(html);
    assert.ok(section);
    assert.ok(html.indexOf('id="tab-barriers"') < section.index && section.index < html.indexOf('id="tab-parameters"'));
    assert.ok(html.indexOf('id="barrier-list"') < section.index);
    assert.ok(section[0].includes('<h3>Colectores</h3>'));
    assert.ok(section[0].includes('<label for="collector-x">X del colector (m):</label>'));
    assert.ok(section[0].includes('<label for="collector-label">Nombre:</label>'));
    assert.match(section[0], /<button id="btn-add-collector"[^>]*>Agregar<\/button>/);
    for (const id of ['collector-x', 'collector-label', 'btn-add-collector', 'collector-list', 'collector-envelopes-block',
        'collector-envelopes-table', 'btn-export-crossings']) assert.equal(html.split(`id="${id}"`).length, 2, id);
    assert.doesNotMatch(section[0], /#[0-9a-fA-F]{3,6}\b|rgb\(/);
    assert.ok(html.indexOf('id="bench-retention-table"') < html.indexOf('id="collector-envelopes-block"'));
    assert.ok(html.includes('Envolventes por colector'));
    assert.match(html, /<button id="btn-export-crossings"[^>]* disabled[^>]*>Exportar cruces \(CSV\)<\/button>/);
    const versions = source => Object.fromEntries([...source.matchAll(/<script src="(js\/[\w.-]+\.js)\?v=(\d+)"/g)].map(m => [m[1], Number(m[2])]));
    assert.deepEqual(versions(html), { ...versions(show('index.html')), 'js/physics.js': 15, 'js/simulation.js': 14, 'js/stats.js': 13,
        'js/app.js': 21, 'js/renderer.js': 8, 'js/app-worker.js': 12 });
    assert.match(read('js/app-worker.js'), /^const WORKER_VERSION = 13;$/m);
    // CP13b: css/style.css cambió frente a la base, así que su ?v= debe subir de 2 a 3 (caché de GitHub Pages).
    assert.notEqual(read('css/style.css'), show('css/style.css'));
    assert.ok(show('index.html').includes('<link rel="stylesheet" href="css/style.css?v=2">'));
    assert.ok(html.includes('<link rel="stylesheet" href="css/style.css?v=3">'));
    assert.equal(html.match(/css\/style\.css\?v=/g).length, 1);
});

test('Agregar: X dentro del perfil y sin duplicados; agrega, lista e invalida. Si no cumple, alert y nada cambia', () => {
    const f = setup();
    f.app._resultsValid = true;
    f.add('100', 'Pie');
    assert.deepEqual(hooks.alerts, []);
    assert.deepEqual(plain(f.app.collectors), [{ id: 'c1', x: 100, label: 'Pie' }]);
    assert.equal(f.app._resultsValid, false, 'agregar invalida');
    assert.match(f.element('collector-list').innerHTML, /X = 100\.00 m[\s\S]*Pie[\s\S]*data-remove-collector="c1"[\s\S]*Quitar/);
    f.add('300,5');
    assert.deepEqual(plain(f.app.collectors[1]), { id: 'c2', x: 300.5, label: 'Colector 2' });
    f.add('0', 'borde'); f.add('450', 'borde 2');
    assert.equal(f.app.collectors.length, 4, 'los extremos del perfil se admiten');
    const before = JSON.stringify(f.app.collectors);
    const listBefore = f.element('collector-list').innerHTML;
    for (const [x, label] of [['', 'a'], ['abc', 'a'], ['-0.01', 'a'], ['450.01', 'a'], ['Infinity', 'a'], ['100', 'otro'], ['200', 'Pie']]) {
        hooks.alerts.length = 0;
        f.app._resultsValid = true;
        f.add(x, label);
        assert.equal(hooks.alerts.length, 1, `alert con X=«${x}» y nombre «${label}»`);
        assert.equal(JSON.stringify(f.app.collectors), before);
        assert.equal(f.element('collector-list').innerHTML, listBefore);
        assert.equal(f.app._resultsValid, true, 'un rechazo no invalida');
    }
    // El nombre se escapa al listar.
    hooks.alerts.length = 0;
    f.add('50', '<b>x</b>');
    assert.ok(f.element('collector-list').innerHTML.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(!f.element('collector-list').innerHTML.includes('<b>x</b>'));
});

test('Quitar: elimina por id, invalida y no reutiliza ids', () => {
    const f = setup();
    f.add('100', 'A'); f.add('200', 'B');
    f.app._resultsValid = true;
    f.api.remove(f.app, 'c1');
    assert.deepEqual(plain(f.app.collectors), [{ id: 'c2', x: 200, label: 'B' }]);
    assert.equal(f.app._resultsValid, false);
    assert.ok(!f.element('collector-list').innerHTML.includes('data-remove-collector="c1"'));
    f.add('100', 'A');
    assert.equal(f.app.collectors[1].id, 'c3');
    f.api.remove(f.app, 'c2'); f.api.remove(f.app, 'c3');
    assert.match(f.element('collector-list').innerHTML, /Sin colectores/);
});

for (const flag of ['isRunning', '_workerActive']) {
    test(`I-E: agregar y quitar quedan bloqueados durante la corrida (${flag})`, () => {
        const f = setup();
        f.add('100', 'A');
        f.app._resultsValid = true;
        if (flag === 'isRunning') f.app.simulation.isRunning = true; else f.app._workerActive = true;
        const before = f.app.collectors;
        const list = f.element('collector-list').innerHTML;
        f.add('200', 'B');
        assert.equal(f.element('simulation-status').textContent, BLOCKED);
        f.element('simulation-status').textContent = '';
        f.api.remove(f.app, 'c1');
        assert.equal(f.element('simulation-status').textContent, BLOCKED);
        assert.equal(f.app.collectors, before);
        assert.deepEqual(plain(f.app.collectors), [{ id: 'c1', x: 100, label: 'A' }]);
        assert.equal(f.element('collector-list').innerHTML, list);
        assert.equal(f.app._resultsValid, true);
        assert.deepEqual(hooks.alerts, []);
    });
}

for (const worker of [false, true]) {
    const mode = worker ? 'Worker' : 'hilo';
    test(`transporte (${mode}): copia profunda en _runInfo, configure${worker ? ', mensaje start' : ''} y stats.compute; tabla y botón de cruces`, () => {
        const f = setup({ worker });
        withCollectorStats(f);
        f.add('100', 'Pie <1>'); f.add('300', 'Camino');
        const expected = [{ id: 'c1', x: 100, label: 'Pie <1>' }, { id: 'c2', x: 300, label: 'Camino' }];
        const configured = [];
        const configure = f.app.simulation.configure;
        f.app.simulation.configure = function (params) { configured.push(params); return configure.call(this, { ...params, collectors: undefined }); };
        f.element('sim-seed').value = '20261113';
        f.app.runSimulation();
        assert.deepEqual(hooks.alerts, []);
        assert.equal(configured.length, 1);
        assert.deepEqual(plain(configured[0].collectors), expected);
        assert.deepEqual(plain(f.app._runInfo.collectors), expected);
        assert.deepEqual(Object.keys(f.app._runInfo.collectors[0]), ['id', 'x', 'label']);
        const copies = [f.app._runInfo.collectors, configured[0].collectors];
        if (worker) {
            const message = f.workers[0].message;
            assert.deepEqual(plain(message.collectors), expected);
            assert.ok(Array.isArray(message.barriers), 'al mismo nivel que barriers');
            assert.equal(Object.hasOwn(message.simParams, 'collectors'), false);
            copies.push(message.collectors);
        }
        for (const a of copies) {
            assert.notEqual(a, f.app.collectors);
            assert.notEqual(a[0], f.app.collectors[0]);
            for (const b of copies) if (a !== b) { assert.notEqual(a[0], b[0]); }
        }
        // Copia congelada: mutar la lista viva después de iniciar no la toca.
        f.app.collectors[0].x = 999; f.app.collectors.pop();
        assert.deepEqual(plain(f.app._runInfo.collectors), expected);
        finish(f, worker);
        assert.equal(f.app.stats.calls, 1);
        const info = f.app.stats.info;
        assert.deepEqual(plain(info.collectors), expected);
        assert.notEqual(info.collectors, f.app._runInfo.collectors);
        assert.notEqual(info.collectors[0], f.app._runInfo.collectors[0]);
        // Tabla «Envolventes por colector» (I-D).
        const table = f.element('collector-envelopes-table').innerHTML;
        assert.notEqual(f.element('collector-envelopes-block').style.display, 'none');
        assert.ok(table.includes('Pie &lt;1&gt;') && !table.includes('Pie <1>'));
        assert.ok(table.includes('<td>Altura del centro (m)</td><td>1.50</td><td>insuficiente (n = 19)</td><td>insuficiente (n = 19)</td><td>19</td>'));
        assert.ok(table.includes('<td>Energía (kJ)</td><td>12.50</td><td>insuficiente (n = 19)</td><td>insuficiente (n = 19)</td><td>19</td>'));
        assert.ok(!table.includes('77.77') && !table.includes('88.88'), 'un percentil insuficiente nunca muestra número');
        assert.ok(table.includes('<td>Altura del tope (m)</td><td>1.00</td><td>3.75</td><td>5.25</td><td>150</td>'));
        assert.ok(table.includes('<td>Velocidad (m/s)</td><td>6.00</td><td>14.50</td><td>18.25</td><td>150</td>'));
        assert.ok(table.includes('raíces que cruzan: 17 de 30 lanzadas'));
        assert.ok(table.includes('en reposo antes de la línea: 4'));
        assert.ok(table.includes('censuradas sin cruce: 3 (salida del dominio: 1; tiempo máximo: 2; pasos máximos: 0)'));
        assert.ok(table.includes('primer cruce en sentido de bajada de cada pieza'));
        assert.ok(table.includes('primer cruce en cualquier sentido de cada pieza (sentido de bajada no resuelto)'));
        assert.ok(table.includes(DEFINITION));
        // Botón «Exportar cruces (CSV)».
        let exports = 0;
        f.app.stats.generateCrossingsCSV = () => { exports++; return 'Colector,X colector\n'; };
        assert.equal(f.element('btn-export-crossings').disabled, false);
        f.element('btn-export-crossings').click();
        assert.equal(exports, 1);
        assert.equal(f.element('created').download, 'simrocas_cruces.csv');
        f.app.stats.generateCrossingsCSV = () => { exports++; return null; };
        f.element('created').download = '';
        f.element('btn-export-crossings').click();
        assert.equal(f.element('created').download, '', 'null no descarga');
        // Invalidación: limpia la tabla y bloquea el botón.
        f.app._invalidateResults();
        assert.equal(f.element('collector-envelopes-table').innerHTML, '');
        assert.equal(f.element('collector-envelopes-block').style.display, 'none');
        assert.equal(f.element('btn-export-crossings').disabled, true);
        f.element('btn-export-crossings').click();
        assert.equal(exports, 2, 'sin resultados válidos no exporta');
    });
}

test('I-D: n = 0 y envolvente ausente dicen «insuficiente (n = …)»; sin results.collectors el bloque queda oculto y el botón bloqueado', () => {
    const f = setup({ worker: true });
    const empty = plain(RESULT_COLLECTORS[0]);
    empty.n = 0;
    for (const key of ['height', 'top', 'speed']) empty.envelopes[key] = { p50: null, p95: null, p99: null, n: 0, insufficient: { p95: true, p99: true } };
    delete empty.envelopes.energy;
    withCollectorStats(f, [empty]);
    f.add('100', 'A');
    f.app.runSimulation();
    finish(f, true);
    const table = f.element('collector-envelopes-table').innerHTML;
    assert.ok(table.includes('<td>Velocidad (m/s)</td><td>insuficiente (n = 0)</td><td>insuficiente (n = 0)</td><td>insuficiente (n = 0)</td><td>0</td>'));
    assert.ok(table.includes('<td>Energía (kJ)</td><td>insuficiente (n = 0)</td>'));
    assert.doesNotMatch(table, /NaN|undefined|null/);
    const g = setup({ worker: true });
    g.app.runSimulation();
    finish(g, true);
    assert.equal(g.app.stats.calls, 1);
    assert.equal(g.element('collector-envelopes-block').style.display, 'none');
    assert.equal(g.element('collector-envelopes-table').innerHTML, '');
    assert.equal(g.element('btn-export-crossings').disabled, true);
    const lists = read('js/app.js').match(/\['btn-export-csv', 'btn-export-report'[^\]]*\]/g);
    assert.ok(lists[0].includes("'btn-export-crossings'"), '_invalidateResults lo bloquea');
});

const crossing = (collector, extra = {}) => ({ collector, x: 100, y: 60, t: 1.5, height: 2, top: 2.25, vx: 5, vy: -3, speed: Math.hypot(5, 3),
    omega: 1, energyTrans: 100, energyRot: 10, energy: 110, mass: 50, direction: 1, ordinal: 1, byCorrection: false, ...extra });
test('isCompatibleResultRock: crossings finitos y de un colector de la corrida se publican; corruptos no', () => {
    const run = mutate => {
        const f = setup({ worker: true });
        withCollectorStats(f);
        f.add('100', 'A');
        f.app.runSimulation();
        finish(f, true, mutate);
        return f;
    };
    const ok = run(rocks => { rocks[0].crossings = [crossing('c1'), crossing('c1', { ordinal: 2, direction: -1, byCorrection: true })]; rocks[0].crossingsDropped = 0; });
    assert.equal(ok.app.stats.calls, 1);
    assert.equal(ok.app._resultsValid, true);
    const bad = {
        'y NaN': r => { r.crossings = [crossing('c1', { y: NaN })]; },
        'energía infinita': r => { r.crossings = [crossing('c1', { energy: Infinity })]; },
        'velocidad ausente': r => { r.crossings = [crossing('c1')]; delete r.crossings[0].speed; },
        't negativo': r => { r.crossings = [crossing('c1', { t: -1 })]; },
        'colector ajeno': r => { r.crossings = [crossing('zz')]; },
        'no es lista': r => { r.crossings = { length: 0 }; },
        'cruce nulo': r => { r.crossings = [null]; },
        'ordinal no entero': r => { r.crossings = [crossing('c1', { ordinal: 1.5 })]; },
        // I12 (arbitraje): direction es 1 o -1 exactos.
        'direction 0': r => { r.crossings = [crossing('c1', { direction: 0 })]; },
        'direction 2': r => { r.crossings = [crossing('c1', { direction: 2 })]; },
        'direction cadena': r => { r.crossings = [crossing('c1', { direction: '1' })]; },
        'direction ausente': r => { r.crossings = [crossing('c1')]; delete r.crossings[0].direction; },
        'byCorrection no booleano': r => { r.crossings = [crossing('c1', { byCorrection: 'no' })]; },
        'más de 64': r => { r.crossings = Array.from({ length: 65 }, () => crossing('c1')); },
        'crossingsDropped negativo': r => { r.crossings = []; r.crossingsDropped = -1; },
        'crossingsDropped NaN': r => { r.crossingsDropped = NaN; }
    };
    for (const [name, mutate] of Object.entries(bad)) {
        const f = run(rocks => mutate(rocks[0]));
        assert.equal(f.app.stats.calls, 0, name);
        assert.equal(f.app._resultsValid, false, name);
        assert.match(f.element('simulation-status').textContent, /protocolo incompatible/, name);
        assert.equal(f.element('btn-export-crossings').disabled, true, name);
    }
});

test('al iniciar, un colector fuera del perfil vigente da alert y la corrida no arranca', () => {
    const f = setup({ worker: true });
    f.add('400', 'A');
    f.app.terrain.setPoints([{ x: 0, y: 50 }, { x: 30, y: 20 }, { x: 90, y: 0 }]);
    const epoch = f.app._runEpoch;
    f.app.runSimulation();
    assert.equal(hooks.alerts.length, 1);
    assert.match(hooks.alerts[0], /fuera del perfil/);
    assert.equal(f.workers.length, 0);
    assert.equal(f.app._runEpoch, epoch);
});

test('renderer: cada colector es una línea vertical punteada con su rótulo y render() la dibuja', () => {
    const { loadScripts } = require('./helpers/load');
    const ctx = loadScripts(['js/renderer.js'], { extra: { SimRocas: {}, document: { documentElement: {}, getElementById: () => null },
        getComputedStyle: () => ({ getPropertyValue: () => '' }) } });
    const log = [];
    const drawing = new Proxy({}, {
        get: (target, key) => (key in target ? target[key] : (...args) => { log.push([key, ...args]); return { width: 10 }; }),
        set: (target, key, value) => { target[key] = value; log.push(['set:' + String(key), value]); return true; }
    });
    const canvas = { width: 800, height: 600, getContext: () => drawing, addEventListener() {}, style: {},
        parentElement: { clientWidth: 800, clientHeight: 630, querySelector: () => null } };
    const terrain = { scale: 2, offsetX: 10, offsetY: 20, points: [{ x: 0, y: 100 }, { x: 100, y: 0 }], getHeightAt: () => 0 };
    const renderer = new ctx.SimRocas.Renderer(canvas, terrain);
    assert.deepEqual(plain(renderer.collectors), []);
    log.length = 0;
    renderer.drawCollectors([]);
    assert.deepEqual(log, []);
    renderer.drawCollectors([{ id: 'c1', x: 40, label: 'Pie' }, { id: 'c2', x: 70, label: 'Camino' }]);
    const dashes = log.filter(e => e[0] === 'setLineDash');
    assert.ok(dashes.some(e => e[1].length >= 2), 'línea punteada');
    assert.deepEqual(plain(dashes[dashes.length - 1][1]), [], 'el punteado se restaura');
    const moves = log.filter(e => e[0] === 'moveTo'), lines = log.filter(e => e[0] === 'lineTo');
    assert.deepEqual(moves.map(e => e[1]), [90, 150]);
    assert.deepEqual(lines.map(e => e[1]), [90, 150], 'vertical: misma X de canvas');
    assert.ok(moves.every((e, i) => e[2] !== lines[i][2]));
    assert.deepEqual(log.filter(e => e[0] === 'fillText').map(e => e[1]), ['Pie', 'Camino']);
    const source = read('js/renderer.js');
    assert.match(source, /this\.drawBarriers\(this\.barriers\);\n\s+this\.drawCollectors\(this\.collectors\);/);
    assert.match(read('js/app.js'), /this\.renderer\.collectors = /);
});

// --- I-A: sin colectores, _runInfo, configure, el mensaje y compute son los de 9232d1fe salvo X5 ---
function runBare(worker, base) {
    const f = make({ worker, base });
    f.app.setupBarrierControls();
    const configured = [];
    const configure = f.app.simulation.configure;
    f.app.simulation.configure = function (params) { configured.push(JSON.stringify(params)); return configure.call(this, params); };
    f.element('sim-seed').value = '20261113';
    f.app.runSimulation();
    const x5 = base ? 12 : 13;
    assert.equal(f.app._runInfo.engineVersion, x5, 'X5');
    f.app._runInfo.engineVersion = 'X5';
    const out = { configured, runInfoKeys: Object.keys(f.app._runInfo), runInfo: JSON.stringify(f.app._runInfo) };
    if (worker) { out.messageKeys = Object.keys(f.workers[0].message); out.message = JSON.stringify(f.workers[0].message); }
    finish(f, worker);
    assert.deepEqual(hooks.alerts, []);
    assert.equal(f.app.stats.calls, 1);
    out.infoKeys = Object.keys(f.app.stats.info);
    out.info = JSON.stringify(f.app.stats.info);
    out.status = f.element('simulation-status').textContent;
    return out;
}
test('I-A: sin colectores, _runInfo, la configuración, el mensaje al Worker y los argumentos de compute coinciden con 9232d1fe (salvo X5)', () => {
    for (const worker of [false, true]) {
        const now = runBare(worker, false);
        const base = runBare(worker, true);
        assert.deepEqual(now, base, worker ? 'Worker' : 'hilo');
        assert.equal(now.runInfoKeys.includes('collectors'), false);
        assert.equal(now.infoKeys.includes('collectors'), false);
        assert.equal(now.configured[0].includes('collectors'), false);
        if (worker) assert.equal(now.messageKeys.includes('collectors'), false);
    }
});

test('T0.9 y barreras: App.prototype no gana métodos y los manejadores de barreras no cambian', () => {
    const names = source => [...source.matchAll(/^ {4}(?:async )?([A-Za-z_]\w*)\([^)]*\) \{$/gm)].map(m => m[1]).sort();
    assert.deepEqual(names(read('js/app.js')), names(show('js/app.js')));
    const barrierAdd = source => /document\.getElementById\('btn-add-barrier'\)[\s\S]*?document\.getElementById\('btn-clear-barriers'\)[\s\S]*?\n {8}\}\);\n/.exec(source)[0];
    assert.equal(barrierAdd(read('js/app.js')), barrierAdd(show('js/app.js')));
    const list = source => /\n {4}updateBarrierList\(\) \{[\s\S]*?\n {4}\}\n/.exec(source)[0];
    assert.equal(list(read('js/app.js')), list(show('js/app.js')));
    assert.equal(typeof vm.runInNewContext, 'function');
});
