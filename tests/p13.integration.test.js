'use strict';
// P1.3 (integración, I12): colectores con módulos REALES, sin dobles de motor ni de Stats.
// App real -> motor real (hilo y Worker en vm) -> Stats real -> CSV y reporte.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { loadScripts } = require('./helpers/load');

const BASE = '9232d1fe';
const ROOT = path.join(__dirname, '..');
const p11 = path.join(__dirname, 'p11.app.test.js');
const harness = fs.readFileSync(p11, 'utf8').split('const otherTerrain')[0].replace("'1fc23718'", `'${BASE}'`);
assert.ok(harness.includes(`const BASE = '${BASE}'`));
const { test, make, hooks, fillBench, runWorker, show, read } = new Function('require', '__dirname',
    harness + '\nreturn { test, make, hooks, fillBench, runWorker, show, read };')(createRequire(p11), __dirname);

const BENCH = { 'bench-count': '3', 'bench-height': '10', 'bench-face-angle': '70', 'bench-berm-width': '8',
    'bench-base-elevation': '0', 'bench-top-platform': '20', 'bench-floor-length': '30' };
const FACE = 10 / Math.tan(70 * Math.PI / 180);
// Plataforma (entre la fuente, x = 19, y la cresta, x = 20), mitad de la berma 1 y piso (2 m después de la pata).
const SITES = [['Plataforma', 19.5], ['Berma 1', 20 + FACE + 4], ['Piso', 20 + 3 * FACE + 16 + 2]];
const CROSSINGS_HEADER = 'Colector,X colector,Roca,Raíz,Tipo de pieza,Ordinal,Sentido,Por corrección,t (s),Y (m),Altura centro (m),Altura tope (m),' +
    'Vx,Vy,Velocidad (m/s),Omega (rad/s),E traslación (kJ),E rotación (kJ),E total (kJ),Masa (kg)';
const real = file => loadScripts([file], { env: 'browser' }).SimRocas;
const plain = v => JSON.parse(JSON.stringify(v));

// App con BenchProfile y BenchRetention reales y el perfil generado N = 3, H = 10, α = 70, W = 8.
function generated(worker, rocks, sites = SITES, base = false) {
    const f = make({ worker, base });
    f.global.SimRocas.BenchProfile = real('js/bench-profile.js').BenchProfile;
    f.global.SimRocas.BenchRetention = real('js/bench-retention.js').BenchRetention;
    fillBench(f, BENCH);
    f.element('btn-bench-generate').click();
    assert.deepEqual(hooks.alerts, []);
    f.element('num-rocks').value = String(rocks);
    f.element('max-duration').value = '30';
    if (sites.length) {
        f.app.setupBarrierControls();
        for (const [label, x] of sites) {
            f.element('collector-x').value = String(x); f.element('collector-label').value = label;
            f.element('btn-add-collector').click();
        }
        assert.deepEqual(hooks.alerts, []);
        assert.deepEqual(plain(f.app.collectors).map(c => [c.label, c.x]), sites);
    }
    return f;
}

// Corre con Stats real por el camino indicado (hilo o Worker en vm).
function runReal(f, worker, seedText) {
    f.app.stats = new f.Stats();
    const compute = f.app.stats.compute;
    let computeArgs = null;
    f.app.stats.compute = function (...args) { computeArgs = args; return compute.apply(this, args); };
    f.element('sim-seed').value = String(seedText);
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
        while (f.app.simulation.isRunning && guard++ < 20000000) f.app.simulation.step();
        assert.equal(f.app.simulation.isRunning, false);
        rocks = f.app.simulation.rocks;
    }
    assert.equal(f.app._resultsValid, true, 'la App publica');
    const s = f.app.stats, results = s.results;
    assert.ok(results && !results.blockedReason, 'Stats real publica');
    return { f, rocks, results, computeArgs, json: JSON.stringify(results), csv: s.generateCSV(), impacts: s.generateImpactCSV(), report: s.generateReport(),
        destinations: s.generateDestinationsCSV(), crossings: typeof s.generateCrossingsCSV === 'function' ? s.generateCrossingsCSV() : undefined };
}
// --- fin del harness (lo reutiliza C/exec/I12/estabilidad.js) ---

const SEED = '20261113';
const N = 300;
const cache = new Map();
function corrida(worker, withCollectors, base = false) {
    const key = `${worker}/${withCollectors}/${base}`;
    if (!cache.has(key)) cache.set(key, runReal(generated(worker, N, withCollectors ? SITES : [], base), worker, SEED));
    return cache.get(key);
}
// Todos los campos propios de la roca; `strip` quita solo los dos campos nuevos de P1.3.
const dump = (rocks, strip) => JSON.stringify(rocks, (key, value) => {
    if (strip && (key === 'crossings' || key === 'crossingsDropped')) return undefined;
    if (Object.prototype.toString.call(value) === '[object Set]') return [...value];
    return value;
});
const sinSeccion = text => text.split('\n').filter(line => !/^"?(COLECTORES|Colector )/.test(line)).join('\n');
const sinX5 = text => text.split('\n').filter(line => !/Versión del motor/.test(line)).join('\n');

test('perfil generado N = 3, H = 10, α = 70, W = 8: cruces y results.collectors idénticos en hilo y Worker, con cierre de conteos', () => {
    const hilo = corrida(false, true), worker = corrida(true, true);
    assert.equal(JSON.stringify(hilo.rocks.map(r => [r.id, r.crossings, r.crossingsDropped])),
        JSON.stringify(worker.rocks.map(r => [r.id, r.crossings, r.crossingsDropped])), 'I-C: mismos cruces');
    assert.equal(JSON.stringify(hilo.results.collectors), JSON.stringify(worker.results.collectors), 'I-C: mismo results.collectors');
    assert.equal(hilo.crossings, worker.crossings, 'mismo CSV de cruces');
    assert.deepEqual(plain(hilo.results.collectors).map(c => [c.label, c.x]), SITES);
    for (const c of hilo.results.collectors) {
        const k = c.counts, w = k.censoredWithoutCrossing;
        assert.equal(c.sample, 'first-downhill-per-piece', c.label);
        assert.ok(k.crossingsTotal >= 1 && c.n >= 1, `${c.label}: al menos 1 cruce`);
        assert.equal(k.released, N, c.label);
        assert.equal(k.rootsCrossing + k.restBeforeLine + w.culled + w.maxTime + w.maxSteps, k.released, `${c.label}: cierre sobre las raíces`);
        assert.equal(k.crossingsTotal, hilo.rocks.reduce((sum, r) => sum + r.crossings.filter(x => x.collector === c.id).length, 0), c.label);
    }
    assert.equal(hilo.results.runInfo.engineVersion, 13);
    assert.equal(Object.hasOwn(hilo.results.runInfo, 'collectors'), false, 'no se publica runInfo.collectors');
    assert.match(hilo.report, /cruces omitidos por el tope por roca \(total de la corrida\) \d+/);
});

test('I-A end-to-end: la misma semilla sin colectores da rocas, results, CSV general, impactos, destinos y reporte iguales (hilo, Worker y App/Stats de 9232d1fe salvo X5)', () => {
    for (const worker of [false, true]) {
        const label = worker ? 'Worker' : 'hilo';
        const con = corrida(worker, true), sin = corrida(worker, false);
        assert.ok(con.rocks.length >= N && con.rocks.some(r => r.crossings.length > 0), `${label}: no vacuo`);
        assert.ok(sin.rocks.every(r => !Object.hasOwn(r, 'crossings') && !Object.hasOwn(r, 'crossingsDropped')), `${label}: sin colectores no hay campos nuevos`);
        assert.equal(dump(con.rocks, true), dump(sin.rocks, false), `${label}: rocas`);
        // results.restRocks referencia a las rocas: sus dos campos nuevos también se excluyen.
        const results = JSON.parse(con.json, (key, value) => key === 'crossings' || key === 'crossingsDropped' ? undefined : value);
        assert.ok(Array.isArray(results.collectors));
        delete results.collectors;
        assert.equal(JSON.stringify(results), sin.json, `${label}: results sin collectors`);
        assert.equal(Object.hasOwn(sin.results, 'collectors'), false);
        assert.match(con.csv, /^COLECTORES,/m);
        assert.match(con.report, /^COLECTORES/m);
        assert.doesNotMatch(sin.csv + sin.report, /COLECTORES|Colector /);
        assert.equal(sinSeccion(con.csv), sin.csv, `${label}: CSV general`);
        assert.equal(sinSeccion(con.report), sin.report, `${label}: reporte`);
        assert.equal(con.impacts, sin.impacts, `${label}: impactos`);
        assert.equal(con.destinations, sin.destinations, `${label}: destinos`);
        assert.equal(sin.crossings, null, `${label}: sin colectores no hay CSV de cruces`);
        // App y Stats de la base (el motor es el del árbol; su pasividad contra la base la prueba p13.engine).
        const base = corrida(worker, false, true);
        assert.equal(base.results.runInfo.engineVersion, 12, 'X5');
        const noX5 = json => { const o = JSON.parse(json); delete o.runInfo.engineVersion; return JSON.stringify(o); };
        assert.equal(noX5(sin.json), noX5(base.json), `${label}: results iguales a ${BASE} salvo X5`);
        for (const key of ['csv', 'report']) {
            assert.equal(sin[key].split('\n').length, base[key].split('\n').length, `${label}: ${key}`);
            assert.equal(sinX5(sin[key]), sinX5(base[key]), `${label}: ${key} igual a ${BASE} salvo X5`);
        }
        assert.equal(sin.impacts, base.impacts, `${label}: impactos iguales a ${BASE}`);
        assert.equal(sin.destinations, base.destinations, `${label}: destinos iguales a ${BASE}`);
    }
});

test('CSV de cruces: una fila por cruce, columnas del §4, energías en kJ y null si la corrida está cancelada', () => {
    for (const worker of [false, true]) {
        const r = corrida(worker, true);
        const lines = r.crossings.split('\n').filter(line => line !== '');
        assert.equal(lines[0], CROSSINGS_HEADER);
        const all = [];
        for (const rock of r.rocks) for (const c of rock.crossings) all.push([rock, c]);
        assert.equal(lines.length - 1, all.length, 'filas = suma de los crossings');
        assert.equal(all.length, r.results.collectors.reduce((sum, c) => sum + c.counts.crossingsTotal, 0));
        assert.ok(all.length >= 3);
        const ids = Object.fromEntries(r.results.collectors.map(c => [c.id, c.x]));
        lines.slice(1).forEach((line, i) => {
            const cells = line.split(','), [rock, c] = all[i];
            assert.equal(cells.length, 20, line);
            assert.equal(cells[0], String(c.collector));
            assert.equal(Number(cells[1]), ids[c.collector]);
            assert.equal(Number(cells[2]), rock.id);
            assert.equal(Number(cells[5]), c.ordinal);
            assert.equal(Number(cells[8]), c.t);
            assert.equal(Number(cells[16]), c.energyTrans / 1000, 'E traslación en kJ');
            assert.equal(Number(cells[17]), c.energyRot / 1000, 'E rotación en kJ');
            assert.equal(Number(cells[18]), c.energy / 1000, 'E total en kJ');
            assert.equal(Number(cells[19]), c.mass);
        });
        // Corrida cancelada: mismas rocas y mismos argumentos de compute, con una roca cancelada.
        const [rocks, ...rest] = r.computeArgs;
        const cancelled = rocks.map((rock, i) => i === rocks.length - 1 ? Object.assign(Object.create(Object.getPrototypeOf(rock)), rock, { stopReason: 'cancelled' }) : rock);
        const stats = new r.f.Stats();
        stats.compute(cancelled, ...rest);
        assert.equal(stats.results.status, 'bloqueado');
        assert.equal(stats.generateCrossingsCSV(), null);
        assert.equal(Object.hasOwn(stats.results, 'collectors'), false);
    }
});

// Arbitraje I12 §1.5: todos los <script> clásicos de index.html comparten un solo ámbito global.
test('ámbito global compartido: los scripts de index.html cargan en un solo realm sin const, let ni class duplicados', () => {
    const files = [...read('index.html').matchAll(/<script src="(js\/[\w.-]+\.js)\?v=\d+"><\/script>/g)].map(m => m[1]);
    assert.ok(files.length >= 25 && files.includes('js/stats.js') && files.includes('js/app.js') && files.includes('js/app-worker.js'));
    const sandbox = { console: { log() {}, warn() {}, error() {} }, performance };
    sandbox.window = sandbox; sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    const owners = new Map();
    for (const file of files) {
        const code = read(file);
        // Las colisiones de declaraciones léxicas fallan al instanciar el script, antes de ejecutar nada.
        try { vm.runInContext(code, context, { filename: file }); } catch (err) {
            assert.notEqual(err && err.name, 'SyntaxError', `${file}: ${err && err.message}`);
        }
        for (const m of code.matchAll(/^(const|let|class|function|var)\s+([A-Za-z_$][\w$]*)/gm)) {
            const previous = owners.get(m[2]);
            if (previous && previous.file !== file) assert.ok(previous.kind === 'function' || previous.kind === 'var' ? m[1] === 'function' || m[1] === 'var' : false,
                `${m[2]}: declarado en ${previous.file} y en ${file}`);
            if (!previous) owners.set(m[2], { file, kind: m[1] });
        }
    }
    // Control: una colisión real sí se detecta con este mismo mecanismo.
    assert.throws(() => vm.runInContext('const COLLECTOR_ENVELOPES = 1;', context), { name: 'SyntaxError' });
    for (const name of ['COLLECTOR_ENVELOPES', 'APP_COLLECTOR_ROWS', 'APP_COLLECTOR_SAMPLES']) assert.ok(owners.has(name), name);
});
