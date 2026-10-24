'use strict';

/**
 * Test de paridad main-thread vs Web Worker (T0.8, openspec worker-physics-parity).
 *
 * Contexto A ('browser'): terrain.js + physics.js + simulation.js cargados
 *   directamente; Terrain configurado con el perfil del caso de uso, physics
 *   construido como en getSimulationParams, Simulation como en runSimulation
 *   de js/app.js (configure + simulation.start con los mismos argumentos).
 *   Bucle determinista: while (sim.isRunning) sim.step();
 *
 * Contexto B ('worker'): sandbox con postMessage/importScripts falsos;
 *   js/worker.js carga los mismos scripts vía importScripts y recibe el
 *   mensaje { type: 'start', terrainJSON, simParams, physicsParams,
 *   barriers, startArgs } que debe enviar js/app.js.
 *
 * Aserto central: dado el MISMO seed, terrain, simParams, physicsParams y
 * startArgs, el worker debe producir exactamente las mismas rocas (mismo
 * número, mismos finalX/finalY a 1e-9, generation <= 3 del modelo
 * progresivo) que la clase Simulation del hilo principal.
 *
 * El protocolo legado (terrainData/rockConfigs/config) quedó eliminado en
 * T0.8: se fija como aserción de comportamiento que el worker nuevo NO
 * produce resultados ante un mensaje con el formato viejo, para que no
 * reaparezcan consumidores del formato duplicado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, createContext, runScript } = require('./helpers/load');

const SEED = 1234;
const TOL = 1e-9;

// Perfil del caso de uso ( metros ).
const PROFILE = [
    { x: 0, y: 120 }, { x: 40, y: 100 }, { x: 80, y: 70 },
    { x: 120, y: 45 }, { x: 160, y: 25 }, { x: 200, y: 15 },
    { x: 260, y: 10 }, { x: 350, y: 8 }, { x: 450, y: 8 }
];

// --- Caso de uso compartido -------------------------------------------------

function buildTerrainJSON() {
    // Sin seed: setPoints/fromJSON no consumen aleatoriedad.
    const ctx = loadScripts(['js/terrain.js'], { env: 'browser' });
    const t = new ctx.SimRocas.Terrain();
    t.setPoints(PROFILE.map(p => ({ ...p })));
    return t.toJSON();
}

// Espejo de getSimulationParams (js/app.js ~1540) para el motor compartido.
function makeSimParams(physics) {
    return {
        numRocks: 20,
        gravity: 9.81,
        cn: physics.cn,
        ct: physics.ct,
        rollingFriction: physics.rollingFriction,
        cnVariability: 10,
        ctVariability: 10,
        timeStep: 0.005,
        animationSpeed: 50,
        maxDuration: 30,
        ignoreResting: false,
        fragmentationEnabled: true,
        fractureEnergy: 2000,   // bajo: fuerza hijos de fragmentación
        fractureDissipation: 0.4
    };
}

// Copia de las propiedades primitivas propias de PhysicsEngine (lo que
// runSimulationWithWorker debe enviar como physicsParams).
function copyPrimitiveProps(physics) {
    const out = {};
    for (const key of Object.keys(physics)) {
        const v = physics[key];
        const type = typeof v;
        if (type === 'number' || type === 'string' || type === 'boolean') {
            out[key] = v;
        }
    }
    return out;
}

// Espejo de runSimulation (js/app.js ~1558): mismos argumentos y orden de
// configure / Object.assign / start que el modo normal.
function runMainThread({ calcMethod, terrainJSON, physicsOverrides = {} }) {
    const ctx = loadScripts(
        ['js/terrain.js', 'js/physics.js', 'js/simulation.js'],
        { env: 'browser', seed: SEED }
    );

    const terrain = new ctx.SimRocas.Terrain();
    terrain.fromJSON(terrainJSON);

    const physics = new ctx.SimRocas.PhysicsEngine();
    Object.assign(physics, { calcMethod }, physicsOverrides);

    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    sim.configure(makeSimParams(physics));
    sim.barriers = [];

    const params = makeSimParams(physics);
    // Orden exacto de la llamada en js/app.js:1671.
    sim.start(
        10, 130,        // releaseX, releaseY (sobre el terreno en x=10)
        0.8,            // diameter
        2700,           // density
        2,              // initVel
        30,             // angle
        params.maxDuration,
        params.ignoreResting,
        'sphere',       // shapeType determinista (esfera regular)
        0.6,            // aspectRatio
        'freefall',     // releaseMode
        null            // multiReleasePoints
    );

    while (sim.isRunning) {
        sim.step();
    }

    return {
        physicsParams: copyPrimitiveProps(physics),
        simParams: params,
        startArgs: [10, 130, 0.8, 2700, 2, 30, params.maxDuration,
            params.ignoreResting, 'sphere', 0.6, 'freefall', null],
        rocks: sim.rocks,
        maxGeneration: Math.max(...sim.rocks.map(r => r.generation)),
        fragmentChildren: sim.rocks.filter(r => r.generation > 0).length
    };
}

// Contexto B: worker sandbox. Las excepciones del handler quedan registradas
// como { type: 'error' } (análogo a worker.onerror) para poder asertarlas.
function runWorker(startMsg) {
    const msgs = [];
    let ctx;
    ctx = createContext({
        env: 'worker',
        seed: SEED,
        extra: {
            postMessage: (m) => msgs.push(m),
            importScripts: (...files) => files.forEach(f => runScript(ctx, 'js/' + f))
        }
    });
    runScript(ctx, 'js/worker.js');
    try {
        ctx.onmessage({ data: startMsg });
    } catch (err) {
        msgs.push({ type: 'error', error: String(err && err.message || err) });
    }
    return msgs;
}

function findComplete(msgs, label) {
    const complete = msgs.find(m => m.type === 'complete');
    assert.ok(complete, `${label}: debe haber un mensaje 'complete'`);
    return complete;
}

function parityWorkerStartMsg(main) {
    return {
        type: 'start',
        terrainJSON: buildTerrainJSON(),
        simParams: main.simParams,
        physicsParams: main.physicsParams,
        barriers: [],
        startArgs: main.startArgs
    };
}

// --- Paridad (protocolo T0.8) -----------------------------------------------

for (const calcMethod of ['rigid-body', 'lumped-mass', 'nonsmooth']) {
    test(`paridad main-thread vs worker (nuevo protocolo), calcMethod=${calcMethod}`, () => {
        const terrainJSON = buildTerrainJSON();
        const main = runMainThread({ calcMethod, terrainJSON });

        assert.ok(main.fragmentChildren > 0,
            'precondición: el caso debe producir hijos de fragmentación');

        const msgs = runWorker(parityWorkerStartMsg(main));
        const complete = findComplete(msgs, calcMethod);

        assert.ok(msgs.some(m => m.type === 'progress'), `${calcMethod}: mensajes 'progress'`);
        assert.ok(msgs.some(m => m.type === 'frame'), `${calcMethod}: mensajes 'frame'`);

        const workerRocks = complete.rocks;
        assert.equal(workerRocks.length, main.rocks.length,
            `${calcMethod}: mismo número de rocas (incluidos fragmentos)`);

        for (let i = 0; i < main.rocks.length; i++) {
            const a = main.rocks[i];
            const b = workerRocks[i];
            const msg = `${calcMethod}: roca[${i}] id=${a.id}`;
            assert.ok(Math.abs(a.finalX - b.finalX) <= TOL,
                `${msg}: finalX idéntico (${a.finalX} vs ${b.finalX})`);
            assert.ok(Math.abs(a.finalY - b.finalY) <= TOL,
                `${msg}: finalY idéntico (${a.finalY} vs ${b.finalY})`);
        }

        // Modelo progresivo: hijos hasta generation <= 3.
        for (const r of workerRocks) {
            assert.ok(r.generation <= 3,
                `${calcMethod}: generation <= 3 para id=${r.id}, es ${r.generation}`);
        }
    });
}

// --- Cambio de protocolo: el formato legado ya no se acepta ------------------

test('cambio de protocolo: el mensaje legado (terrainData/rockConfigs) no produce resultados', () => {
    // RED (worker viejo): estos mensajes se consumían con la copia duplicada
    // de la física. Tras T0.8 el worker solo acepta el protocolo nuevo — un
    // mensaje legado no debe generar ningún 'complete' (y por tanto ningún
    // resultado de la física duplicada).
    const legacyMsg = {
        type: 'start',
        terrainData: JSON.parse(buildTerrainJSON()),
        rockConfigs: [],
        config: {
            gravity: 9.81, dt: 0.005, cn: 0.6, ct: 0.4,
            calcMethod: 'rigid-body',
            Kn: 0.35, Kt: 0.75,
            energyModel: 'impulse', energyRatio: 0.7,
            maxStepsPerRock: 5000, maxDuration: 30, animationSpeed: 50,
            fragmentationEnabled: true,
            fractureEnergy: 2000, fractureDissipation: 0.4
        },
        barriers: []
    };

    const msgs = runWorker(legacyMsg);
    assert.ok(!msgs.some(m => m.type === 'complete'),
        'el worker unificado no debe responder al formato legado');
});
