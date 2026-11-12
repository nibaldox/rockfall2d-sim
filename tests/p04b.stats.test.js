'use strict';

/**
 * P0.4 parte B (B1): Stats con dos poblaciones.
 * - I4: sin fragmentación, `results`, CSV e impactos son los de 8bd08df2 salvo X1 y X2.
 * - Con fragmentación: filas envolventes por primaria (oráculo propio), `results.lineage`,
 *   percentil ponderado por masa, censura conservadora y bloqueo `linajeInvalido`.
 * La base se lee con `git show 8bd08df2:js/stats.js` (solo lectura), sin checkout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');

const ROOT = path.resolve(__dirname, '..');
const BASE = '8bd08df28ba22b608e92f6ef34129b9a9c932782';
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const BARRIER = [{ x1: 40, y1: 18, x2: 40, y2: 26, cn: 0.3, ct: 0.5, thickness: 0.2 }];
const plain = x => JSON.parse(JSON.stringify(x));

function stats() {
    const ctx = loadScripts(['js/stats.js'], { extra: { SimRocas: {}, document: undefined } });
    return new ctx.SimRocas.Stats();
}
let baseSource = null;
function baseStats() {
    if (baseSource === null) {
        baseSource = execFileSync('git', ['show', `${BASE}:js/stats.js`], { cwd: ROOT, encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    }
    const ctx = vm.createContext({ SimRocas: {} });
    vm.runInContext(baseSource, ctx, { filename: 'stats.8bd08df2.js' });
    return new ctx.SimRocas.Stats();
}

function engine(o) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: o.seed });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    const params = { numRocks: o.numRocks || 4, animationSpeed: 1, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: !!o.fractureEnergy, fractureEnergy: o.fractureEnergy || 25000, downhillMode: '+x' };
    sim.configure(params);
    physics.calcMethod = o.calcMethod;
    sim.barriers = o.barrier ? BARRIER.map(b => ({ ...b })) : [];
    sim.start(10, 51, 0.5, 2700, 0, 0, 30, false, 'polygon', 1, 'freefall', null);
    let it = 0;
    while (sim.isRunning && it++ < 2000000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida debe terminar');
    return sim.rocks.slice();
}
const RUN_INFO = { timeStep: 0.005, calcMethod: 'rigid-body', cnVariability: 0, ctVariability: 0,
    segments: [{ index: 0, x0: 0, x1: 60, type: 'rock', label: 'Roca', cn: 0.35, ct: 0.85, roughness: 0 },
        { index: 1, x0: 60, x1: 120, type: 'rock', label: 'Roca', cn: 0.35, ct: 0.85, roughness: 0 }] };

// --- 1. I4 -----------------------------------------------------------------
test('I4: sin fragmentación, results, CSV e impactos son los de 8bd08df2 salvo X1 y X2', () => {
    const cases = [...METHODS.map(calcMethod => ({ calcMethod })), { calcMethod: 'rigid-body', barrier: true }];
    let impactRows = 0;
    for (const seed of [12345, 777]) for (const c of cases) {
        const tag = `${c.calcMethod}${c.barrier ? '+barrera' : ''}/${seed}`;
        const rocks = engine({ ...c, seed });
        assert.equal(rocks.some(r => r.stopReason === 'fragmented' || r.parentId !== null), false, tag);
        const info = { ...RUN_INFO, calcMethod: c.calcMethod };
        const now = stats(), old = baseStats();
        const a = now.compute(rocks, { x: 10, y: 51 }, info), b = old.compute(rocks, { x: 10, y: 51 }, info);
        assert.notEqual(b.status, 'bloqueado', tag);
        assert.equal(a.contractVersion, 'P0.4', tag);
        assert.equal(Object.hasOwn(a, 'lineage'), false, `${tag}: la clave lineage no existe`);
        // X2 (arbitraje WB-B3): de cada evento exportable se excluyen SOLO rootId y fragmentKind.
        const strip = r => JSON.stringify({ ...r, contractVersion: undefined,
            impactEvents: r.impactEvents.map(({ rootId, fragmentKind, ...rest }) => rest) });
        for (const e of a.impactEvents) {
            assert.deepEqual(Object.keys(e).slice(-2), ['rootId', 'fragmentKind'], `${tag}: X2 enumerable y al final`);
            assert.equal(e.rootId, e.rockId, tag);
            assert.equal(e.fragmentKind, 'primary', tag);
        }
        assert.equal(strip(a), strip(b), `${tag}: results`);
        assert.deepEqual(Object.keys(a).filter(k => k !== 'contractVersion'), Object.keys(b).filter(k => k !== 'contractVersion'));
        // X1: solo cambia la fila de versión.
        const csvA = now.generateCSV().split('\n'), csvB = old.generateCSV().split('\n');
        assert.equal(csvA.length, csvB.length, tag);
        const diff = csvA.map((line, i) => line === csvB[i] ? null : i).filter(i => i !== null);
        assert.equal(diff.length, 1, `${tag}: una sola fila distinta`);
        assert.equal(csvB[diff[0]], 'Versión del contrato de resultados,P0.2-beta' + ','.repeat(13));
        assert.equal(csvA[diff[0]], 'Versión del contrato de resultados,P0.4' + ','.repeat(13));
        const repA = now.generateReport().split('\n'), repB = old.generateReport().split('\n');
        assert.deepEqual(repA.filter((line, i) => line !== repB[i]), ['Versión del contrato de resultados: P0.4'], tag);
        // X2: las 14 columnas anteriores quedan igual; se agregan 2 al final.
        const impA = now.generateImpactCSV().trimEnd().split('\n'), impB = old.generateImpactCSV().trimEnd().split('\n');
        assert.equal(impA.length, impB.length, tag);
        assert.equal(impA[0], impB[0] + ',Roca original,Tipo de pieza', tag);
        for (let i = 1; i < impA.length; i++) {
            const rockId = impB[i].split(',')[0];
            assert.equal(impA[i], `${impB[i]},${rockId},primaria`, `${tag}: fila ${i}`);
            impactRows++;
        }
    }
    assert.ok(impactRows > 0, 'la comparación de impactos no es vacua');
});

// --- 2. Con fragmentación ----------------------------------------------------
const MAX_FIELDS = ['maxKineticEnergy', 'maxImpactVelocity', 'maxImpactNormalSpeed', 'maxImpactSpeed',
    'maxImpactEnergy', 'maxFlightHeight', 'maxBounceHeight'];
// Oráculo independiente del §B.1.
function oracle(rocks) {
    const groups = new Map();
    for (const r of rocks) {
        if (!groups.has(r.rootId)) groups.set(r.rootId, []);
        groups.get(r.rootId).push(r);
    }
    const rows = [];
    for (const [rootId, list] of groups) {
        const root = list.find(r => r.id === rootId);
        const leaves = list.filter(r => r.stopReason !== 'fragmented');
        let rep = leaves[0];
        for (const leaf of leaves) {
            if (leaf.maxDownhillAdvance > rep.maxDownhillAdvance ||
                (leaf.maxDownhillAdvance === rep.maxDownhillAdvance && leaf.id < rep.id)) rep = leaf;
        }
        const late = leaves.find(r => r.stopReason === 'maxTime' || r.stopReason === 'maxSteps');
        const row = { id: root.id, rootId, mass: root.mass, releaseX: root.releaseX, releaseY: root.releaseY,
            sourceIndex: root.sourceIndex, downhillSign: root.downhillSign, finalX: rep.finalX, finalY: rep.finalY,
            stopReason: rep.stopReason === 'rest' && late ? late.stopReason : rep.stopReason,
            maxDownhillAdvance: Math.max(...list.map(r => r.maxDownhillAdvance)),
            bounces: list.reduce((s, r) => s + r.bounces, 0), impactCount: list.reduce((s, r) => s + r.impactCount, 0),
            representativeId: rep.id, representativeMass: rep.mass, treeSize: list.length, leafCount: leaves.length };
        for (const key of MAX_FIELDS) row[key] = Math.max(...list.map(r => r[key]));
        rows.push(row);
    }
    return rows;
}

function checkFragmented(rocks, tag) {
    const s = stats();
    const r = s.compute(rocks, { x: 10, y: 51 }, RUN_INFO);
    const expected = oracle(rocks);
    assert.equal(r.blockedReason, null, `${tag}: no hay bloqueo`);
    assert.notEqual(r.status, 'bloqueado', tag);
    assert.equal(r.contractVersion, 'P0.4');
    assert.equal(r.totalRocks, expected.length, `${tag}: N = primarias`);
    assert.equal(r.population.released, expected.length);
    assert.equal(r.population.byReason.fragmented, 0, `${tag}: ninguna fila envolvente es fragmented`);
    assert.equal(r.reachBounds.n, expected.length);
    assert.ok(r.warnings.some(w => w.code === 'fragmentacion' && /envolvente/.test(w.message)), tag);
    const rows = s.buildLineage(rocks).rows;
    assert.equal(rows.length, expected.length);
    rows.forEach((row, i) => {
        for (const [key, value] of Object.entries(expected[i])) {
            assert.equal(row[key], value, `${tag}: fila ${expected[i].id}, campo ${key}`);
        }
    });
    assert.deepEqual(plain(r.restRocks.map(x => x.id)), expected.filter(x => x.stopReason === 'rest').map(x => x.id));
    const L = r.lineage;
    const leaves = rocks.filter(x => x.stopReason !== 'fragmented');
    assert.equal(L.primaries, expected.length);
    assert.equal(L.entities, rocks.length);
    assert.equal(L.leaves, leaves.length);
    assert.equal(L.maxGeneration, Math.max(...rocks.map(x => x.generation)));
    assert.equal(Object.values(L.byKind).reduce((a, b) => a + b, 0), leaves.length);
    assert.equal(Object.values(L.byReason).reduce((a, b) => a + b, 0), leaves.length);
    const original = expected.reduce((sum, x) => sum + x.mass, 0);
    assert.ok(Math.abs(L.mass.original - original) <= 1e-9 * original);
    const parts = L.mass.rest + L.mass.culled + L.mass.censored + L.mass.discarded;
    assert.ok(Math.abs(parts - L.mass.original) / L.mass.original <= 1e-9, `${tag}: conserva la masa`);
    assert.ok(L.mass.maxRelativeError <= 1e-9);
    assert.equal(L.discardedByTree.length, expected.length);
    assert.equal(L.finalRunout.n, leaves.filter(x => x.stopReason === 'rest').length);
    // Eventos de los padres fragmentados en el CSV de impactos.
    const parents = rocks.filter(x => x.stopReason === 'fragmented' && x.impactEvents.length > 0);
    assert.ok(parents.length > 0, `${tag}: hay padres con eventos`);
    const lines = s.generateImpactCSV().trimEnd().split('\n').slice(1).map(line => line.split(','));
    assert.equal(lines.length, rocks.reduce((sum, x) => sum + x.impactEvents.length, 0));
    for (const parent of parents) {
        const own = lines.filter(cells => cells[0] === String(parent.id));
        assert.equal(own.length, parent.impactEvents.length);
        assert.equal(own[0][1], 'fragmentación');
        assert.equal(own[0][14], String(parent.rootId));
        assert.equal(own[0].length, 16);
    }
    // Filas nuevas del CSV general: al final y nunca de largo 14.
    const exportRows = s.exportRows();
    const conventions = exportRows.findIndex(row => row[0] === 'Convenciones');
    const added = exportRows.slice(conventions + 1);
    assert.ok(added.length > 5, tag);
    for (const row of added) {
        assert.notEqual(row.length, 14);
        assert.ok(!(row.length === 15 && row[1] === null));
    }
    assert.ok(s.generateCSV().trimEnd().split('\n').every(line => line.split(',').length >= 15));
    const report = s.generateReport();
    assert.match(report, /\nPiezas finales: /);
    assert.match(report, /t medido desde la liberación de la roca original/);
    assert.doesNotMatch(report.split('\nPiezas finales: ')[1], /cota inferior=|desviación=|undefined|NaN/);
    return r;
}

test('fragmentación real en rígido a 1000 J y a 500 J: envolventes, linaje y masa', () => {
    for (const fractureEnergy of [1000, 500]) {
        const rocks = engine({ calcMethod: 'rigid-body', seed: 12345, numRocks: 5, fractureEnergy });
        assert.ok(rocks.some(r => r.stopReason === 'fragmented'), `a ${fractureEnergy} J hay fragmentación`);
        checkFragmented(rocks, `rígido ${fractureEnergy} J`);
    }
});

test('sonda en masa concentrada a 500 J', () => {
    const rocks = engine({ calcMethod: 'lumped-mass', seed: 12345, numRocks: 4, fractureEnergy: 500 });
    const s = stats();
    if (rocks.some(r => r.stopReason === 'fragmented')) {
        checkFragmented(rocks, 'masa concentrada 500 J');
    } else {
        const r = s.compute(rocks, { x: 10, y: 51 }, { ...RUN_INFO, calcMethod: 'lumped-mass' });
        assert.equal(r.blockedReason, null);
        assert.equal(Object.hasOwn(r, 'lineage'), false);
    }
});

// --- Casos sintéticos ---------------------------------------------------------
function rock(overrides = {}) {
    return { id: 1, parentId: null, rootId: 1, fragmentKind: 'primary', bornAt: 0, discardedMass: 0, mass: 10,
        releaseX: 10, releaseY: 40, finalX: 30, finalY: 20, sourceIndex: 0,
        downhillSign: 1, maxDownhillAdvance: 20, cullBoundary: null, stopReason: 'rest',
        isResting: true, isCore: false, generation: 0, maxKineticEnergy: 1000,
        maxBounceHeight: 2, maxImpactVelocity: 4, bounces: 3, impactEnergies: [],
        impactCount: 0, maxImpactNormalSpeed: 0, maxImpactSpeed: 0, maxImpactContactSpeed: 0,
        maxImpactEnergy: 0, maxFlightHeight: 1.5, impactEvents: [], droppedImpactEvents: 0,
        ...overrides };
}
const child = (id, mass, finalX, overrides = {}) => rock({ id, parentId: 1, rootId: 1, fragmentKind: 'spall', generation: 1,
    mass, finalX, maxDownhillAdvance: finalX - 10, ...overrides });
function family(childOverrides = {}) {
    return [rock({ stopReason: 'fragmented', isResting: false, finalX: 15, maxDownhillAdvance: 5, maxKineticEnergy: 9000 }),
        child(2, 1, 20), child(3, 6, 30, { fragmentKind: 'major' }), child(4, 3, 40, childOverrides)];
}

test('percentil ponderado por masa: oráculo a mano con pesos distintos', () => {
    const s = stats();
    const r = s.compute(family());
    assert.equal(r.blockedReason, null);
    // Alcances 10, 20 y 30 m con masas 1, 6 y 3 kg (W = 10): acumuladas 1, 7 y 10.
    assert.deepEqual(plain(r.lineage.finalRunout), { n: 3, massTotal: 10, p10: 10, p50: 20, p83: 30, p95: 30, max: 30 });
    assert.deepEqual(plain(r.lineage.byKind), { spall: 2, major: 1 });
    assert.deepEqual(plain(r.lineage.byReason), { rest: 3 });
    assert.deepEqual(plain(r.lineage.mass), { original: 10, rest: 10, culled: 0, censored: 0, discarded: 0, maxRelativeError: 0 });
    assert.deepEqual(plain(r.lineage.discardedByTree), [{ rootId: 1, discarded: 0, fraction: 0 }]);
    assert.equal(s.weightedPercentile([[5, 2], [7, 2]], 50), 5);
    assert.equal(s.weightedPercentile([], 50), null);
    // Fila envolvente: representante = hoja de mayor avance; energía = máximo del árbol.
    assert.equal(r.totalRocks, 1);
    assert.equal(r.restRocks.length, 1);
    const row = r.restRocks[0];
    assert.deepEqual([row.id, row.mass, row.finalX, row.representativeId, row.representativeMass, row.treeSize, row.leafCount,
        row.maxDownhillAdvance, row.maxKineticEnergy, row.bounces], [1, 10, 40, 4, 3, 4, 3, 30, 9000, 12]);
    assert.equal(r.finalRunout.max, 30);
    assert.equal(r.kineticEnergy.max, 9);
    // Empate de avance: gana el menor id.
    const tie = stats();
    tie.compute([family()[0], child(2, 1, 40), child(3, 6, 30), child(4, 3, 40)]);
    assert.equal(tie.results.restRocks[0].representativeId, 2);
});

test('sentido no resuelto: lineage.finalRunout va null', () => {
    const r = stats().compute(family().map(x => ({ ...x, downhillSign: null, maxDownhillAdvance: null })));
    assert.equal(r.blockedReason, null);
    assert.equal(r.lineage.finalRunout, null);
});

test('censura conservadora: representante en reposo y otra hoja en maxTime', () => {
    const rocks = family();
    rocks[1] = child(2, 1, 20, { stopReason: 'maxTime', isResting: false });
    const r = stats().compute(rocks);
    assert.equal(r.blockedReason, null);
    assert.equal(r.status, 'parcial');
    assert.deepEqual(plain(r.population.byReason), { rest: 0, culled: 0, maxTime: 1, maxSteps: 0, fragmented: 0, cancelled: 0, safetyLimit: 0 });
    assert.equal(r.restRocks.length, 0);
    assert.deepEqual(plain(r.reachBounds.max), { lower: 30, exact: false });
    assert.equal(r.lineage.mass.censored, 1);
    assert.equal(r.lineage.mass.rest, 9);
    assert.ok(r.warnings.some(w => w.code === 'censura'));
});

test('masaDescartada: advertencia si un árbol descarta más del 1 %', () => {
    const rocks = family();
    rocks[0].discardedMass = 0.5;
    rocks[3] = child(4, 2.5, 40);
    const r = stats().compute(rocks);
    assert.equal(r.blockedReason, null);
    assert.deepEqual(plain(r.lineage.discardedByTree), [{ rootId: 1, discarded: 0.5, fraction: 0.05 }]);
    assert.equal(r.lineage.mass.discarded, 0.5);
    assert.ok(r.warnings.some(w => w.code === 'masaDescartada'));
    assert.equal(stats().compute(family()).warnings.some(w => w.code === 'masaDescartada'), false);
});

test('linajeInvalido: fragmented sin hijos, raíz ausente o masa no conservada bloquean', () => {
    const cases = {
        'fragmented sin hijos': [rock({ stopReason: 'fragmented', isResting: false }), rock({ id: 2, rootId: 2 })],
        'raíz ausente': family().slice(1),
        'masa no conservada': [...family().slice(0, 3), child(4, 2, 40)],
        'padre no resoluble': [...family().slice(0, 3), child(4, 3, 40, { parentId: 99 })],
        'padre no fragmentado': [...family(), child(5, 0, 50, { parentId: 2 })],
        'id duplicado': [...family(), child(4, 0, 40)]
    };
    for (const [name, rocks] of Object.entries(cases)) {
        const s = stats();
        const r = s.compute(rocks, null, { timeStep: 0.05, calcMethod: 'rigid-body' });
        assert.equal(r.status, 'bloqueado', name);
        assert.equal(r.blockedReason, 'linajeInvalido', name);
        assert.equal(Object.hasOwn(r, 'lineage'), false, name);
        assert.equal(r.finalRunout, null, name);
        assert.equal(s.generateImpactCSV(), null, name);
        assert.equal(r.warnings.some(w => w.code === 'fragmentacion'), false, name);
    }
    // Prioridad: el linaje inválido gana a la censura no publicable, como antes la fragmentación.
    const r = stats().compute([rock({ stopReason: 'fragmented' }), rock({ id: 2, rootId: 2, stopReason: 'cancelled' })]);
    assert.equal(r.blockedReason, 'linajeInvalido');
});
