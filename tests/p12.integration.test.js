'use strict';
// P1.2 (I10): integración de punta a punta con módulos REALES, sin dobles:
// BenchProfile (generate y measure), BenchRetention, Stats, motor, Worker (vm) y App.
// Las comparaciones de I-A son contra 841fe984 (git show), nunca contra HEAD.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { loadScripts } = require('./helpers/load');

const BASE = '841fe984';
const p11 = path.join(__dirname, 'p11.app.test.js');
const harness = fs.readFileSync(p11, 'utf8').split('const otherTerrain')[0]
    .replace("const test = require('node:test');", 'const test = () => {};').replace("'1fc23718'", `'${BASE}'`);
assert.ok(harness.includes(`const BASE = '${BASE}'`));
const { make, hooks, fillBench, runWorker } = new Function('require', '__dirname',
    harness + '\nreturn { make, hooks, fillBench, runWorker };')(createRequire(p11), __dirname);

const BENCH = { 'bench-count': '3', 'bench-height': '10', 'bench-face-angle': '70', 'bench-berm-width': '8',
    'bench-base-elevation': '0', 'bench-top-platform': '20', 'bench-floor-length': '30' };
const HEADER = 'Roca,Raíz,Padre,Tipo de pieza,Fuente,X liberación,Y liberación,X final,Y final,Motivo,Límite,Zona,Banco,Masa (kg)';
const real = file => loadScripts([file], { env: 'browser' }).SimRocas;
const plain = v => JSON.parse(JSON.stringify(v));

// Instala los módulos reales en el global de la App (reemplaza el doble de BenchProfile).
function realModules(f) {
    f.global.SimRocas.BenchProfile = real('js/bench-profile.js').BenchProfile;
    f.global.SimRocas.BenchRetention = real('js/bench-retention.js').BenchRetention;
    assert.equal(typeof f.global.SimRocas.BenchProfile.measure, 'function');
    assert.equal(typeof f.global.SimRocas.BenchRetention.summarize, 'function');
    return f;
}

function generated(worker, rocks = '40') {
    const f = realModules(make({ worker }));
    fillBench(f, BENCH);
    f.element('btn-bench-generate').click();
    assert.deepEqual(hooks.alerts, []);
    f.element('num-rocks').value = rocks;
    f.element('max-duration').value = '30';
    return f;
}

// Corre con Stats real por el camino indicado (hilo o Worker en vm).
function runReal(f, worker, seedText) {
    f.app.stats = new f.Stats();
    f.element('sim-seed').value = seedText;
    hooks.alerts.length = 0;
    f.app.runSimulation();
    assert.deepEqual(hooks.alerts, []);
    let rocks;
    if (worker) {
        assert.equal(f.workers.length, 1);
        const done = runWorker(plain(f.workers[0].message)).find(m => m.type === 'complete');
        assert.ok(done, 'el Worker termina');
        rocks = done.rocks;
        f.workers[0].onmessage({ data: done });
    } else {
        let guard = 0;
        while (f.app.simulation.isRunning && guard++ < 2000000) f.app.simulation.step();
        assert.equal(f.app.simulation.isRunning, false);
        rocks = f.app.simulation.rocks;
    }
    assert.equal(f.app._resultsValid, true, 'la App publica');
    const results = f.app.stats.results;
    assert.ok(results && !results.blockedReason, 'Stats real publica');
    return { f, rocks, results, json: JSON.stringify(results), csv: f.app.stats.generateCSV(),
        impacts: f.app.stats.generateImpactCSV(), report: f.app.stats.generateReport(),
        destinations: typeof f.app.stats.generateDestinationsCSV === 'function' ? f.app.stats.generateDestinationsCSV() : undefined, table: f.element('bench-retention-table').innerHTML };
}

// Comprobaciones comunes de una corrida con tabla: cierre, censura fuera de las zonas y CSV de destinos.
function checkRetention(r, source, label) {
    const b = r.results.benchRetention;
    assert.ok(b, `${label}: results.benchRetention publicado`);
    assert.equal(b.schemaVersion, 'bench-retention.v1');
    assert.equal(b.source, source);
    assert.equal(r.results.contractVersion, 'P0.5');
    assert.equal(r.results.benchRetentionUnavailable, undefined);
    const geometry = r.results.runInfo.benchGeometry;
    assert.equal(geometry.pointsKey, JSON.stringify(r.f.app.terrain.points), `${label}: pointsKey del perfil de la corrida`);
    const leaves = r.rocks.filter(rock => rock.stopReason !== 'fragmented');
    const roots = new Set(leaves.map(rock => Number.isInteger(rock.rootId) && rock.rootId >= 0 ? rock.rootId : rock.id));
    const sum = key => b.zones.reduce((total, z) => total + z[key], 0);
    // Cierre en primarias, piezas y masa (I-D).
    assert.deepEqual([b.closure.primariesOk, b.closure.piecesOk, b.closure.massOk], [true, true, true], `${label}: cierre`);
    assert.equal(b.denominators.released, roots.size, `${label}: N primarias`);
    assert.equal(b.denominators.releasedPieces, leaves.length, `${label}: N piezas`);
    assert.equal(sum('primaries') + b.censored.primaries, roots.size, `${label}: Σ zonas + censuradas = N (primarias)`);
    assert.equal(sum('pieces') + b.censored.pieces, leaves.length, `${label}: Σ zonas + censuradas = N (piezas)`);
    assert.equal(sum('pieces'), leaves.filter(rock => rock.stopReason === 'rest').length, `${label}: solo las hojas en reposo cuentan en zonas`);
    assert.equal(b.censored.pieces, leaves.filter(rock => rock.stopReason !== 'rest').length);
    // Forma arbitrada (A): objetos { primaries, pieces, mass } por motivo y por límite.
    for (const group of [b.censored.byReason, b.censored.cullBoundary]) {
        for (const cell of Object.values(group)) assert.deepEqual(Object.keys(cell), ['primaries', 'pieces', 'mass']);
    }
    assert.equal(Object.values(b.censored.byReason).reduce((n, c) => n + c.pieces, 0), b.censored.pieces);
    // CSV de destinos: una fila por hoja; la zona coincide con classify; ninguna censurada en una zona.
    const lines = r.destinations.trimEnd().split('\n');
    assert.equal(lines[0], HEADER);
    assert.equal(lines.length - 1, leaves.length, `${label}: filas del CSV de destinos = hojas`);
    const classify = r.f.global.SimRocas.BenchRetention.classify;
    const labels = Object.fromEntries(b.zones.map(z => [z.key, z.label]));
    const byId = new Map(leaves.map(rock => [rock.id, rock]));
    const perZone = {};
    for (const line of lines.slice(1)) {
        const cols = line.split(',');
        assert.equal(cols.length, 14, line);
        const rock = byId.get(Number(cols[0]));
        assert.ok(rock, `${label}: la fila ${cols[0]} es una hoja`);
        byId.delete(rock.id);
        if (rock.stopReason === 'rest') {
            const where = classify(rock.finalX, rock.releaseX, geometry);
            assert.ok(where.zone, `${label}: hoja en reposo con zona`);
            assert.equal(cols[11], labels[where.zone], `${label}: zona de la roca ${rock.id}`);
            assert.equal(cols[12], where.bench === null ? '' : String(where.bench));
            assert.equal(cols[9], 'reposo');
            perZone[where.zone] = (perZone[where.zone] || 0) + 1;
        } else {
            assert.equal(cols[11], '', `${label}: censurada sin zona (${rock.id})`);
            assert.equal(cols[12], '');
            assert.notEqual(cols[9], 'reposo');
            if (rock.stopReason === 'culled') assert.ok(['izquierdo', 'derecho', 'inferior'].includes(cols[10]), `${label}: límite en español`);
        }
    }
    assert.equal(byId.size, 0, `${label}: todas las hojas tienen fila`);
    for (const z of b.zones) assert.equal(z.pieces, perZone[z.key] || 0, `${label}: piezas en ${z.key}`);
    // La sección va al final del reporte y del CSV general; la tabla de la App se publica.
    assert.match(r.report, new RegExp(`RETENCIÓN POR BANCO \\(geometría: ${source === 'medido' ? 'medida' : 'generada'}\\)`));
    assert.match(r.csv, /Retención: cierre Σ zonas \+ censuradas = N/);
    assert.match(r.csv, /primarias \d+ \+ \d+ = \d+ \(cumple\); piezas \d+ \+ \d+ = \d+ \(cumple\); masa[^\n]*\(cumple;/);
    assert.match(r.table, /<thead>/, `${label}: la App publica la tabla`);
    assert.doesNotMatch(r.table, /No disponible/);
    assert.match(r.table, /Σ zonas \+ censuradas = N: verificado/);
    assert.equal(r.f.element('btn-export-destinations').disabled, false);
    return { b, geometry, leaves };
}

test('perfil generado (N=3, H=10, α=70, W=8): benchRetention igual en hilo y Worker, cierre y CSV de destinos', () => {
    const out = {};
    for (const worker of [false, true]) {
        const label = worker ? 'Worker' : 'hilo';
        const f = generated(worker);
        const r = runReal(f, worker, '20261112');
        const { b, geometry } = checkRetention(r, 'generado', label);
        assert.equal(geometry.benchMeta.length, 3);
        assert.equal(geometry.downhillSign, 1);
        assert.equal(geometry.thresholds, null);
        assert.equal(geometry.schemaVersion, 'bench-profile.v1');
        assert.deepEqual(plain(b.zones).map(z => z.key), ['upstream', 'platform', 'face:1', 'berm:1', 'face:2', 'berm:2', 'face:3', 'floor', 'outside']);
        // Fixture no vacuo (M9 §7): al menos una roca cruzó la primera cresta y hay más de una zona ocupada.
        assert.ok(r.rocks.some(rock => rock.stopReason === 'rest' && rock.finalX > geometry.benchMeta[0].crestX), `${label}: alguna roca cruza la primera cresta`);
        assert.ok(b.zones.filter(z => z.key !== 'platform' && z.key !== 'upstream').some(z => z.pieces > 0), `${label}: zonas bajo la plataforma ocupadas`);
        out[worker] = r;
    }
    assert.equal(JSON.stringify(out.false.results.benchRetention), JSON.stringify(out.true.results.benchRetention), 'benchRetention hilo = Worker');
    assert.equal(out.false.destinations, out.true.destinations, 'CSV de destinos hilo = Worker');
    assert.equal(out.false.csv, out.true.csv, 'CSV general hilo = Worker');
    assert.equal(out.false.report, out.true.report, 'reporte hilo = Worker');
    assert.equal(out.false.table, out.true.table, 'tabla de la App hilo = Worker');
});

test('fragmentación activa (umbral bajo): hojas de un árbol en zonas distintas y primaria en la zona de su representante', () => {
    let mixedTrees = 0;
    for (const worker of [false, true]) {
        const label = worker ? 'Worker' : 'hilo';
        const f = generated(worker, '30');
        f.app.physics.fragmentationEnabled = true;
        f.app.physics.fractureEnergy = 200;
        const r = runReal(f, worker, '20261112');
        assert.ok(r.rocks.some(rock => rock.stopReason === 'fragmented'), `${label}: hubo fragmentación`);
        assert.ok(r.results.lineage, `${label}: linaje publicado`);
        const { b, geometry, leaves } = checkRetention(r, 'generado', label);
        assert.ok(leaves.length > b.denominators.released, `${label}: más piezas que primarias`);
        assert.equal(b.discardedMass, r.results.lineage.mass.discarded);
        // Oráculo independiente del representante (stats.js: mayor avance; empate, menor id) y de la censura conservadora.
        const classify = f.global.SimRocas.BenchRetention.classify;
        const trees = new Map();
        for (const leaf of leaves) {
            const root = Number.isInteger(leaf.rootId) && leaf.rootId >= 0 ? leaf.rootId : leaf.id;
            if (!trees.has(root)) trees.set(root, []);
            trees.get(root).push(leaf);
        }
        const expected = {};
        let censored = 0;
        for (const list of trees.values()) {
            const advance = rock => Number.isFinite(rock.maxDownhillAdvance) ? rock.maxDownhillAdvance : -Infinity;
            let rep = list[0];
            for (const leaf of list) {
                const delta = advance(leaf) - advance(rep);
                if (delta > 0 || (!(delta < 0) && leaf.id < rep.id)) rep = leaf;
            }
            const late = list.some(rock => rock.stopReason === 'maxTime' || rock.stopReason === 'maxSteps');
            if (rep.stopReason !== 'rest' || late) { censored++; continue; }
            const zone = classify(rep.finalX, rep.releaseX, geometry).zone;
            expected[zone] = (expected[zone] || 0) + 1;
            const zones = new Set(list.filter(rock => rock.stopReason === 'rest').map(rock => classify(rock.finalX, rock.releaseX, geometry).zone));
            if (zones.size > 1) mixedTrees++;
        }
        for (const z of b.zones) assert.equal(z.primaries, expected[z.key] || 0, `${label}: primarias en ${z.key}`);
        assert.equal(b.censored.primaries, censored, `${label}: primarias censuradas`);
    }
    assert.ok(mixedTrees > 0, 'no vacuo: algún árbol tiene hojas en zonas distintas');
});

// Perfil «importado»: el generado con cada cara subdividida en 3 tramos colineales.
function importSubdivided(f) {
    const points = f.app.terrain.points.map(p => ({ x: p.x, y: p.y }));
    const meta = f.app._benchProfile.benchMeta;
    const release = { ...f.app.releasePoint };
    const out = [];
    for (let i = 0; i < points.length; i++) {
        out.push(points[i]);
        const next = points[i + 1];
        if (next && meta.some(m => m.crestX === points[i].x && m.toeX === next.x)) {
            for (const t of [1 / 3, 2 / 3]) out.push({ x: points[i].x + t * (next.x - points[i].x), y: points[i].y + t * (next.y - points[i].y) });
        }
    }
    assert.equal(out.length, points.length + 2 * meta.length, 'cada cara quedó en 3 tramos');
    const terrain = new f.Terrain();
    terrain.setPoints(out);
    f.element('file-input').listeners.change({ target: { files: [{ name: 'importado.json', text: terrain.toJSON() }] } });
    assert.deepEqual(hooks.alerts, []);
    assert.equal(f.app.terrain.points.length, out.length);
    assert.equal(f.app._benchProfile, null, 'importar anula la geometría generada (P1.1)');
    f.app.releasePoint.x = release.x; f.app.releasePoint.y = release.y;
    f.element('downhill-mode').value = '+x';
    return f;
}

function measure(f) {
    // Valores por defecto de U6: 5°, 0,5 m y 1,0 m.
    f.element('bench-measure-slope').value = '5';
    f.element('bench-measure-tolerance').value = '0.5';
    f.element('bench-measure-min-height').value = '1.0';
    f.element('btn-bench-measure').click();
    assert.deepEqual(hooks.alerts, []);
}

test('«Medir bancos» sobre un perfil importado (caras en 3 tramos, umbrales U6): source medido, 3 bancos y tabla publicada', () => {
    for (const worker of [false, true]) {
        const label = worker ? 'Worker' : 'hilo';
        const f = importSubdivided(generated(worker));
        measure(f);
        const profile = f.app._benchProfile;
        assert.equal(profile.source, 'medido');
        assert.equal(profile.benchMeta.length, 3);
        assert.equal(profile.downhillSign, 1);
        assert.equal(profile.schemaVersion, 'bench-measure.v2');
        assert.deepEqual(plain(profile.thresholds), { bermSlopeDeg: 5, bermToleranceY: 0.5, minFaceHeight: 1 });
        for (const m of profile.benchMeta) {
            assert.ok(Math.abs(m.height - 10) < 1e-6 && Math.abs(m.faceAngleDeg - 70) < 1e-6, `${label}: H y α recuperados`);
        }
        assert.ok(Math.abs(profile.benchMeta[0].nominalWidth - 8) < 1e-6, `${label}: W recuperado`);
        const r = runReal(f, worker, '20261112');
        const { b, geometry } = checkRetention(r, 'medido', label);
        assert.deepEqual(plain(geometry.thresholds), { bermSlopeDeg: 5, bermToleranceY: 0.5, minFaceHeight: 1 });
        assert.equal(b.zones.length, 9);
        assert.match(f.element('bench-retention-title').textContent, /geometría: medida/);
        assert.ok(r.rocks.some(rock => rock.stopReason === 'rest' && rock.finalX > geometry.benchMeta[0].crestX), `${label}: no vacuo`);
    }
});

test('geometría vencida: medir, editar el perfil y correr; la tabla dice «No disponible» y la corrida es igual a I-A', () => {
    const edit = f => { f.element('input-x').value = '500'; f.element('input-y').value = '-5'; f.element('btn-add-point').click(); };
    for (const worker of [false, true]) {
        // Referencia: el mismo perfil editado, sin haber medido nunca.
        const clean = importSubdivided(generated(worker));
        edit(clean);
        const reference = runReal(clean, worker, '20261112');
        assert.equal(reference.results.benchRetention, undefined);
        for (const keepStale of [false, true]) {
            const f = importSubdivided(generated(worker));
            measure(f);
            const stale = f.app._benchProfile;
            edit(f);
            assert.equal(f.app._benchProfile, null, 'editar anula la geometría medida (P1.1)');
            // keepStale: se restituye la geometría vieja para ejercitar la guarda de pointsKey de la App (I-F).
            if (keepStale) f.app._benchProfile = stale;
            const r = runReal(f, worker, '20261112');
            assert.equal(Object.hasOwn(f.app._runInfo, 'benchGeometry'), false, 'benchGeometry no viaja');
            assert.equal(Object.hasOwn(r.results.runInfo, 'benchGeometry'), false);
            assert.equal(r.results.benchRetention, undefined);
            assert.equal(r.results.benchRetentionUnavailable, undefined);
            assert.match(r.table, keepStale ? /No disponible: la geometría de bancos no corresponde al perfil de la corrida/
                : /No disponible: no hay geometría de bancos/);
            assert.doesNotMatch(r.table, /<thead>/);
            for (const key of ['json', 'csv', 'impacts', 'report', 'destinations']) assert.equal(r[key], reference[key], `${key} igual a la corrida sin geometría`);
            assert.doesNotMatch(r.report, /RETENCIÓN POR BANCO/);
            assert.ok(r.destinations.split('\n').slice(1, -1).every(line => /,,,[^,]*$/.test(line)), 'Zona y Banco vacíos');
        }
    }
});

test('I-A: sin geometría, con semilla y en los 3 métodos, results, CSV general, impactos y reporte idénticos a 841fe984 (hilo y Worker)', () => {
    const prints = new Set();
    for (const method of ['rigid-body', 'lumped-mass', 'nonsmooth']) {
        for (const worker of [false, true]) {
            const label = `${method}/${worker ? 'Worker' : 'hilo'}`;
            const run = base => {
                const f = make({ worker, base });
                if (!base) realModules(f);
                f.app.physics.calcMethod = method;
                f.element('num-rocks').value = '12';
                f.element('max-duration').value = '30';
                const r = runReal(f, worker, '20261112');
                assert.equal(f.app._runInfo.calcMethod, method, label);
                if (worker) assert.ok(JSON.stringify(f.workers[0].message).includes(`"${method}"`), `${label}: el método llega al Worker`);
                return r;
            };
            const now = run(false), base = run(true);
            assert.ok(now.rocks.length >= 12);
            assert.deepEqual(Object.keys(now.results), Object.keys(base.results), `${label}: claves de results`);
            assert.deepEqual(Object.keys(now.results.runInfo), Object.keys(base.results.runInfo), `${label}: claves de runInfo`);
            assert.equal(Object.hasOwn(now.results, 'benchRetention'), false);
            assert.equal(Object.hasOwn(now.results, 'benchRetentionUnavailable'), false);
            assert.equal(Object.keys(now.results).includes('destinations'), false, 'destinations no es enumerable');
            for (const key of ['json', 'csv', 'impacts', 'report']) assert.equal(now[key], base[key], `${label}: ${key} idéntico a ${BASE}`);
            assert.ok(now.csv.split('\n').length > 10 && now.report.length > 200, `${label}: no vacuo`);
            assert.equal(typeof base.f.app.stats.generateDestinationsCSV, 'undefined', 'la base no tiene CSV de destinos');
            assert.match(now.table, /No disponible: no hay geometría de bancos/);
            prints.add(now.csv);
        }
    }
    assert.equal(prints.size, 3, 'los 3 métodos dan corridas distintas (hilo = Worker en cada uno)');
});

test('cancelación: sin tabla y sin CSV de destinos', () => {
    // App: detener a mitad de la corrida invalida, limpia la tabla y bloquea el botón.
    for (const worker of [false, true]) {
        const f = generated(worker);
        f.app.stats = new f.Stats();
        f.element('sim-seed').value = '20261112';
        f.app.runSimulation();
        assert.ok(f.app._runInfo.benchGeometry, 'la corrida arrancó con geometría');
        if (!worker) for (let i = 0; i < 50 && f.app.simulation.isRunning; i++) f.app.simulation.step();
        f.app.stopSimulation();
        assert.equal(f.app._resultsValid, false);
        assert.equal(f.element('bench-retention-table').innerHTML, '');
        assert.equal(f.element('bench-retention-block').style.display, 'none');
        assert.equal(f.element('btn-export-destinations').disabled, true);
        const csv = f.app.stats.generateDestinationsCSV();
        assert.equal(csv, null, 'sin CSV de destinos');
    }
    // Stats real con BenchRetention real: una corrida cancelada o en límite de seguridad no publica (I-E).
    const done = runReal(generated(false), false, '20261112');
    assert.ok(done.results.benchRetention);
    for (const reason of ['cancelled', 'safetyLimit']) {
        const rocks = done.rocks.slice();
        const stats = new done.f.Stats();
        const original = rocks[0].stopReason;
        rocks[0].stopReason = reason;
        let results;
        try { results = stats.compute(rocks, done.f.app.releasePoint, done.f.app._runInfo); } finally { rocks[0].stopReason = original; }
        assert.ok(results.blockedReason, `${reason}: corrida bloqueada`);
        assert.equal(results.benchRetention, undefined, `${reason}: sin tabla`);
        assert.equal(stats.generateDestinationsCSV(), null, `${reason}: sin CSV de destinos`);
        assert.doesNotMatch(stats.generateReport(), /Retención: /, `${reason}: sin filas de zonas`);
    }
});
