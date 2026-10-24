'use strict';

/**
 * Tests T4.3 — SimRocas.Simulation3D (contrato C7): controlador de simulación
 * sobre PhysicsEngine3D sobre Dem, generación de specs de liberación
 * (buildRockSpecs) con PRNG sembrado y estadísticas de resultados.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadScripts } = require('./helpers/load.js');

const SEED = 2027;
const TAN35 = Math.tan(35 * Math.PI / 180);
const DT = 0.005;

const FILES = [
    'js/dem.js',
    'js/math3d.js',
    'js/physics3d.js',
    'js/source-zones.js',
    'js/simulation3d.js',
];

const ZONE = {
    id: 'zona-cabecera',
    type: 'polygon',
    vertices: [
        { x: 4, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 30 }, { x: 4, y: 30 },
    ],
};

const OPTS = {
    zones: [ZONE],
    totalRocks: 60,
    diameter: 0.5,
    density: 2700,
    releaseMode: 'detachment',
    heightAboveGround: 2,
    initialVelocity: { vx: 0, vy: 0, vz: 0 },
    diameterVariability: 0,
};

// Ladera de 35° que desciende hacia +x hasta x=150 y llano después.
function makeSlopeDem(ctx) {
    return ctx.SimRocas.Dem.fromFunction(
        240, 42, 1,
        (x) => Math.max(0, (150 - x) * TAN35),
    );
}

function loadSim(seed) {
    return loadScripts(FILES, { env: 'browser', seed: seed === undefined ? null : seed });
}

// --- buildRockSpecs ---------------------------------------------------------

test('buildRockSpecs: reproducible con la misma semilla y coherente con el DEM', () => {
    const ctx = loadSim();
    const R = ctx.SimRocas;
    const dem = makeSlopeDem(ctx);

    const specsA = R.Simulation3D.buildRockSpecs(dem, OPTS, R.seededRandom(SEED));
    const specsB = R.Simulation3D.buildRockSpecs(dem, OPTS, R.seededRandom(SEED));
    assert.equal(specsA.length, OPTS.totalRocks);
    assert.deepEqual(specsA, specsB, 'misma semilla → mismas specs');

    // Otra semilla da otras posiciones.
    const specsC = R.Simulation3D.buildRockSpecs(dem, OPTS, R.seededRandom(SEED + 1));
    assert.notDeepEqual(specsA, specsC, 'distinta semilla → otras posiciones');

    for (let i = 0; i < specsA.length; i++) {
        const s = specsA[i];
        assert.equal(s.diameter, OPTS.diameter, 'variabilidad 0 → diámetro exacto');
        assert.equal(s.density, OPTS.density);
        assert.equal(s.vx, 0);
        assert.equal(s.vy, 0);
        assert.equal(s.vz, 0);
        assert.ok(R.SourceZones.contains(ZONE, s.x, s.y), 'la posición cae en la zona');
        const h = dem.heightAt(s.x, s.y);
        assert.ok(!Number.isNaN(h), 'la posición tiene dato en el DEM');
        const radius = s.diameter / 2;
        assert.ok(
            Math.abs(s.z - (h + radius)) <= 1e-9,
            'detachment: z = h + r (recibido ' + (s.z - (h + radius)) + ')',
        );
    }
});

test('buildRockSpecs: releaseMode fall añade heightAboveGround al z inicial', () => {
    const ctx = loadSim();
    const R = ctx.SimRocas;
    const dem = makeSlopeDem(ctx);

    const specs = R.Simulation3D.buildRockSpecs(
        dem,
        { ...OPTS, releaseMode: 'fall' },
        R.seededRandom(SEED),
    );
    for (const s of specs) {
        const h = dem.heightAt(s.x, s.y);
        const radius = s.diameter / 2;
        assert.ok(Math.abs(s.z - (h + radius + OPTS.heightAboveGround)) <= 1e-9);
    }
});

test('buildRockSpecs: variabilidad de diámetro aplicada con la semilla', () => {
    const ctx = loadSim();
    const R = ctx.SimRocas;
    const dem = makeSlopeDem(ctx);
    const opts = { ...OPTS, diameterVariability: 20 };
    const specs = R.Simulation3D.buildRockSpecs(dem, opts, R.seededRandom(SEED));
    let distinto = false;
    for (const s of specs) {
        assert.ok(s.diameter > 0, 'el diámetro siempre queda positivo');
        assert.ok(
            Math.abs(s.diameter - OPTS.diameter) <= OPTS.diameter * 0.2 + 1e-12,
            'variación dentro de ±20%',
        );
        if (s.diameter !== OPTS.diameter) { distinto = true; }
    }
    assert.ok(distinto, 'con variabilidad 20% hay diámetros distintos');
    // Reproducible con la misma semilla.
    const specsB = R.Simulation3D.buildRockSpecs(dem, opts, R.seededRandom(SEED));
    assert.deepEqual(specs, specsB);
});

test('buildRockSpecs: reintenta posiciones sin dato y falla en español al agotar el tope', () => {
    const ctx = loadSim();
    const R = ctx.SimRocas;
    // Franja sin dato: x ∈ [5, 14] con cualquier y.
    const nanDem = R.Dem.fromFunction(
        20, 12, 1,
        (x) => (x >= 5 && x <= 14 ? NaN : 3),
    );
    const zone = {
        id: 'zona-sin-dato',
        type: 'polygon',
        vertices: [{ x: 6, y: 2 }, { x: 13, y: 2 }, { x: 13, y: 9 }, { x: 6, y: 9 }],
    };
    assert.throws(
        () => R.Simulation3D.buildRockSpecs(
            nanDem,
            { ...OPTS, zones: [zone], totalRocks: 2 },
            R.seededRandom(SEED),
        ),
        (err) => err && /Simulation3D\.buildRockSpecs/.test(err.message),
    );
});

test('buildRockSpecs: valida entradas con errores en español', () => {
    const ctx = loadSim();
    const R = ctx.SimRocas;
    const dem = makeSlopeDem(ctx);
    assert.throws(
        () => R.Simulation3D.buildRockSpecs(dem, { ...OPTS, totalRocks: 10.5 }, R.seededRandom(SEED)),
        (err) => err && /totalRocks/.test(err.message),
    );
    assert.throws(
        () => R.Simulation3D.buildRockSpecs(dem, { ...OPTS, releaseMode: 'gratis' }, R.seededRandom(SEED)),
        (err) => err && /releaseMode/.test(err.message),
    );
    assert.throws(
        () => R.Simulation3D.buildRockSpecs(dem, { ...OPTS, diameterVariability: 140 }, R.seededRandom(SEED)),
        (err) => err && /diameterVariability/.test(err.message),
    );
    assert.throws(
        () => R.Simulation3D.buildRockSpecs(dem, { ...OPTS, density: 0 }, R.seededRandom(SEED)),
        (err) => err && /density/.test(err.message),
    );
});

// --- Simulation3D (controlador) ---------------------------------------------

test('Simulation3D: 60 rocas en ladera de 35° + llano — todas terminan y stats coherentes', () => {
    const ctx = loadSim(SEED);
    const R = ctx.SimRocas;
    const dem = makeSlopeDem(ctx);

    const engine = new R.PhysicsEngine3D({
        dt: DT,
        gravity: 9.81,
        knVariability: 0,
        ktVariability: 0,
        roughnessDeg: 0,
    });
    const sim = new R.Simulation3D(dem, engine);
    sim.configure({ maxDuration: 30 });
    assert.equal(sim.maxSteps, Math.ceil(30 / DT), 'maxSteps = ceil(maxDuration / dt)');

    sim.start(OPTS);
    assert.equal(sim.isRunning, true);

    let guard = 0;
    while (sim.isRunning) {
        sim.step(50);
        if (++guard > 10000) { break; }
    }
    assert.equal(sim.isRunning, false);

    const { rocks, stats } = sim.getResults();
    assert.equal(rocks.length, OPTS.totalRocks);

    let rest = 0;
    let culled = 0;
    let maxStepsCount = 0;
    for (const rock of rocks) {
        assert.ok(
            rock.stopReason === 'rest' || rock.stopReason === 'culled' || rock.stopReason === 'maxSteps',
            'stopReason: ' + String(rock.stopReason),
        );
        assert.ok(rock.isResting, 'roca terminada (isResting)');
        if (rock.stopReason === 'rest') { rest++; }
        else if (rock.stopReason === 'culled') { culled++; }
        else { maxStepsCount++; }
    }
    assert.equal(stats.total, OPTS.totalRocks);
    assert.equal(stats.rest, rest);
    assert.equal(stats.culled, culled);
    assert.equal(stats.maxSteps, maxStepsCount);
    assert.equal(stats.rest + stats.culled + stats.maxSteps, stats.total, 'suma coherente');

    assert.deepEqual(
        Object.keys(stats).sort(),
        ['culled', 'maxEnergyKJ', 'maxSteps', 'meanRunout', 'p95Runout', 'rest', 'total'],
        'claves del contrato de stats',
    );

    // Runout desde el punto de liberación: las rocas bajan la ladera.
    assert.ok(stats.meanRunout > 0, 'meanRunout > 0 (' + stats.meanRunout + ')');
    assert.ok(stats.p95Runout >= stats.meanRunout, 'p95 >= media');
    assert.ok(stats.maxEnergyKJ > 0, 'maxEnergyKJ > 0 (' + stats.maxEnergyKJ + ')');
    // En una ladera de 35° con caída de ~105 m, el runout debe ser sostenido.
    assert.ok(stats.meanRunout > 10, 'meanRunout apreciable (' + stats.meanRunout.toFixed(1) + ' m)');
    console.log('sim3d stats:', JSON.stringify(stats));
});
