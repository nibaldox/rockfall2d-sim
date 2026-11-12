'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { loadScripts } = require('./helpers/load');

// Reutiliza los adaptadores existentes; ninguno sustituye motor, worker ni App.
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0];
const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), __dirname);
const parity = path.join(__dirname, 'worker.parity.test.js');
const workerSource = fs.readFileSync(parity, 'utf8').split('// --- Paridad (protocolo')[0];
const { runWorker } = new Function('require', '__dirname', workerSource + '\nreturn { runWorker };')(createRequire(parity), __dirname);

const cap = [{ x: 0, y: 40 }, { x: 80, y: 0 }, { x: 500, y: 0 }];
const short = [{ x: 0, y: 40 }, { x: 40, y: 20 }];
const flat = [{ x: 0, y: 0 }, { x: 500, y: 0 }];
const reflected = cap.map(p => ({ x: 500 - p.x, y: p.y })).reverse();
const chartIds = ['chart-energy-hist', 'chart-energy-distance', 'chart-accumulation',
    'chart-bounce-distance', 'chart-velocity-distance', 'chart-runout-dist'];

function run(points = cap, options = {}) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 1234 });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(points);
    const x = options.x === undefined ? 20 : options.x;
    const y = options.y === undefined ? 32 : options.y;
    const expected = options.expected === undefined ? 1 : options.expected;
    const bounds = terrain.getBounds();
    assert.ok(x - 10 >= bounds.minX && x + 10 <= bounds.maxX, 'ventana de fuente en el perfil');
    const delta = terrain.getHeightAt(x - 10) - terrain.getHeightAt(x + 10);
    assert.equal(delta >= 0.5 ? 1 : delta <= -0.5 ? -1 : null, expected, 'pendiente local');
    assert.ok(y > terrain.getHeightAt(x) + 0.55, 'fuente sobre el terreno');
    if (points.length === 3) {
        const middle = points[1].x;
        const platformX = expected === -1 ? (bounds.minX + middle) / 2 : (middle + bounds.maxX) / 2;
        const platformY = terrain.getHeightAt(platformX);
        assert.equal(platformY, terrain.getHeightAt(expected === -1 ? bounds.minX : bounds.maxX), 'plataforma de captura');
        assert.ok(Math.abs(platformX - middle) > 100, 'extensión de plataforma');
    }
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    const params = { numRocks: options.count || 3, animationSpeed: 50, timeStep: 0.01,
        maxDuration: 60, fragmentationEnabled: !!options.fragmentation,
        fractureEnergy: options.fragmentation ? 1 : 25000, downhillMode: options.mode || 'auto' };
    const args = [x, y, 1, 2700, options.velocity || 0, 0, 60, false, 'sphere', 1, 'freefall', null];
    sim.configure(params);
    sim.start(...args);
    while (sim.isRunning) sim.step();
    const messages = runWorker({ type: 'start', terrainJSON: terrain.toJSON(), simParams: params,
        physicsParams: {}, barriers: [], startArgs: args });
    const complete = messages.find(m => m.type === 'complete');
    assert.ok(complete, 'worker real debe completar: ' + JSON.stringify(messages.find(m => m.type === 'error')));
    assert.equal(complete.status, 'completed');
    return { terrain, physics, sim, complete, x, y };
}

function setup(runData, worker = true) {
    const f = fixture(false);
    const canvases = ['histogram', 'canvas', ...chartIds];
    for (const id of canvases) {
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
    f.app.terrain = runData.terrain;
    f.app.physics = runData.physics;
    f.app.simulation = runData.sim;
    f.app.releasePoint = { x: runData.x, y: runData.y };
    f.app.stats = new f.Stats();
    f.app.renderer = new rc.SimRocas.Renderer(f.element('canvas'), runData.terrain);
    f.app.histogramCanvas = f.element('histogram');
    f.app._completeRun(worker ? runData.complete.rocks : runData.sim.rocks, 'completed', worker);
    return f;
}
function draw(f) {
    f.app.showResultsDashboard();
    f.frames.splice(0).forEach(fn => fn());
    f.app.renderer.showProbabilityMap = true;
    f.app.renderer.drawProbabilityMap(f.app.renderer.probabilityPercentiles);
}
function text(e) { return e.calls.filter(c => c[0] === 'fillText').map(c => String(c[1])); }
function exportsValid(f) {
    const csv = f.app.stats.generateCSV();
    const report = f.app.stats.generateReport();
    assert.match(csv, /Parámetro,Valor/);
    assert.match(csv, /\(m\)/);
    assert.match(csv, /Contactos detectados \(conteo interno, no equivale a impactos\)/);
    assert.match(report, /Contactos detectados/);
    assert.doesNotMatch(csv + report, /NaN|Infinity|undefined/);
    return { csv, report };
}
function enabled(f, value) {
    for (const id of ['btn-export-csv', 'btn-export-report', 'btn-dashboard-csv', 'btn-dashboard-report']) {
        assert.equal(f.element(id).disabled, !value, id);
    }
}

test('1 plataforma: reposo, publicación, bandas exactas y exportaciones', () => {
    const d = run();
    assert.ok(d.complete.rocks.every(r => r.stopReason === 'rest' && r.finalX > 80 && r.finalX < 500), 'captura física en plataforma');
    const f = setup(d); const r = f.app.stats.results;
    assert.equal(r.status, 'completo'); enabled(f, true);
    const map = f.app.renderer.probabilityPercentiles;
    assert.equal(map.originX, 20); assert.equal(map.sign, 1);
    assert.deepEqual(Array.from(map.bands, b => b.label), ['P10', 'P50', 'P83', 'P95']);
    for (const band of map.bands) {
        const bound = r.reachBounds[band.label.toLowerCase()];
        assert.equal(band.value, bound.lower); assert.equal(band.exact, true); assert.equal(bound.exact, true);
    }
    draw(f);
    assert.ok(text(f.element('histogram')).includes('Alcance final relativo (m)'));
    for (const band of map.bands) assert.ok(text(f.element('canvas')).some(t => t.includes(band.label) && t.includes('=')));
    assert.ok(text(f.element('chart-runout-dist')).includes('Alcance final relativo (m)'));
    exportsValid(f);
});

test('2 dominio corto: culling cuesta abajo y cotas en UI y CSV', () => {
    const d = run(short, { velocity: 20 });
    assert.equal(d.terrain.getBounds().maxX, 40);
    assert.ok(d.complete.rocks.every(r => r.stopReason === 'culled' && r.cullBoundary === 'maxX' && r.finalX > 90));
    const f = setup(d); const r = f.app.stats.results;
    assert.equal(r.status, 'parcial'); assert.ok(r.population.pctLeavingDownhill > 0);
    enabled(f, true); assert.match(f.element('simulation-status').textContent, /censur/i);
    draw(f); assert.match(f.element('dash-stat-p95').textContent, /≥/);
    assert.ok(text(f.element('canvas')).some(t => /P95\s*≥/.test(t)));
    const out = exportsValid(f); assert.match(out.csv, /≥/); assert.match(out.report, /censur/i);
});

test('3 plano ambiguo publica parcial sin mapa', () => {
    const d = run(flat, { y: 3, expected: null });
    assert.ok(d.complete.rocks.every(r => r.downhillSign === null));
    const f = setup(d); const r = f.app.stats.results;
    assert.equal(r.status, 'parcial'); assert.ok(r.warnings.some(w => w.code === 'direccionAmbigua'));
    assert.equal(f.app.renderer.probabilityPercentiles, null); enabled(f, true);
    assert.match(f.element('simulation-status').textContent, /mapa.*sentido ambiguo/i);
});

test('4 fragmentación real bloquea exportación con conteos', () => {
    const d = run(cap, { y: 60, fragmentation: true, count: 1 });
    assert.ok(d.complete.rocks.some(r => r.stopReason === 'fragmented'));
    assert.ok(d.complete.rocks.some(r => r.generation > 0));
    const f = setup(d); assert.equal(f.app._resultsValid, false); enabled(f, false);
    assert.equal(f.app.stats.results, null);
    assert.match(f.element('simulation-status').textContent, /bloqueados.*fragmentacion.*fragmented: [1-9]/i);
});

test('5 perfil reflejado auto y -x: signo y alcance positivo', () => {
    for (const mode of ['auto', '-x']) {
        const d = run(reflected, { x: 480, y: 32, expected: -1, mode });
        assert.ok(d.complete.rocks.every(r => r.stopReason === 'rest' && r.finalX < r.releaseX));
        const f = setup(d); assert.equal(f.app.stats.results.status, 'completo');
        assert.ok(f.app.stats.results.derived.finalRunout.every(v => v > 0));
        assert.equal(f.app.renderer.probabilityPercentiles.sign, -1);
        draw(f); assert.ok(text(f.element('canvas')).some(t => /P95/.test(t)));
    }
});

test('6 datum: Stats y fase balística antes del primer contacto', t => {
    const a = run();
    // Aísla Stats: traslada exactamente las rocas producidas, no una nueva trayectoria.
    const original = setup(a).app.stats;
    const movedRocks = a.complete.rocks.map(r => ({ ...r, releaseX: r.releaseX + 600,
        releaseY: r.releaseY + 2400, finalX: r.finalX + 600, finalY: r.finalY + 2400 }));
    const originalResult = original.results;
    const movedResult = new (fixture(false).Stats)().compute(movedRocks);
    assert.notEqual(originalResult.status, 'bloqueado', 'guarda Stats original bloqueado');
    assert.notEqual(movedResult.status, 'bloqueado', 'guarda Stats trasladado bloqueado');
    assert.ok(originalResult.restRocks.length > 0, 'guarda fixture Stats sin rocas en reposo');
    assert.equal(a.complete.rocks.length, 3, 'guarda fixture Stats debe tener 3 rocas');
    assert.ok(a.complete.rocks.every(r => r.stopReason === 'rest'), 'guarda fixture Stats: las 3 rocas deben terminar en rest');
    assert.equal(originalResult.restRocks.length, movedResult.restRocks.length, 'guarda Stats longitudes de reposo');
    const comparisons = {};
    for (const name of ['finalRunout', 'verticalDrop', 'reachAngle']) {
        const originalValues = originalResult.derived[name];
        const movedValues = movedResult.derived[name];
        assert.equal(originalValues.length, originalResult.restRocks.length, `guarda Stats longitud original ${name}`);
        assert.equal(movedValues.length, movedResult.restRocks.length, `guarda Stats longitud trasladada ${name}`);
        comparisons[name] = 0;
        originalValues.forEach((x, i) => {
            const y = movedValues[i];
            assert.equal(x === null, y === null, `guarda Stats nulidad ${name}[${i}]`);
            if (x === null) return;
            assert.ok(Number.isFinite(x) && Number.isFinite(y), `guarda Stats valor no finito ${name}[${i}]`);
            assert.ok(Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)), `Stats aislado ${name}`);
            comparisons[name]++;
        });
        assert.ok(comparisons[name] > 0, `guarda Stats sin comparaciones finitas ${name}`);
    }
    t.diagnostic(`comparaciones Stats: finalRunout=${comparisons.finalRunout}; verticalDrop=${comparisons.verticalDrop}; reachAngle=${comparisons.reachAngle}`);
    // Instrumentación observacional: conserva el generador sembrado del harness.
    const vm = require('node:vm');
    function ballistic(ox, oy, points = cap, sourceY = 32, velocity = 0, count = 3) {
        const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 1234 });
        vm.runInContext(`globalThis.draws = 0; {
            const random = Math.random;
            Math.random = () => { globalThis.draws++; return random(); };
        }`, ctx);
        const terrain = new ctx.SimRocas.Terrain();
        terrain.setPoints(points.map(p => ({ x: p.x + ox, y: p.y + oy })));
        const physics = new ctx.SimRocas.PhysicsEngine();
        const sim = new ctx.SimRocas.Simulation(terrain, physics);
        sim.configure({ numRocks: count, animationSpeed: 1, timeStep: 0.01,
            maxDuration: 60, fragmentationEnabled: false, downhillMode: 'auto' });
        sim.start(20 + ox, sourceY + oy, 1, 2700, velocity, 0, 60, false, 'sphere', 1, 'freefall', null);
        assert.equal(sim.animationSpeed, 1);
        assert.equal(sim.rocks.length, count);
        for (const rock of sim.rocks) {
            assert.equal(rock.bounces, 0);
            assert.ok(rock.getShapeVertices().every(v => v.y > terrain.getHeightAt(v.x)),
                'fixture inválido: vértice inicial en contacto');
        }
        return { ctx, terrain, physics, sim };
    }
    const base = ballistic(0, 0), shifted = ballistic(600, 2400);
    assert.equal(base.ctx.draws, shifted.ctx.draws, 'RNG de preparación');
    // EPSILON*max(1,|operandos absolutos|) aproxima un ulp por exceso.
    // Dos redondeos por subpaso y uno inicial: cota lineal explícita,
    // independiente para cada componente; no compara trayectorias tras contacto.
    function close(u, v, offset, substeps, label) {
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(u), Math.abs(v), Math.abs(offset))
            * (2 * substeps + 2);
        const difference = Math.abs(u - (v - offset));
        assert.ok(Number.isFinite(difference) && difference <= tolerance,
            `${label}: Δ=${difference}, tolerancia=${tolerance}`);
    }
    function compare(substeps, label) {
        assert.equal(base.ctx.draws, shifted.ctx.draws, `RNG ${label}`);
        base.sim.rocks.forEach((r, i) => {
            const q = shifted.sim.rocks[i];
            for (const [field, offset] of [['x', 600], ['y', 2400], ['vx', 0], ['vy', 0],
                ['rotation', 0], ['angularVelocity', 0]]) {
                close(r[field], q[field], offset, substeps, `${label}, roca ${i + 1}, ${field}`);
            }
        });
    }
    compare(0, 'inicio');
    base.sim.rocks.forEach((r, i) => {
        const q = shifted.sim.rocks[i];
        assert.equal(r.shape.length, q.shape.length, 'número de vértices');
        r.shape.forEach((v, j) => {
            close(v.x, q.shape[j].x, 0, 0, `forma ${i}/${j} x`);
            close(v.y, q.shape[j].y, 0, 0, `forma ${i}/${j} y`);
        });
    });
    let compared = 0, accumulatedSubsteps = 0, firstContact = null, drawsBeforeContact = 0;
    for (let step = 1; step <= 200; step++) {
        assert.equal(base.sim.activeRocks.length, 3, 'fixture base terminó antes del contacto');
        assert.equal(shifted.sim.activeRocks.length, 3, 'fixture trasladado terminó antes del contacto');
        const substeps = base.sim.rocks.map(r => base.physics.subStepsFor(r, base.physics.dt));
        const shiftedSubsteps = shifted.sim.rocks.map(r => shifted.physics.subStepsFor(r, shifted.physics.dt));
        assert.deepEqual(Array.from(substeps), Array.from(shiftedSubsteps), 'subpasos previos');
        drawsBeforeContact = base.ctx.draws;
        base.sim.step(); shifted.sim.step();
        if (base.sim.rocks.some(r => r.bounces > 0) || shifted.sim.rocks.some(r => r.bounces > 0)) {
            firstContact = step;
            break; // El paso que contiene el primer contacto jamás se compara.
        }
        accumulatedSubsteps += Math.max(...substeps);
        compare(accumulatedSubsteps, `paso ${step}`);
        compared++;
    }
    assert.notEqual(firstContact, null, 'fixture inválido: no se observó contacto');
    assert.ok(compared >= 20, `fixture inválido: solo ${compared} pasos sin contacto`);
    assert.equal(compared, firstContact - 1, 'primer contacto excluido');
    t.diagnostic(`pasos previos=${compared}; primer contacto=${firstContact}; subpasos=${accumulatedSubsteps}; RNG previo=${drawsBeforeContact} por corrida`);
    // Fixture independiente: cruce del borde maxX muy por encima del terreno.
    const cullProfile = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
    const c = ballistic(0, 0, cullProfile, 400, 60, 1);
    const d = ballistic(600, 2400, cullProfile, 400, 60, 1);
    let cullSubsteps = 0, cullSteps = 0;
    assert.equal(c.ctx.draws, d.ctx.draws, 'RNG inicial culling');
    while (c.sim.isRunning && d.sim.isRunning && cullSteps < 200) {
        const n = c.physics.subStepsFor(c.sim.rocks[0], c.physics.dt);
        assert.equal(n, d.physics.subStepsFor(d.sim.rocks[0], d.physics.dt), 'subpasos culling');
        c.sim.step(); d.sim.step(); cullSteps++; cullSubsteps += n;
        const r = c.sim.rocks[0], q = d.sim.rocks[0];
        assert.equal(r.bounces, 0, 'culling base antes de contacto');
        assert.equal(q.bounces, 0, 'culling trasladado antes de contacto');
        assert.equal(c.ctx.draws, d.ctx.draws, 'RNG culling');
        close(r.x, q.x, 600, cullSubsteps, 'culling x');
        close(r.y, q.y, 2400, cullSubsteps, 'culling y');
    }
    assert.equal(c.sim.rocks[0].stopReason, 'culled');
    assert.equal(d.sim.rocks[0].stopReason, 'culled');
    assert.equal(c.sim.rocks[0].cullBoundary, 'maxX');
    assert.equal(d.sim.rocks[0].cullBoundary, 'maxX');
    t.diagnostic(`culling maxX sin contacto: paso=${cullSteps}; subpasos=${cullSubsteps}`);
});

test('7 paridad Stats de hilo y worker con semilla idéntica', () => {
    const d = run();
    assert.ok(d.sim.rocks.every(r => r.stopReason === 'rest'));
    assert.ok(d.complete.rocks.every(r => r.stopReason === 'rest'));
    const main = setup(d, false).app.stats.results;
    const worker = setup(d, true).app.stats.results;
    // Las instancias Rock tienen métodos y propiedades internas no serializadas;
    // se comparan todos los agregados y los campos públicos transportados.
    const normalize = r => JSON.parse(JSON.stringify({ ...r, restRocks: r.restRocks.map(rock => {
        const keys = Object.keys(d.complete.rocks[0]).filter(k => k !== 'getShapeVertices');
        return Object.fromEntries(keys.map(k => [k, rock[k]]));
    }) }));
    assert.deepEqual(normalize(main), normalize(worker));
});

test('8 cancelar conserva invalidación P0.1', () => {
    const d = run(); const f = setup(d);
    assert.equal(f.app._resultsValid, true); enabled(f, true);
    f.app.getSimulationParams = () => ({ numRocks: 3, animationSpeed: 1, timeStep: 0.01,
        maxDuration: 60, fragmentationEnabled: false });
    f.app.runSimulation();
    assert.equal(d.sim.isRunning, true);
    const oldComplete = d.sim.onComplete;
    f.app.stopSimulation();
    assert.ok(d.sim.rocks.some(r => r.stopReason === 'cancelled'));
    assert.equal(f.app._resultsValid, false); assert.equal(f.app.stats.results, null);
    assert.equal(f.app.renderer.probabilityPercentiles, null); enabled(f, false);
    assert.match(f.element('simulation-status').textContent, /cancelada/i);
    oldComplete(d.sim.rocks);
    assert.equal(f.app._resultsValid, false); assert.equal(f.app.stats.results, null); enabled(f, false);
});

test('9 contador en cero al cancelar y resetear', () => {
    const d = run(); const f = setup(d);
    assert.equal(f.element('rock-count-display').textContent, 'Rocas: 3');
    f.app.stopSimulation(); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 0');
    f.element('rock-count-display').textContent = 'Rocas: 3';
    f.app.resetSimulation(); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 0');
});
