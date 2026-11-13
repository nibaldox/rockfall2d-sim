'use strict';
// P1.2 (paquete C): «Medir bancos», transporte congelado de benchGeometry en
// runInfo (hilo y Worker), tabla «Retención por banco», CSV de destinos,
// versionado e I-A. SimRocas.BenchProfile.measure y results.benchRetention son
// DOBLES con las formas de los §3 y §7 del contrato.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// El harness (fixture, make, runWorker, hooks) es el de P1.1, con la base 841fe984.
const BASE = '841fe984';
const p11 = path.join(__dirname, 'p11.app.test.js');
const harness = fs.readFileSync(p11, 'utf8').split('const otherTerrain')[0].replace("'1fc23718'", `'${BASE}'`);
assert.ok(harness.includes(`const BASE = '${BASE}'`));
const { test, make, hooks, show, read, runWorker, PROFILE } = new Function('require', '__dirname',
    harness + '\nreturn { test, make, hooks, show, read, runWorker, PROFILE };')(createRequire(p11), __dirname);

const META = [
    { index: 1, crestX: 40, crestY: 100, toeX: 80, toeY: 70, height: 30, faceAngleDeg: 36.9, nominalWidth: 40, effectiveWidth: 0, bermStartX: 80, bermEndX: 80 },
    { index: 2, crestX: 120, crestY: 45, toeX: 160, toeY: 25, height: 20, faceAngleDeg: 26.6, nominalWidth: null, effectiveWidth: 40, bermStartX: 160, bermEndX: 200 }
];
function measureDouble(f, out) {
    const calls = [];
    f.bench.measure = (points, thresholds) => {
        calls.push({ points: JSON.parse(JSON.stringify(points)), thresholds: { ...thresholds } });
        return out || { ok: true, downhillSign: 1, benchMeta: META.map(b => ({ ...b })),
            thresholds: { ...thresholds }, schemaVersion: 'bench-measure.v2' };
    };
    return calls;
}
// Doble DERIVADO del módulo real (js/bench-retention.js) con hojas fijas: así la
// forma de `censored` ({ primaries, pieces, mass } por motivo y por límite) no diverge.
const leaf = (id, rootId, finalX, mass, stopReason = 'rest', cullBoundary = null) =>
    ({ id, rootId, finalX, stopReason, cullBoundary, releaseX: 5, mass });
const LEAVES = [
    leaf(0, 0, 20, 100), leaf(1, 1, 90, 100), leaf(2, 2, 100, 100.5), leaf(8, 2, 95, 50),
    leaf(3, 3, 200, 100), leaf(4, 4, 210, 100), leaf(5, 5, 220, 100),
    leaf(6, 6, 500, 30, 'culled', 'maxX'), leaf(9, 6, 500, 20, 'culled', 'maxX'), leaf(7, 7, 130, 30, 'maxTime')
];
const RETENTION = (() => {
    const context = require('node:vm').createContext({});
    require('node:vm').runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'bench-retention.js'), 'utf8'), context);
    const out = context.SimRocas.BenchRetention.summarize({
        primaries: LEAVES.filter(l => l.id === l.rootId).map(({ mass, rootId, ...primary }) => primary),
        leaves: LEAVES, discardedMass: 0, releasedMass: LEAVES.reduce((sum, l) => sum + l.mass, 0),
        geometry: { source: 'medido', schemaVersion: 'bench-measure.v2', downhillSign: 1, benchMeta: META,
            thresholds: null, profileMinX: 0, profileMaxX: 450 }
    });
    return JSON.parse(JSON.stringify(out));
})();
assert.equal(RETENTION.ok, true);
assert.deepEqual(RETENTION.censored.byReason.culled, { primaries: 1, pieces: 2, mass: 50 });
assert.deepEqual(RETENTION.censored.cullBoundary.maxX, { primaries: 1, pieces: 2, mass: 50 });
function withRetention(f, retention) {
    f.app.stats.compute = function (rocks, releasePoint, info) {
        this.calls++; this.info = info;
        this.results = { status: 'completo', population: { rest: 1, sources: [0], directionResolved: true }, reachBounds: null, warnings: [] };
        if (retention && info && info.benchGeometry) this.results.benchRetention = retention;
    };
}
function setThresholds(f, a = '5', b = '0.5', c = '1.0') {
    f.element('bench-measure-slope').value = a;
    f.element('bench-measure-tolerance').value = b;
    f.element('bench-measure-min-height').value = c;
}
function finish(f, worker) {
    if (worker) {
        const done = runWorker(JSON.parse(JSON.stringify(f.workers[0].message))).find(m => m.type === 'complete');
        f.workers[0].onmessage({ data: done });
    } else {
        let guard = 0;
        while (f.app.simulation.isRunning && guard++ < 200000) f.app.simulation.step();
    }
}
const plain = v => JSON.parse(JSON.stringify(v));

test('index.html: grupo «Medir bancos» con 3 umbrales y <label>, tabla de retención, botón de destinos y versionado P1.2', () => {
    const html = read('index.html');
    const group = /^ {24}<div class="control-group" id="bench-measure">\n[\s\S]*?\n {24}<\/div>\n/m.exec(html);
    assert.ok(group);
    assert.ok(html.indexOf('id="bench-meta-table"') < group.index && group.index < html.indexOf('id="file-input"'));
    for (const [id, value, label] of [['bench-measure-slope', '5', 'Pendiente máxima de berma (°):'],
        ['bench-measure-tolerance', '0.5', 'Tolerancia de cota de berma (m):'], ['bench-measure-min-height', '1.0', 'Altura mínima de cara (m):']]) {
        assert.equal(html.split(`id="${id}"`).length, 2, id);
        assert.ok(group[0].includes(`<label for="${id}">${label}</label>`), label);
        assert.match(group[0], new RegExp(`<input type="number" id="${id}"[^>]* value="${value.replace('.', '\\.')}"`));
    }
    assert.ok(group[0].includes('Medir bancos'));
    assert.ok(group[0].includes('criterio provisional; lo define el responsable geotécnico'));
    assert.equal(html.split('id="btn-bench-measure"').length, 2);
    assert.equal(html.split('id="bench-retention-table"').length, 2);
    assert.ok(html.includes('Retención por banco'));
    assert.match(html, /<button id="btn-export-destinations"[^>]* disabled[^>]*>Exportar destinos \(CSV\)<\/button>/);
    assert.doesNotMatch(group[0], /#[0-9a-fA-F]{3,6}\b|rgb\(/);
    const scripts = [...html.matchAll(/<script src="(js\/[\w.-]+\.js)\?v=(\d+)"/g)].map(m => [m[1], Number(m[2])]);
    const order = scripts.map(s => s[0]);
    assert.ok(order.indexOf('js/bench-retention.js') >= 0 && order.indexOf('js/bench-retention.js') < order.indexOf('js/stats.js'));
    const before = Object.fromEntries([...show('index.html').matchAll(/<script src="(js\/[\w.-]+\.js)\?v=(\d+)"/g)].map(m => [m[1], Number(m[2])]));
    assert.deepEqual(Object.fromEntries(scripts),
        { ...before, 'js/bench-retention.js': 1, 'js/bench-profile.js': 2, 'js/stats.js': 12, 'js/app.js': 20 });
    assert.match(read('js/app-worker.js'), /^const WORKER_VERSION = 12;$/m);
    for (const file of ['js/physics.js', 'js/simulation.js', 'js/worker.js', 'js/terrain.js', 'js/app-worker.js']) assert.equal(show(file), read(file), file);
});

test('Medir bancos: llama a measure con el perfil y los 3 umbrales y llena _benchProfile con source «medido»', () => {
    const f = make();
    const calls = measureDouble(f);
    setThresholds(f, '7', '0.25', '2');
    f.app._resultsValid = true;
    const pointsBefore = JSON.stringify(f.app.terrain.points);
    f.element('btn-bench-measure').click();
    assert.deepEqual(hooks.alerts, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].points.map(p => ({ x: p.x, y: p.y })), PROFILE);
    assert.deepEqual(calls[0].thresholds, { bermSlopeDeg: 7, bermToleranceY: 0.25, minFaceHeight: 2 });
    assert.deepEqual(plain(f.app._benchProfile), { source: 'medido', benchMeta: META, pointsKey: pointsBefore, downhillSign: 1,
        thresholds: { bermSlopeDeg: 7, bermToleranceY: 0.25, minFaceHeight: 2 }, schemaVersion: 'bench-measure.v2' });
    assert.equal(JSON.stringify(f.app.terrain.points), pointsBefore);
    assert.equal(f.app._resultsValid, true, 'medir no muta el perfil ni invalida');
    assert.match(f.element('bench-meta-table').innerHTML, /<td>1<\/td>[\s\S]*<td>2<\/td>/);
    assert.match(f.element('simulation-status').textContent, /2 bancos medidos/);
});

test('Medir bancos usa 5°, 0,5 m y 1,0 m cuando los campos traen los valores por defecto', () => {
    const f = make();
    const calls = measureDouble(f);
    setThresholds(f);
    f.element('btn-bench-measure').click();
    assert.deepEqual(calls[0].thresholds, { bermSlopeDeg: 5, bermToleranceY: 0.5, minFaceHeight: 1 });
});

test('Medir bancos: ok:false, salida inválida, umbral inválido o excepción dan alert y no cambian nada', () => {
    const cases = {
        'ok:false': f => measureDouble(f, { ok: false, reason: 'sentido de bajada no resuelto' }),
        'sin bancos': f => measureDouble(f, { ok: true, downhillSign: 1, benchMeta: [], schemaVersion: 'bench-measure.v2' }),
        'sentido inválido': f => measureDouble(f, { ok: true, downhillSign: 0, benchMeta: META, schemaVersion: 'bench-measure.v2' }),
        'excepción': f => { f.bench.measure = () => { throw new Error('falla interna'); }; },
        'umbral inválido': f => { measureDouble(f); f.element('bench-measure-slope').value = 'abc'; },
        'umbral vacío': f => { measureDouble(f); f.element('bench-measure-min-height').value = ''; },
        'sin módulo': f => { delete f.bench.measure; }
    };
    for (const [name, prepare] of Object.entries(cases)) {
        const f = make();
        setThresholds(f);
        prepare(f);
        const marker = { params: {}, benchMeta: [], pointsKey: 'x' };
        f.app._benchProfile = marker;
        f.app._resultsValid = true;
        f.element('bench-meta-table').innerHTML = 'previa';
        f.element('btn-bench-measure').click();
        assert.equal(hooks.alerts.length, 1, name);
        assert.match(hooks.alerts[0], /^No se pudieron medir los bancos: /, name);
        if (name === 'ok:false') assert.ok(hooks.alerts[0].includes('sentido de bajada no resuelto'));
        assert.equal(f.app._benchProfile, marker, name);
        assert.equal(f.app._resultsValid, true, name);
        assert.equal(f.element('bench-meta-table').innerHTML, 'previa', name);
    }
});

for (const worker of [false, true]) {
    const mode = worker ? 'Worker' : 'hilo';
    test(`transporte (${mode}): benchGeometry medido se congela en _runInfo y llega a stats.compute campo por campo`, () => {
        const f = make({ worker });
        measureDouble(f);
        setThresholds(f);
        withRetention(f, RETENTION);
        f.element('btn-bench-measure').click();
        f.element('sim-seed').value = '20261112';
        f.app.runSimulation();
        const expected = { source: 'medido', schemaVersion: 'bench-measure.v2', downhillSign: 1, benchMeta: META,
            thresholds: { bermSlopeDeg: 5, bermToleranceY: 0.5, minFaceHeight: 1 }, profileMinX: 0, profileMaxX: 450,
            pointsKey: JSON.stringify(f.app.terrain.points) };
        assert.deepEqual(plain(f.app._runInfo.benchGeometry), expected);
        assert.deepEqual(Object.keys(f.app._runInfo.benchGeometry), Object.keys(expected));
        assert.equal(Object.keys(f.app._runInfo).pop(), 'benchGeometry');
        // I-G: copia congelada; mutar o anular _benchProfile después no la toca.
        assert.notEqual(f.app._runInfo.benchGeometry.benchMeta, f.app._benchProfile.benchMeta);
        f.app._benchProfile.benchMeta[0].crestX = 999;
        f.app._benchProfile.thresholds.bermSlopeDeg = 99;
        f.app._benchProfile = null;
        finish(f, worker);
        assert.deepEqual(hooks.alerts, []);
        assert.equal(f.app.stats.calls, 1);
        const info = f.app.stats.info;
        assert.deepEqual(plain(info.benchGeometry), expected);
        assert.deepEqual(Object.keys(info.benchGeometry), Object.keys(expected));
        assert.equal(Object.keys(info).pop(), 'benchGeometry');
        assert.notEqual(info.benchGeometry, f.app._runInfo.benchGeometry);
        assert.notEqual(info.benchGeometry.benchMeta, f.app._runInfo.benchGeometry.benchMeta);
        assert.notEqual(info.benchGeometry.benchMeta[0], f.app._runInfo.benchGeometry.benchMeta[0]);
        assert.notEqual(info.benchGeometry.thresholds, f.app._runInfo.benchGeometry.thresholds);
        // Tabla «Retención por banco» alimentada por results.benchRetention.
        const table = f.element('bench-retention-table').innerHTML;
        assert.ok(f.element('bench-retention-title').textContent.includes('Retención por banco (geometría: medida)'));
        for (const zone of RETENTION.zones) assert.ok(table.includes(`<td>${zone.label}</td>`), zone.label);
        assert.ok(table.includes('<td>berma banco 1</td><td>2</td><td>25.0</td><td>33.3</td><td>3</td><td>250.5</td>'));
        // Filas «Censuradas: <motivo>»: conteos reales del módulo, no «—».
        assert.ok(table.includes('<td>Censuradas: salida del dominio</td><td>1</td><td>12.5</td><td>—</td><td>2</td><td>50.0</td>'));
        assert.ok(table.includes('<td>Censuradas: tiempo máximo</td><td>1</td><td>12.5</td><td>—</td><td>1</td><td>30.0</td>'));
        assert.ok(table.includes('<td>Censuradas: pasos máximos</td><td>0</td><td>0.0</td><td>—</td><td>0</td><td>0.0</td>'));
        assert.doesNotMatch(table, /Censuradas: [^<(]+<\/td><td>—/);
        assert.ok(table.includes('<td>Censuradas (total, sin zona)</td><td>2</td><td>25.0</td><td>—</td><td>3</td><td>80.0</td>'));
        assert.ok(table.includes('Σ zonas + censuradas = N: verificado'));
        assert.notEqual(f.element('bench-retention-block').style.display, 'none');
        assert.equal(f.element('btn-export-destinations').disabled, false);
    });

    test(`transporte (${mode}): perfil generado viaja como «generado» con downhillSign +1 y thresholds null`, () => {
        const f = make({ worker });
        withRetention(f, RETENTION);
        f.app._benchProfile = { params: { benches: 2 }, benchMeta: META.map(b => ({ ...b })), pointsKey: JSON.stringify(f.app.terrain.points) };
        f.app.runSimulation();
        finish(f, worker);
        const expected = { source: 'generado', schemaVersion: 'bench-profile.v1', downhillSign: 1, benchMeta: META, thresholds: null,
            profileMinX: 0, profileMaxX: 450, pointsKey: JSON.stringify(f.app.terrain.points) };
        assert.deepEqual(plain(f.app._runInfo.benchGeometry), expected);
        assert.deepEqual(plain(f.app.stats.info.benchGeometry), expected);
        assert.ok(f.element('bench-retention-title').textContent.includes('(geometría: generada)'));
    });

    test(`I-F (${mode}): sin _benchProfile o con pointsKey vencido no viaja geometría y la tabla dice «No disponible» con su motivo`, () => {
        for (const [name, profile, reason] of [['ausente', null, /No disponible: no hay geometría de bancos/],
            ['vencido', { source: 'medido', benchMeta: META, pointsKey: '[]', downhillSign: 1, thresholds: {}, schemaVersion: 'bench-measure.v2' },
                /No disponible: la geometría de bancos no corresponde al perfil de la corrida/],
            ['sin bancos', { source: 'medido', benchMeta: [], pointsKey: null, downhillSign: 1 }, /No disponible: /]]) {
            const f = make({ worker });
            withRetention(f, RETENTION);
            if (profile && profile.pointsKey === null) profile.pointsKey = JSON.stringify(f.app.terrain.points);
            f.app._benchProfile = profile;
            f.app.runSimulation();
            assert.equal('benchGeometry' in f.app._runInfo, false, name);
            finish(f, worker);
            assert.equal(f.app.stats.calls, 1, name);
            assert.equal('benchGeometry' in f.app.stats.info, false, name);
            assert.match(f.element('bench-retention-table').innerHTML, reason, name);
            assert.doesNotMatch(f.element('bench-retention-table').innerHTML, /<td>0<\/td>/, 'ausente no es cero');
            assert.equal(f.element('btn-export-destinations').disabled, false, 'el CSV de destinos no depende de los bancos');
        }
    });
}

for (const [mode, block] of [['isRunning', f => { f.app.simulation.isRunning = true; }], ['_workerActive', f => { f.app._workerActive = true; }]]) {
    test(`Medir bancos (${mode}): bloqueado durante la corrida con el aviso de P1.1; no llama a measure ni cambia _benchProfile ni la tabla`, () => {
        const f = make();
        const calls = measureDouble(f);
        setThresholds(f);
        const previous = { params: { benches: 1 }, benchMeta: [{ ...META[0] }], pointsKey: JSON.stringify(f.app.terrain.points) };
        f.app._benchProfile = previous;
        const snapshot = JSON.stringify(previous);
        f.element('bench-meta-table').innerHTML = '<tr><td>centinela</td></tr>';
        f.element('simulation-status').textContent = '';
        const pointsBefore = JSON.stringify(f.app.terrain.points);
        block(f);
        f.element('btn-bench-measure').click();
        assert.equal(calls.length, 0, 'measure no se llama');
        assert.deepEqual(hooks.alerts, []);
        assert.equal(f.element('simulation-status').textContent,
            'Edición del perfil bloqueada durante la corrida; detén la simulación para editar');
        assert.equal(f.app._benchProfile, previous);
        assert.equal(JSON.stringify(f.app._benchProfile), snapshot);
        assert.equal(f.element('bench-meta-table').innerHTML, '<tr><td>centinela</td></tr>');
        assert.equal(JSON.stringify(f.app.terrain.points), pointsBefore);
    });
}

test('I-F: con geometría enviada, si Stats no publica benchRetention o da ok:false la tabla dice «No disponible» con el motivo', () => {
    for (const [retention, reason] of [[null, /No disponible: Stats no publicó la retención/],
        [{ ok: false, reason: 'crestas desordenadas' }, /No disponible: crestas desordenadas/]]) {
        const f = make({ worker: true });
        withRetention(f, retention);
        f.app._benchProfile = { params: {}, benchMeta: META, pointsKey: JSON.stringify(f.app.terrain.points) };
        f.app.runSimulation();
        finish(f, true);
        assert.match(f.element('bench-retention-table').innerHTML, reason);
    }
});

test('I-G e invalidación: _invalidateResults limpia la tabla y bloquea «Exportar destinos (CSV)»', () => {
    const f = make({ worker: true });
    measureDouble(f); setThresholds(f); withRetention(f, RETENTION);
    let exports = 0;
    f.app.stats.generateDestinationsCSV = () => { exports++; return 'Roca,Raíz\n'; };
    f.element('btn-bench-measure').click();
    f.app.runSimulation();
    finish(f, true);
    assert.equal(f.element('btn-export-destinations').disabled, false);
    f.element('btn-export-destinations').click();
    assert.equal(exports, 1);
    assert.equal(f.element('created').download, 'simrocas_destinos.csv');
    // Editar el perfil invalida: la tabla no se reescribe con geometría nueva.
    f.global.SimRocas.ProfileEdit.changed(f.app);
    assert.equal(f.element('bench-retention-table').innerHTML, '');
    assert.equal(f.element('bench-retention-block').style.display, 'none');
    assert.equal(f.element('btn-export-destinations').disabled, true);
    f.element('btn-export-destinations').click();
    assert.equal(exports, 1, 'sin resultados válidos no exporta');
    assert.equal(f.app._benchProfile, null);
    const source = read('js/app.js');
    const lists = source.match(/\['btn-export-csv', 'btn-export-report'[^\]]*\]/g);
    assert.equal(lists.length, 2);
    for (const list of lists) assert.ok(list.includes("'btn-export-destinations'"), list);
});

test('el botón de destinos no exporta si Stats no ofrece generateDestinationsCSV o devuelve null', () => {
    const f = make({ worker: true });
    withRetention(f, null);
    f.app.runSimulation();
    finish(f, true);
    f.element('created').download = '';
    f.element('btn-export-destinations').click();
    assert.equal(f.element('created').download, '');
    f.app.stats.generateDestinationsCSV = () => null;
    f.element('btn-export-destinations').click();
    assert.equal(f.element('created').download, '');
});

// --- I-A: sin _benchProfile, _runInfo y la llamada a compute son los de 841fe984 ---
function runBare(worker, base) {
    const f = make({ worker, base });
    f.element('sim-seed').value = '20261112';
    f.app.runSimulation();
    const out = { runInfoKeys: Object.keys(f.app._runInfo), runInfo: JSON.stringify(f.app._runInfo) };
    if (worker) out.message = JSON.stringify(f.workers[0].message);
    finish(f, worker);
    assert.deepEqual(hooks.alerts, []);
    assert.equal(f.app.stats.calls, 1);
    out.infoKeys = Object.keys(f.app.stats.info);
    out.info = JSON.stringify(f.app.stats.info);
    out.status = f.element('simulation-status').textContent;
    return out;
}
test('I-A: sin _benchProfile, _runInfo, el mensaje al Worker y los argumentos de compute coinciden con 841fe984', () => {
    for (const worker of [false, true]) {
        const now = runBare(worker, false);
        const base = runBare(worker, true);
        assert.deepEqual(now, base, worker ? 'Worker' : 'hilo');
        assert.equal(now.runInfoKeys.includes('benchGeometry'), false);
        assert.equal(now.infoKeys.includes('benchGeometry'), false);
    }
});

test('T0.9: App.prototype no gana métodos; la lógica nueva son funciones de módulo', () => {
    const names = source => [...source.matchAll(/^ {4}(?:async )?([A-Za-z_]\w*)\([^)]*\) \{$/gm)].map(m => m[1]).sort();
    assert.deepEqual(names(read('js/app.js')), names(show('js/app.js')));
});
