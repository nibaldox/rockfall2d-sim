'use strict';

/**
 * Integración P0.4, parte B (B3): motor → serializeRocks → App (camino normal y
 * Worker) → Stats real → CSV, reporte y DOM. Solo el DOM es un doble.
 * - Sin fragmentación: `results` igual al de 8bd08df2 salvo X1 y X2; bloque oculto.
 * - Con fragmentación a 1000 J: publica con N = primarias, bloque visible y
 *   coherente con `results.lineage`, CSV de impactos con padres y masa conservada.
 * - `linajeInvalido`: bloquea en ambos caminos.
 * La base se lee con `git show 8bd08df2:js/stats.js` (solo lectura).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');

const ROOT = path.resolve(__dirname, '..');
const BASE = '8bd08df28ba22b608e92f6ef34129b9a9c932782';
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const SEED = 12345;
const FRAG_ROCKS = 3;
const KIND_ES = { primary: 'primaria', core: 'núcleo', major: 'principal', spall: 'esquirla' };

const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0];
const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), __dirname);
const parity = path.join(__dirname, 'worker.parity.test.js');
const workerSource = fs.readFileSync(parity, 'utf8').split('// --- Paridad (protocolo')[0];
const { runWorker } = new Function('require', '__dirname', workerSource + '\nreturn { runWorker };')(createRequire(parity), __dirname);

function baseStats() {
    const source = execFileSync('git', ['show', `${BASE}:js/stats.js`], { cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    const ctx = vm.createContext({ SimRocas: {} });
    vm.runInContext(source, ctx, { filename: 'stats.8bd08df2.js' });
    return new ctx.SimRocas.Stats();
}

const cache = new Map();
function engine(calcMethod, fractureEnergy) {
    const key = `${calcMethod}/${fractureEnergy}`;
    if (cache.has(key)) return cache.get(key);
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: SEED });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    const params = { numRocks: FRAG_ROCKS, animationSpeed: 1, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: !!fractureEnergy, fractureEnergy: fractureEnergy || 25000, downhillMode: '+x' };
    const args = [10, 51, 0.5, 2700, 0, 0, 30, false, 'polygon', 1, 'freefall', null];
    sim.configure(params);
    physics.calcMethod = calcMethod;
    sim.barriers = [];
    sim.start(...args);
    let it = 0;
    while (sim.isRunning && it++ < 400000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida normal debe terminar');
    const messages = runWorker({ type: 'start', terrainJSON: terrain.toJSON(), simParams: params,
        physicsParams: { calcMethod }, barriers: [], startArgs: args });
    const complete = messages.find(m => m.type === 'complete');
    assert.ok(complete, 'el worker real debe completar');
    const run = { terrain, physics, sim, rocks: sim.rocks.slice(), complete };
    cache.set(key, run);
    return run;
}

// Copia fresca del conjunto de cada camino: instancias de Rock (normal) o datos clonados (Worker).
function source(run, worker) {
    return worker ? structuredClone(run.complete.rocks) :
        run.rocks.map(r => Object.assign(Object.create(Object.getPrototypeOf(r)), r));
}

// Publica en la App real con el Stats real y captura los argumentos de `compute`.
function publish(run, worker, rocks) {
    const f = fixture(false);
    f.app.terrain = run.terrain;
    f.app.physics = run.physics;
    f.app.simulation = run.sim;
    f.app.releasePoint = { x: 10, y: 51 };
    f.app.stats = new f.Stats();
    const compute = f.app.stats.compute.bind(f.app.stats);
    f.app.stats.compute = (...args) => { f.computeArgs = args; return compute(...args); };
    f.app._completeRun(rocks, 'completed', worker);
    return f;
}
const exportsEnabled = (f, value, label) => {
    for (const id of ['btn-export-csv', 'btn-export-report', 'btn-export-impacts']) assert.equal(f.element(id).disabled, !value, `${label}: ${id}`);
};

test('sin fragmentación: results igual al de 8bd08df2 salvo X1 y X2, bloque oculto', () => {
    for (const calcMethod of ['rigid-body', 'lumped-mass']) {
        const run = engine(calcMethod, 0);
        for (const worker of [false, true]) {
            const label = `${calcMethod}, ${worker ? 'worker' : 'normal'}`;
            const f = publish(run, worker, source(run, worker));
            const a = f.app.stats.results;
            assert.equal(f.app._resultsValid, true, label);
            assert.ok(f.computeArgs, `${label}: la App llamó a Stats.compute`);
            const old = baseStats();
            const b = old.compute(...f.computeArgs);
            assert.equal(b.contractVersion, 'P0.2-beta', label);
            assert.equal(a.contractVersion, 'P0.5', `${label}: X1`);
            assert.equal(Object.hasOwn(a, 'lineage'), false, `${label}: sin clave lineage`);
            assert.ok(a.impactEvents.length > 0, `${label}: hay eventos`);
            for (const e of a.impactEvents) {
                assert.equal(e.rootId, e.rockId, `${label}: X2 rootId`);
                assert.equal(e.fragmentKind, 'primary', `${label}: X2 fragmentKind`);
            }
            // X1: contractVersion. X2: solo rootId y fragmentKind de cada evento.
            const strip = r => JSON.stringify({ ...r, contractVersion: undefined,
                impactEvents: r.impactEvents.map(({ rootId, fragmentKind, ...rest }) => rest) });
            assert.equal(strip(a), strip(b), `${label}: results`);
            const csvFull = f.app.stats.generateCSV().split('\n'), csvB = old.generateCSV().split('\n');
            // X3: se excluyen exactamente sus 4 filas, que van justo después de la versión del contrato.
            const iVer = csvFull.findIndex(line => line.startsWith('Versión del contrato de resultados,'));
            assert.deepEqual(csvFull.slice(iVer + 1, iVer + 5).map(line => line.split(',')[0]), ['Semilla', 'Generador pseudoaleatorio', 'Versión del motor', 'Parámetros correlacionados'], `${label}: filas X3 tras la versión`);
            const csvA = csvFull.filter(line => !/^(?:Semilla|Generador pseudoaleatorio|Versión del motor|Parámetros correlacionados),/.test(line));
            assert.equal(csvFull.length - csvA.length, 4, `${label}: exactamente 4 filas X3`);
            assert.deepEqual(csvA.filter(line => !/^(?:Semilla|Generador pseudoaleatorio|Versión del motor|Parámetros correlacionados),/.test(line)).filter((line, i) => line !== csvB[i]), ['Versión del contrato de resultados,P0.5' + ','.repeat(13)], label);
            assert.equal(csvA.length, csvB.length, label);
            assert.equal(f.element('lineage-block').style.display, 'none', `${label}: bloque oculto`);
            assert.doesNotMatch(f.element('simulation-status').textContent, /piezas finales|rocas originales/i, label);
            exportsEnabled(f, true, label);
        }
    }
});

for (const calcMethod of ['rigid-body', 'lumped-mass']) {
    test(`fragmentación a 1000 J publica dos poblaciones: ${calcMethod}`, () => {
        const run = engine(calcMethod, 1000);
        for (const worker of [false, true]) {
            const label = `${calcMethod}, ${worker ? 'worker' : 'normal'}`;
            const rocks = source(run, worker);
            const parents = rocks.filter(r => r.stopReason === 'fragmented');
            assert.ok(parents.length > 0 && rocks.length > FRAG_ROCKS, `${label}: hubo fragmentación`);
            const f = publish(run, worker, rocks);
            const r = f.app.stats.results;
            // Publica, con N = número de primarias.
            assert.equal(f.app._resultsValid, true, label);
            assert.doesNotMatch(f.element('simulation-status').textContent, /incompatible|bloquead/i, label);
            assert.equal(r.blockedReason, null, label);
            assert.equal(r.contractVersion, 'P0.5', label);
            assert.equal(r.totalRocks, FRAG_ROCKS, `${label}: N = primarias`);
            assert.equal(r.population.released, FRAG_ROCKS, label);
            assert.ok(r.warnings.some(w => w.code === 'fragmentacion'), `${label}: advertencia informativa`);
            const lineage = r.lineage;
            assert.equal(lineage.primaries, FRAG_ROCKS, label);
            assert.equal(lineage.entities, rocks.length, label);
            assert.equal(lineage.leaves, rocks.length - parents.length, label);
            exportsEnabled(f, true, label);
            assert.match(f.element('simulation-status').textContent,
                new RegExp(`${FRAG_ROCKS} rocas originales.*${lineage.leaves} piezas finales`), label);

            // Bloque visible, con los valores de results.lineage.
            assert.equal(f.element('lineage-block').style.display, 'block', `${label}: bloque visible`);
            assert.equal(f.element('lineage-primaries').textContent, String(lineage.primaries), label);
            assert.equal(f.element('lineage-leaves').textContent, String(lineage.leaves), label);
            const format = value => Number.isFinite(value) ? value.toFixed(1) : '—';
            for (const key of ['original', 'rest', 'culled', 'censored', 'discarded']) {
                assert.ok(Number.isFinite(lineage.mass[key]), `${label}: masa ${key}`);
                assert.equal(f.element(`lineage-mass-${key}`).textContent, format(lineage.mass[key]), `${label}: masa ${key}`);
            }
            for (const key of ['p50', 'p83', 'p95']) {
                assert.equal(f.element(`lineage-runout-${key}`).textContent, format(lineage.finalRunout && lineage.finalRunout[key]), `${label}: ${key}`);
            }
            for (const [kind, count] of Object.entries(lineage.byKind)) {
                if (count > 0) assert.match(f.element('lineage-by-kind').textContent, new RegExp(`: ${count}(?!\\d)`), `${label}: ${kind}`);
            }

            // CSV de impactos: incluye los eventos de los padres, con su roca original.
            const byId = new Map(rocks.map(k => [k.id, k]));
            const lines = f.app.stats.generateImpactCSV().trim().split('\n');
            assert.match(lines[0], /,Roca original,Tipo de pieza$/, label);
            const body = lines.slice(1).map(line => line.split(','));
            assert.equal(body.length, rocks.reduce((sum, k) => sum + k.impactEvents.length, 0), `${label}: una fila por evento`);
            for (const cells of body) {
                const rock = byId.get(Number(cells[0]));
                assert.equal(cells.length, 16, label);
                assert.equal(cells[14], String(rock.rootId), `${label}: rootId de ${rock.id}`);
                assert.ok(cells[15].length > 0, `${label}: tipo de ${rock.id}`);
            }
            const parentRows = body.filter(cells => byId.get(Number(cells[0])).stopReason === 'fragmented');
            assert.ok(parentRows.length > 0, `${label}: hay filas de padres`);
            assert.ok(parentRows.some(cells => cells[0] !== cells[14]), `${label}: hay padres no primarios con rootId distinto de su id`);
            assert.match(f.app.stats.generateReport(), /Piezas finales/, label);
            assert.match(f.app.stats.generateCSV(), /t medido desde la liberación de la roca original/, label);

            // Conservación de masa: por árbol y en el total publicado.
            assert.ok(lineage.mass.maxRelativeError <= 1e-9, `${label}: error ${lineage.mass.maxRelativeError}`);
            const original = rocks.filter(k => k.parentId === null).reduce((sum, k) => sum + k.mass, 0);
            const leaves = rocks.filter(k => k.stopReason !== 'fragmented').reduce((sum, k) => sum + k.mass, 0);
            const discarded = rocks.reduce((sum, k) => sum + k.discardedMass, 0);
            assert.ok(Math.abs(lineage.mass.original - original) <= 1e-9 * original, label);
            assert.ok(Math.abs(lineage.mass.discarded - discarded) <= 1e-9 * original, label);
            assert.ok(Math.abs(original - leaves - discarded) <= 1e-9 * original, `${label}: masa del conjunto`);
        }
    });
}

// B.4 y arbitraje WB-B3, punto 3: `Tipo de pieza` es primaria, núcleo, principal o esquirla.
test('CSV de impactos: Tipo de pieza usa los 4 nombres del contrato B.4', () => {
    const run = engine('rigid-body', 1000);
    const rocks = source(run, false);
    const f = publish(run, false, rocks);
    const byId = new Map(rocks.map(k => [k.id, k]));
    const seen = new Map();
    for (const line of f.app.stats.generateImpactCSV().trim().split('\n').slice(1)) {
        const cells = line.split(',');
        seen.set(byId.get(Number(cells[0])).fragmentKind, cells[15]);
    }
    assert.ok(seen.size > 1, 'hay más de un tipo de pieza con eventos');
    assert.deepEqual(Object.fromEntries(seen), Object.fromEntries([...seen.keys()].map(kind => [kind, KIND_ES[kind]])));
});

test('linajeInvalido bloquea en ambos caminos', () => {
    const run = engine('rigid-body', 1000);
    for (const worker of [false, true]) {
        const label = worker ? 'worker' : 'normal';
        // El conjunto pasa la validación de la App (ids, padres, bornAt, tipos): solo falla la masa.
        const rocks = source(run, worker);
        rocks.find(r => r.parentId !== null && r.stopReason !== 'fragmented').mass *= 1.01;
        const f = publish(run, worker, rocks);
        assert.doesNotMatch(f.element('simulation-status').textContent, /incompatible/i, `${label}: no es rechazo de protocolo`);
        assert.equal(f.app._resultsValid, false, label);
        assert.match(f.element('simulation-status').textContent, /bloqueados \(linajeInvalido\)/, label);
        assert.notEqual(f.element('lineage-block').style.display, 'block', `${label}: bloque oculto`);
        exportsEnabled(f, false, label);
        const direct = new f.Stats();
        const r = direct.compute(rocks);
        assert.equal(r.status, 'bloqueado', label);
        assert.equal(r.blockedReason, 'linajeInvalido', label);
        assert.equal(Object.hasOwn(r, 'lineage'), false, label);
    }
});
