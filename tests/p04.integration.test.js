'use strict';

/**
 * Integración P0.4, parte A (I7): motor → serializeRocks → validación por roca
 * y de conjunto (App) → Stats, en el camino normal y en el del Worker.
 *
 * Contrafactual: la misma cadena se ejecuta contra una copia de scratch de
 * P0.2-β (`git archive 18e4a1c3` en exec/I7/p02b), con su motor, su worker,
 * su App y su Stats. Nada se sustituye por dobles salvo el DOM.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const C = '/home/xodla/.hermes/profiles/rocxkfall/reports/rockfall-p0';
const CANDIDATE = process.env.P04_ROOT || path.resolve(__dirname, '..');
const BASELINE = process.env.P02B_ROOT || path.join(C, 'exec', 'I7', 'p02b');
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const BARRIER = [{ x1: 40, y1: 18, x2: 40, y2: 26, cn: 0.3, ct: 0.5, thickness: 0.2 }];
const SEED = 12345;
// Carga acotada (I7b): pocas rocas por caso para no competir por CPU con el resto de la suite.
const ROCKS = Number(process.env.P04_ROCKS) || 4;
const FRAG_ROCKS = Number(process.env.P04_FRAG_ROCKS) || 3;

// Adaptadores reales de cada árbol (candidato o P0.2-β), cargados desde su raíz.
function adapters(root) {
    const tests = path.join(root, 'tests');
    const load = require(path.join(tests, 'helpers', 'load.js'));
    const lifecycle = path.join(tests, 'app.lifecycle.test.js');
    const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0];
    const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), tests);
    const parity = path.join(tests, 'worker.parity.test.js');
    const workerSource = fs.readFileSync(parity, 'utf8').split('// --- Paridad (protocolo')[0];
    const { runWorker } = new Function('require', '__dirname', workerSource + '\nreturn { runWorker };')(createRequire(parity), tests);
    return { load, fixture, runWorker };
}

function engine(root, o) {
    const a = adapters(root);
    const ctx = a.load.loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: SEED });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    const maxDuration = o.maxDuration || 30;
    const params = { numRocks: o.numRocks || ROCKS, animationSpeed: 1, timeStep: 0.005, maxDuration,
        fragmentationEnabled: !!o.fragmentation, fractureEnergy: o.fragmentation ? 500 : 25000, downhillMode: '+x' };
    const args = [10, 51, 0.5, 2700, 0, 0, maxDuration, false, 'polygon', 1, 'freefall', null];
    const barriers = o.barrier ? BARRIER.map(b => ({ ...b })) : [];
    sim.configure(params);
    physics.calcMethod = o.calcMethod;
    sim.barriers = barriers;
    sim.start(...args);
    let it = 0;
    while (sim.isRunning && it++ < 400000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida normal debe terminar');
    const messages = a.runWorker({ type: 'start', terrainJSON: terrain.toJSON(), simParams: params,
        physicsParams: { calcMethod: o.calcMethod }, barriers, startArgs: args });
    const complete = messages.find(m => m.type === 'complete');
    assert.ok(complete, 'el worker real debe completar: ' + JSON.stringify(messages.find(m => m.type === 'error')));
    assert.equal(complete.status, 'completed');
    // Copia de la lista: la App reasigna `sim.rocks` al publicar.
    return { a, terrain, physics, sim, rocks: sim.rocks.slice(), complete };
}

// Publica en la App real (validación por roca y de conjunto) con el Stats real.
function publish(run, worker, rocks) {
    const f = run.a.fixture(false);
    f.app.terrain = run.terrain;
    f.app.physics = run.physics;
    f.app.simulation = run.sim;
    f.app.releasePoint = { x: 10, y: 51 };
    f.app.stats = new f.Stats();
    f.app._completeRun(rocks || (worker ? structuredClone(run.complete.rocks) : run.rocks), 'completed', worker);
    return f;
}

// `results.restRocks` guarda las rocas de entrada tal cual, así que en P0.4 llevan
// los 4 campos nuevos del §2. Es la única diferencia admitida: se quitan de la
// comparación y `lineage` cuenta cuántos se quitaron, para que no sea vacuo.
const LINEAGE = ['rootId', 'fragmentKind', 'bornAt', 'discardedMass'];
function outputs(f) {
    let lineage = 0;
    return {
        valid: f.app._resultsValid,
        results: JSON.stringify(f.app.stats.results, (key, value) => {
            if (!LINEAGE.includes(key)) return value;
            lineage++;
            return undefined;
        }),
        get lineage() { return lineage; },
        csv: f.app.stats.generateCSV(),
        impacts: f.app.stats.generateImpactCSV()
    };
}

// Reconstruye el árbol desde las raíces y devuelve el balance de masa por primaria.
function trees(rocks) {
    const byId = new Map();
    for (const r of rocks) {
        assert.ok(!byId.has(r.id), `id duplicado: ${r.id}`);
        byId.set(r.id, r);
    }
    const children = new Map();
    for (const r of rocks) {
        if (r.parentId === null) continue;
        assert.ok(byId.has(r.parentId), `parentId inexistente: ${r.parentId}`);
        if (!children.has(r.parentId)) children.set(r.parentId, []);
        children.get(r.parentId).push(r);
    }
    const roots = rocks.filter(r => r.parentId === null);
    const seen = new Set();
    const balance = [];
    for (const root of roots) {
        assert.equal(root.fragmentKind, 'primary');
        assert.equal(root.rootId, root.id);
        assert.equal(root.bornAt, 0);
        let leaves = 0, discarded = 0, nodes = 0;
        const stack = [root];
        while (stack.length) {
            const r = stack.pop();
            assert.ok(!seen.has(r.id), `nodo alcanzado dos veces: ${r.id}`);
            seen.add(r.id); nodes++;
            assert.equal(r.rootId, root.id, `rootId de ${r.id}`);
            discarded += r.discardedMass;
            const kids = children.get(r.id) || [];
            if (r !== root) {
                const parent = byId.get(r.parentId);
                assert.equal(parent.stopReason, 'fragmented', `padre de ${r.id}`);
                assert.ok(['core', 'major', 'spall'].includes(r.fragmentKind), `tipo de ${r.id}`);
                assert.ok(r.bornAt > 0 && r.bornAt <= parent.elapsedTime + 1e-12, `bornAt de ${r.id}`);
                assert.ok(r.elapsedTime >= r.bornAt, `reloj heredado de ${r.id}`);
            }
            if (kids.length) assert.equal(r.stopReason, 'fragmented', `nodo interno ${r.id}`);
            if (r.stopReason !== 'fragmented') leaves += r.mass;
            else assert.ok(kids.length > 0, `fragmentado sin hijos: ${r.id}`);
            stack.push(...kids);
        }
        balance.push({ root, leaves, discarded, nodes });
    }
    assert.equal(seen.size, rocks.length, 'todas las entidades cuelgan de una raíz');
    return balance;
}

// --- 1. Sin fragmentación: Stats y CSV idénticos a P0.2-β ----------------------

for (const calcMethod of METHODS) {
    for (const barrier of [false, true]) {
        test(`sin fragmentación, Stats y CSV idénticos a P0.2-β: ${calcMethod}, barrera=${barrier}`, () => {
            const o = { calcMethod, barrier, fragmentation: false };
            const now = engine(CANDIDATE, o);
            const old = engine(BASELINE, o);
            assert.equal(now.rocks.length, ROCKS);
            for (const worker of [false, true]) {
                const label = worker ? 'worker' : 'normal';
                const a = outputs(publish(now, worker));
                const b = outputs(publish(old, worker));
                assert.equal(a.valid, true, `${label}: publica`);
                assert.equal(b.valid, true, `${label}: β publica`);
                assert.equal(a.results, b.results, `${label}: resultados de Stats`);
                assert.equal(a.lineage, 4 * JSON.parse(a.results).restRocks.length, `${label}: solo linaje en restRocks`);
                assert.equal(b.lineage, 0, `${label}: β sin linaje`);
                assert.equal(a.csv, b.csv, `${label}: CSV general`);
                assert.equal(a.impacts, b.impacts, `${label}: CSV de impactos`);
                // No vacuo: hay estadística publicada y eventos de impacto exportados.
                assert.notEqual(JSON.parse(a.results).blockedReason, 'fragmentacion');
                assert.equal(JSON.parse(a.results).totalRocks, ROCKS);
                assert.equal(typeof a.impacts, 'string');
                assert.ok(a.impacts.split('\n').length > ROCKS, `${label}: filas de impactos`);
            }
            if (barrier) {
                const events = now.rocks.flatMap(r => r.impactEvents);
                assert.ok(events.some(e => e.surface === 'barrier'), 'la barrera recibe impactos');
            }
        });
    }
}

// --- 2. Con fragmentación a 500 J ---------------------------------------------

for (const calcMethod of ['rigid-body', 'lumped-mass']) {
    test(`fragmentación a 500 J: conjunto válido, árbol, masa y bloqueo D5: ${calcMethod}`, () => {
        const run = engine(CANDIDATE, { calcMethod, fragmentation: true, numRocks: FRAG_ROCKS });
        for (const worker of [false, true]) {
            const label = worker ? 'worker' : 'normal';
            const source = worker ? run.complete.rocks : run.rocks;
            assert.ok(source.length > FRAG_ROCKS, `${label}: hubo fragmentación`);
            assert.ok(source.some(r => r.stopReason === 'fragmented'), `${label}: hay padres fragmentados`);

            // Validación por roca y de conjunto: la App conserva el conjunto entero.
            const f = publish(run, worker);
            assert.equal(f.app.simulation.rocks.length, source.length, `${label}: conjunto aceptado`);
            assert.doesNotMatch(f.element('simulation-status').textContent, /incompatible/i, label);

            // Árbol reconstruido desde las raíces y masa conservada con discardedMass.
            const balance = trees(source);
            assert.equal(balance.length, FRAG_ROCKS, `${label}: una raíz por primaria`);
            assert.ok(balance.some(b => b.nodes > 1), `${label}: árboles con descendencia`);
            for (const b of balance) {
                if (b.nodes === 1) continue;
                const error = Math.abs(b.root.mass - (b.leaves + b.discarded)) / b.root.mass;
                assert.ok(error <= 1e-9, `${label}: masa del árbol ${b.root.id}, error ${error}`);
            }

            // D5: Stats sigue bloqueando por fragmentación (parte B pendiente).
            const results = f.app.stats.results;
            assert.equal(f.app._resultsValid, false, `${label}: no publica`);
            if (results) {
                assert.equal(results.status, 'bloqueado', label);
                assert.equal(results.blockedReason, 'fragmentacion', label);
            }
            const blocked = new f.Stats();
            blocked.compute(source);
            assert.equal(blocked.results.status, 'bloqueado', label);
            assert.equal(blocked.results.blockedReason, 'fragmentacion', label);
            assert.equal(blocked.generateImpactCSV(), null, `${label}: sin CSV de impactos`);
        }
    });
}

// --- 3. Rechazo de un conjunto real mutado --------------------------------------

test('conjunto real mutado (id duplicado, parentId roto y reglas E1.3) se rechaza en ambos caminos', () => {
    const run = engine(CANDIDATE, { calcMethod: 'rigid-body', fragmentation: true, numRocks: FRAG_ROCKS });
    const mutations = {
        'id duplicado': rocks => {
            const child = rocks.find(r => r.parentId !== null);
            const other = rocks.find(r => r.parentId !== null && r !== child);
            other.id = child.id;
        },
        'parentId roto': rocks => {
            const child = rocks.find(r => r.parentId !== null);
            child.parentId = Math.max(...rocks.map(r => r.id)) + 1000;
        },
        // E1.3: las tres reglas nuevas sobre el conjunto real.
        'fragmented sin hijos': rocks => {
            const inner = new Set(rocks.filter(r => r.parentId !== null).map(r => r.parentId));
            const victim = rocks.find(r => inner.has(r.id) && rocks.every(k => k.parentId !== r.id || !inner.has(k.id)));
            for (let i = rocks.length - 1; i >= 0; i--) if (rocks[i].parentId === victim.id) rocks.splice(i, 1);
        },
        'bornAt incoherente': rocks => {
            rocks.find(r => r.parentId !== null).bornAt += 1e-6;
        },
        'fragmentKind incoherente': rocks => {
            rocks.find(r => r.fragmentKind === 'spall').fragmentKind = 'core';
        }
    };
    for (const worker of [false, true]) {
        const source = () => worker ? structuredClone(run.complete.rocks) : run.rocks.map(r => Object.assign(Object.create(Object.getPrototypeOf(r)), r));
        // Control: la misma copia, sin mutar, se acepta entera.
        const control = source();
        const ok = publish(run, worker, control);
        assert.equal(ok.app.simulation.rocks.length, control.length, 'control aceptado');
        assert.doesNotMatch(ok.element('simulation-status').textContent, /incompatible/i);
        for (const [name, mutate] of Object.entries(mutations)) {
            const label = `${name}, ${worker ? 'worker' : 'normal'}`;
            const rocks = source();
            mutate(rocks);
            const f = publish(run, worker, rocks);
            assert.equal(f.app._resultsValid, false, label);
            assert.match(f.element('simulation-status').textContent, /incompatible/i, label);
            assert.equal(f.app.simulation.rocks.length, 0, `${label}: modelo sin rocas`);
            assert.equal(f.app.simulation.frames.length, 0, `${label}: modelo sin frames`);
        }
    }
});
