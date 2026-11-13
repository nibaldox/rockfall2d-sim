'use strict';

/**
 * Integración productor-consumidor de P0.2-β (I5).
 *
 * Cadena real, sin dobles: motor (physics.js + simulation.js) dentro de
 * worker.js → serializeRocks → App._completeRun (isCompatibleResultRock) →
 * Stats.compute con runInfo → exportRows, generateCSV, generateImpactCSV y
 * los gráficos del renderer.
 *
 * Contrafactual de I1: physics.js, worker.js y stats.js de P0.3 se leen con
 * `git show 67b34e52:` (solo lectura) y se cargan en un contexto aparte.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { loadScripts, createContext, runScript } = require('./helpers/load');

const ROOT = path.join(__dirname, '..');
const P03 = '67b34e52';
const SEED = 12345;
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0];
const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), __dirname);

const IMPACT_HEADER = 'Roca,Motivo de término,Tiempo (s),X centro (m),Y centro (m),Superficie,Tramo o barrera,' +
    'Velocidad normal (m/s),Rapidez (m/s),Rapidez del punto de contacto (m/s),Energía total (kJ),' +
    'Coef. normal efectivo,Coef. tangencial efectivo,Altura de vuelo previa (m),Roca original,Tipo de pieza';
const EVENT_KEYS = ['t', 'x', 'y', 'surface', 'index', 'vn', 'speed', 'contactSpeed', 'energy', 'cnEff', 'ctEff', 'flightHeightBefore'];
const chartIds = ['chart-energy-hist', 'chart-energy-distance', 'chart-accumulation',
    'chart-bounce-distance', 'chart-velocity-distance', 'chart-runout-dist'];

// Caso base: talud de 60 m a 45°, plataforma, barrera en la plataforma.
const POINTS = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 200, y: 0 }];
const BARRIER = { x1: 75, y1: 0, x2: 75, y2: 6, cn: 0.5, ct: 0.4, thickness: 0.15 };
const RELEASE = { x: 10, y: 52 };

const p03Cache = {};
function p03Source(file) {
    if (!p03Cache[file]) {
        p03Cache[file] = execFileSync('git', ['show', `${P03}:${file}`],
            { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
    }
    return p03Cache[file];
}

// Perfil largo para I1 sin barrera (E2.2): la plataforma llega a x=LONG_END
// para que ninguna roca impacte sobre la prolongación del perfil.
const LONG_END = 3000;
const LONG_POINTS = [POINTS[0], POINTS[1], { x: LONG_END, y: 0 }];

function makeTerrain(points = POINTS) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: SEED });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.addPoint(points[0].x, points[0].y, 'roca-dura');
    terrain.addPoint(points[1].x, points[1].y, 'roca-dura');
    terrain.addPoint(points[2].x, points[2].y, 'suelo');
    const physics = new ctx.SimRocas.PhysicsEngine();
    return { terrain, physics, sim: new ctx.SimRocas.Simulation(terrain, physics) };
}

// Worker real en un contexto vm; `p03` sustituye physics.js y worker.js por los de P0.3.
function runWorker(options = {}) {
    const { terrain } = makeTerrain(options.points);
    const simParams = { numRocks: options.count || 20, animationSpeed: 50, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: false, cn: options.cn === undefined ? 0.6 : options.cn,
        ct: options.ct === undefined ? 0.4 : options.ct,
        cnVariability: options.cnVariability || 0, ctVariability: options.ctVariability || 0, downhillMode: 'auto' };
    const physicsParams = { calcMethod: options.method || 'rigid-body' };
    const messages = [];
    let ctx;
    ctx = createContext({ env: 'worker', seed: SEED, extra: {
        postMessage: m => messages.push(m),
        importScripts: (...files) => files.forEach(f => {
            if (options.p03 && f === 'physics.js') vm.runInContext(p03Source('js/physics.js'), ctx, { filename: 'p03-physics.js' });
            else runScript(ctx, 'js/' + f);
        })
    } });
    if (options.p03) vm.runInContext(p03Source('js/worker.js'), ctx, { filename: 'p03-worker.js' });
    else runScript(ctx, 'js/worker.js');
    ctx.onmessage({ data: { type: 'start', terrainJSON: terrain.toJSON(), simParams, physicsParams,
        barriers: options.barrier === false ? [] : [{ ...BARRIER }],
        startArgs: [RELEASE.x, RELEASE.y, 0.5, 2700, 0, 0, 30, false, 'sphere', 0.6, 'freefall', null] } });
    const complete = messages.find(m => m.type === 'complete');
    assert.ok(complete, 'el worker real debe completar');
    assert.equal(complete.status, 'completed');
    return { rocks: complete.rocks, simParams, physicsParams };
}

// App real con Stats y Renderer reales; publica por el camino del worker.
function publish(run, mutate) {
    const f = fixture(false);
    for (const id of ['histogram', 'canvas', ...chartIds]) {
        const e = f.element(id);
        e.width = 600; e.height = 300;
        e.parentElement = { clientWidth: 600, clientHeight: 330, querySelector: () => null };
        e.calls = [];
        const context = new Proxy({ measureText: text => ({ width: String(text).length * 6 }) }, {
            get(target, key) { return key in target ? target[key] : (...args) => e.calls.push([key, ...args]); }
        });
        e.getContext = () => context;
    }
    const document = { documentElement: {}, getElementById: f.element };
    const rc = loadScripts(['js/renderer.js'], { extra: { SimRocas: {}, document,
        getComputedStyle: () => ({ getPropertyValue: () => '' }) } });
    const world = makeTerrain();
    world.sim.configure(run.simParams);
    Object.assign(world.physics, run.physicsParams);
    const appNamespace = f.Stats.constructor('return SimRocas')();
    appNamespace.TerrainPresets = loadScripts(['js/terrain.js'], { env: 'browser' }).SimRocas.TerrainPresets;
    f.app.terrain = world.terrain;
    f.app.physics = world.physics;
    f.app.simulation = world.sim;
    f.app.releasePoint = { ...RELEASE };
    f.app.stats = new f.Stats();
    f.app.renderer = new rc.SimRocas.Renderer(f.element('canvas'), world.terrain);
    f.app.histogramCanvas = f.element('histogram');
    // Misma captura por época que hace App al iniciar la corrida (§4).
    f.app._runInfo = { epoch: f.app._runEpoch, timeStep: world.physics.dt, calcMethod: world.physics.calcMethod,
        cnVariability: world.physics.cnVariability, ctVariability: world.physics.ctVariability,
        segments: appNamespace.copyRunSegments(world.terrain) };
    if (mutate) mutate(run.rocks);
    f.app._completeRun(run.rocks, 'completed', true);
    return f;
}

const text = e => e.calls.filter(c => c[0] === 'fillText').map(c => String(c[1]));
// Texto y no arreglos: las rocas vienen de otro contexto vm y deepEqual compara prototipos.
const finalXs = rocks => JSON.stringify(Array.from(rocks, r => r.finalX));
// Eventos de terreno cuyo centro queda a menos de `margin` del extremo del perfil o más allá.
const offProfileEvents = (run, points = POINTS, margin = 0) => Array.from(run.rocks).flatMap(r =>
    Array.from(r.impactEvents).filter(e => e.surface === 'terrain' &&
        !(e.x >= points[0].x + margin && e.x <= points[2].x - margin)));

for (const method of METHODS) {
    test(`caso base ${method}: motor → worker → barrera → Stats → exportaciones y vistas`, () => {
        const run = runWorker({ method });
        const rocks = run.rocks;
        assert.equal(rocks.length, 20);
        // Productor: los 8 campos del §2 con sus reglas, sobre rocas reales.
        for (const r of rocks) {
            assert.ok(Number.isInteger(r.impactCount) && r.impactCount >= 0);
            assert.equal(r.droppedImpactEvents, r.impactCount - r.impactEvents.length);
            assert.ok(r.impactEvents.length <= 200);
            for (const e of r.impactEvents) {
                assert.deepEqual(Object.keys(e).sort(), [...EVENT_KEYS].sort());
                assert.ok(e.vn >= 0.5, 'umbral C1');
                if (method === 'lumped-mass' || e.surface === 'barrier') assert.equal(e.contactSpeed, null);
            }
            if (r.impactCount === 0) assert.equal(r.maxImpactNormalSpeed, null);
            else assert.ok(r.maxImpactNormalSpeed >= Math.max(...r.impactEvents.map(e => e.vn)) - 1e-12 || r.droppedImpactEvents > 0);
        }
        assert.ok(rocks.some(r => r.impactEvents.some(e => e.surface === 'terrain')), 'hay impactos de terreno');
        assert.ok(rocks.some(r => r.impactEvents.some(e => e.surface === 'barrier' && e.index === 0)), 'hay impactos de barrera');

        // Barrera de App: todas las rocas reales pasan y se publica.
        const f = publish(run);
        const results = f.app.stats.results;
        assert.ok(results, 'Stats publica');
        assert.doesNotMatch(f.element('simulation-status').textContent, /incompatible/);
        assert.notEqual(results.status, 'bloqueado');
        assert.equal(results.contractVersion, 'P0.5');
        assert.equal(f.element('btn-export-impacts').disabled, false);

        // Agregados β sobre la población en reposo.
        const rest = rocks.filter(r => r.stopReason === 'rest');
        assert.ok(rest.length > 0, 'hay rocas en reposo');
        const max = (key, scale = 1) => {
            const values = rest.map(r => r[key]).filter(v => v !== null);
            return values.length ? Math.max(...values) * scale : null;
        };
        assert.equal(results.impactCount.max, max('impactCount'));
        assert.equal(results.impactNormalSpeed.max, max('maxImpactNormalSpeed'));
        assert.equal(results.impactSpeed.max, max('maxImpactSpeed'));
        assert.ok(Math.abs(results.impactEnergy.max - max('maxImpactEnergy', 1 / 1000)) < 1e-9);
        assert.equal(results.flightHeight.max, max('maxFlightHeight'));

        // runInfo ampliado y filas de exportación.
        assert.equal(results.runInfo.calcMethod, method);
        assert.equal(results.runInfo.cnVariability, 0);
        assert.equal(results.runInfo.segments.length, 2);
        assert.deepEqual(JSON.parse(JSON.stringify(results.runInfo.segments[1])),
            { index: 1, x0: 60, x1: 200, type: 'suelo', label: results.runInfo.segments[1].label,
                cn: world().segments[1].cn, ct: world().segments[1].ct, roughness: world().segments[1].roughness });
        const rows = f.app.stats.exportRows();
        const labels = rows.map(row => row[0]);
        const variability = method === 'lumped-mass' ? 'Variabilidad aplicada a Kn/Kt (%)' : 'Variabilidad de Cn/Ct aplicada a cada tramo (%)';
        for (const label of ['Versión del contrato de resultados', variability, 'Tramo 0 (0–60 m)', 'Tramo 1 (60–200 m)',
            'Tope de eventos de impacto por roca', 'Altura de vuelo del centro, máx. por roca (m)',
            'Impactos por roca (vn ≥ 0.5 m/s)']) assert.ok(labels.includes(label), label);
        assert.equal(labels.includes('Altura del centro al contacto (m)'), false);
        const csv = f.app.stats.generateCSV();
        assert.match(csv, /Versión del contrato de resultados,P0\.5,/);
        assert.doesNotMatch(csv + f.app.stats.generateReport(), /NaN|Infinity|undefined/);

        // CSV de impactos: una fila por evento guardado, columnas exactas.
        const lines = f.app.stats.generateImpactCSV().trim().split('\n');
        assert.equal(lines[0], IMPACT_HEADER);
        const body = lines.slice(1).map(line => line.split(','));
        assert.equal(body.length, rocks.reduce((sum, r) => sum + r.impactEvents.length, 0));
        const perRock = new Map();
        for (const cells of body) {
            assert.equal(cells.length, 16, cells.join(','));
            assert.ok(['Terreno', 'Barrera'].includes(cells[5]));
            perRock.set(cells[0], (perRock.get(cells[0]) || 0) + 1);
        }
        assert.equal(new Set(rocks.map(r => r.id)).size, rocks.length, 'ids únicos');
        for (const r of rocks) {
            assert.equal(r.impactCount, (perRock.get(String(r.id)) || 0) + r.droppedImpactEvents, `roca ${r.id}`);
        }
        const first = rocks.find(r => r.impactEvents.length > 0);
        const row = body.find(cells => cells[0] === String(first.id));
        assert.equal(Number(row[2]), first.impactEvents[0].t);
        assert.ok(Math.abs(Number(row[10]) - first.impactEvents[0].energy / 1000) < 1e-9, 'energía en kJ');

        // Vistas: los dos gráficos β con datos reales.
        f.app.showResultsDashboard();
        f.frames.splice(0).forEach(fn => fn());
        assert.ok(text(f.element('chart-bounce-distance')).includes('Altura de vuelo del centro (m)'));
        assert.ok(text(f.element('chart-velocity-distance')).includes('Velocidad normal de impacto, máx. (m/s)'));
        for (const id of ['chart-bounce-distance', 'chart-velocity-distance']) {
            assert.ok(!text(f.element(id)).some(t => /NaN|undefined/.test(t)), id);
        }
        assert.equal(Number(f.element('dash-stat-max-bounce').textContent), Number(results.flightHeight.max.toFixed(
            (f.element('dash-stat-max-bounce').textContent.split('.')[1] || '').length)));
    });
}

function world() { return makeTerrain().terrain; }

test('rechazo: una roca real mutada no pasa la barrera', () => {
    const control = publish(runWorker({ count: 3 }));
    assert.ok(control.app.stats.results && control.app.stats.results.status !== 'bloqueado', 'control sin mutar');
    const withEvent = rocks => rocks.find(r => r.impactEvents.length > 0);
    const mutations = {
        'clave extra en un evento': rocks => { withEvent(rocks).impactEvents[0].extra = 1; },
        'index no entero': rocks => { withEvent(rocks).impactEvents[0].index = 0.5; },
        'droppedImpactEvents incoherente': rocks => { rocks[0].droppedImpactEvents += 1; }
    };
    for (const [label, mutate] of Object.entries(mutations)) {
        const f = publish(runWorker({ count: 3 }), mutate);
        assert.match(f.element('simulation-status').textContent, /protocolo incompatible/, label);
        assert.equal(f.element('btn-export-impacts').disabled, true, label);
        assert.equal(f.element('btn-export-csv').disabled, true, label);
    }
});

test('I1 de punta a punta: con variabilidad 0 los finalX son idénticos a P0.3', () => {
    const oldStats = () => {
        const ctx = createContext({ extra: { SimRocas: {}, document: {} } });
        vm.runInContext(p03Source('js/stats.js'), ctx, { filename: 'p03-stats.js' });
        return new ctx.SimRocas.Stats();
    };
    const xRow = s => JSON.stringify(s.exportRows().find(row => row[0] === 'X final (m)'));
    for (const method of METHODS) {
        for (const barrier of [true, false]) {
            // Sin barrera, el caso base sale del perfil (I5: 186 de 705 eventos en
            // rígido) y cambia a propósito por E2.2: I1 usa ahí el perfil largo.
            const points = barrier ? POINTS : LONG_POINTS;
            const beta = runWorker({ method, barrier, points });
            const p03 = runWorker({ method, barrier, points, p03: true });
            assert.equal(p03.rocks[0].impactCount, undefined, 'el contrafactual es P0.3');
            const label = `${method} barrera=${barrier}`;
            assert.equal(offProfileEvents(beta, points, 1).length, 0, label + ': guarda I1, el fixture no tiene impactos fuera del perfil');
            assert.ok(beta.rocks.every(r => r.finalX >= points[0].x && r.finalX <= points[2].x), label + ': guarda I1, ninguna roca termina fuera del perfil');
            assert.equal(beta.rocks.length, p03.rocks.length, label);
            beta.rocks.forEach((r, i) => {
                assert.ok(Object.is(r.finalX, p03.rocks[i].finalX), `${label} roca ${i}: ${r.finalX} vs ${p03.rocks[i].finalX}`);
                assert.equal(r.stopReason, p03.rocks[i].stopReason, label);
            });
            if (barrier) {
                const f = publish(beta);
                const reference = oldStats();
                reference.compute(p03.rocks, { ...RELEASE }, { timeStep: 0.005, calcMethod: method });
                assert.equal(xRow(f.app.stats), xRow(reference), label + ': fila X final de Stats');
            }
        }
    }
});

test('U4: la variabilidad de Cn cambia el rígido y los Cn/Ct globales no actúan en todo el recorrido', () => {
    const base = runWorker({ method: 'rigid-body' });
    const varied = runWorker({ method: 'rigid-body', cnVariability: 30 });
    assert.notEqual(finalXs(varied.rocks), finalXs(base.rocks), 'la variabilidad del 30 % debe cambiar los resultados');
    const inProfile = run => run.rocks.every(r => r.impactEvents.every(e => e.surface !== 'terrain' ||
        (e.x >= POINTS[0].x && e.x <= POINTS[2].x)));
    const otherGlobals = runWorker({ method: 'rigid-body', cn: 0.95, ct: 0.95 });
    assert.ok(inProfile(base) && inProfile(otherGlobals), 'precondición: el caso base no sale del perfil');
    assert.equal(finalXs(otherGlobals.rocks), finalXs(base.rocks), 'Cn/Ct globales sin efecto dentro del perfil');
    const events = run => JSON.stringify(run.rocks.map(r => r.impactEvents.filter(e => e.surface === 'terrain').map(e => [e.cnEff, e.ctEff])));
    assert.equal(events(otherGlobals), events(base));

    // E2.2: sin barrera las rocas pasan el extremo del perfil (caso de I5) y
    // ahí manda el material del último tramo, no los globales.
    const soil = makeTerrain().terrain.segments[1];
    for (const method of ['rigid-body', 'nonsmooth']) {
        const open = runWorker({ method, barrier: false });
        const openGlobals = runWorker({ method, barrier: false, cn: 0.95, ct: 0.95 });
        const outside = offProfileEvents(open);
        assert.ok(outside.length > 0, method + ': el caso sin barrera debe tener impactos fuera del perfil');
        for (const e of outside) {
            assert.equal(e.index, 1, method + ': index del tramo extremo');
            assert.equal(e.cnEff, soil.cn, method + ': cnEff del tramo extremo');
        }
        assert.equal(finalXs(openGlobals.rocks), finalXs(open.rocks), method + ': Cn/Ct globales sin efecto fuera del perfil');
        assert.equal(events(openGlobals), events(open), method);
    }
});

// CB2b (P02B-3, RVBa-3b): en masa concentrada el index fuera del perfil es el
// del tramo extremo, la física no cambia (I2) y Stats advierte con su texto.
test('P02B-3 de punta a punta: masa concentrada fuera del perfil lleva el tramo extremo y sigue idéntica a P0.3', () => {
    // Perfil corto (fin en x=80), como el reproductor de RVβa.
    const short = [POINTS[0], POINTS[1], { x: 80, y: 0 }];
    const open = runWorker({ method: 'lumped-mass', barrier: false, cnVariability: 30, ctVariability: 30, points: short });
    const outside = offProfileEvents(open, short);
    assert.ok(outside.length > 0, 'el caso sin barrera debe tener impactos fuera del perfil');
    for (const e of outside) {
        assert.equal(e.index, e.x < short[0].x ? 0 : 1, 'index del tramo extremo más cercano');
        assert.equal(e.contactSpeed, null);
    }
    const p03 = runWorker({ method: 'lumped-mass', barrier: false, cnVariability: 30, ctVariability: 30, points: short, p03: true });
    assert.equal(finalXs(open.rocks), finalXs(p03.rocks), 'I2: mismos finalX que P0.3');

    const { terrain } = makeTerrain(short);
    const segments = terrain.segments.map((seg, index) => ({ index, x0: short[index].x, x1: short[index + 1].x,
        type: seg.type, label: seg.type, cn: seg.cn, ct: seg.ct, roughness: seg.roughness || 0 }));
    const sc = loadScripts(['js/stats.js'], { extra: { SimRocas: {}, document: { getElementById: () => null } } });
    const result = new sc.SimRocas.Stats().compute(Array.from(open.rocks), { ...RELEASE },
        { timeStep: 0.005, calcMethod: 'lumped-mass', cnVariability: 30, ctVariability: 30, segments });
    const warning = Array.from(result.warnings).filter(w => w.code === 'fueraDelPerfil');
    assert.equal(warning.length, 1);
    assert.equal(warning[0].message, 'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; en masa concentrada se usan Kn/Kt globales.');
});
