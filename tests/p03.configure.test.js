'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function scene() {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 11 });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.addPoint(-1000, -1000);
    terrain.addPoint(1000, -1000);
    const engine = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, engine);
    return { sim, engine };
}

function configured(params) {
    const { sim, engine } = scene();
    sim.configure(params);
    return { sim, engine };
}

// Dominio de cada fila de configure (CONTRATO_P03 §P03-1).
const ROWS = [
    { key: 'numRocks', def: 100, zeroKept: false, read: (s) => s.totalRocks },
    { key: 'animationSpeed', def: 50, zeroKept: false, read: (s) => s.animationSpeed },
    { key: 'gravity', def: 9.81, zeroKept: false, read: (s) => s.physics.gravity },
    { key: 'timeStep', def: 0.005, zeroKept: false, read: (s) => s.physics.dt },
    { key: 'cn', def: 0.6, zeroKept: true, read: (s) => s.physics.cn },
    { key: 'ct', def: 0.4, zeroKept: true, read: (s) => s.physics.ct },
    { key: 'rollingFriction', def: 0.15, zeroKept: true, read: (s) => s.physics.rollingFriction },
    { key: 'cnVariability', def: 10, zeroKept: true, read: (s) => s.physics.cnVariability },
    { key: 'ctVariability', def: 10, zeroKept: true, read: (s) => s.physics.ctVariability },
    { key: 'maxDuration', def: 30, zeroKept: false, read: (s) => s.maxDuration },
    { key: 'fractureEnergy', def: 25000, zeroKept: false, read: (s) => s.physics.fractureEnergy },
    { key: 'fractureDissipation', def: 0.4, zeroKept: true, read: (s) => s.physics.fractureDissipation }
];

test('cero se conserva solo en los dominios que lo admiten', () => {
    assert.equal(ROWS.length, 12, 'la tabla de dominios debe cubrir las doce filas numéricas');
    for (const row of ROWS) {
        const { sim } = configured({ [row.key]: 0 });
        const got = row.read(sim);
        if (row.zeroKept) {
            assert.equal(got, 0, `${row.key}=0 debe conservarse y se obtuvo ${got}`);
        } else {
            assert.equal(got, row.def, `${row.key}=0 debe caer al defecto ${row.def} y se obtuvo ${got}`);
        }
    }
});

test('undefined, null, NaN, infinitos y negativos usan el defecto', () => {
    const invalid = [
        { label: 'undefined', value: undefined },
        { label: 'null', value: null },
        { label: 'NaN', value: NaN },
        { label: 'Infinity', value: Infinity },
        { label: '-Infinity', value: -Infinity },
        { label: 'negativo', value: -1.5 }
    ];
    let checks = 0;
    for (const row of ROWS) {
        for (const bad of invalid) {
            const { sim } = configured({ [row.key]: bad.value });
            const got = row.read(sim);
            assert.equal(got, row.def, `${row.key}=${bad.label} debe caer al defecto ${row.def} y se obtuvo ${got}`);
            checks++;
        }
    }
    assert.equal(checks, 72, 'deben comprobarse doce filas por seis valores inválidos');
});

test('valores válidos distintos de cero no se transforman', () => {
    const { sim } = configured({
        numRocks: 7,
        animationSpeed: 25,
        gravity: 3.5,
        timeStep: 0.02,
        cn: 0.9,
        ct: 0.1,
        rollingFriction: 0.05,
        cnVariability: 33,
        ctVariability: 47,
        maxDuration: 12,
        fractureEnergy: 9000,
        fractureDissipation: 0.25
    });
    const expected = { numRocks: 7, animationSpeed: 25, gravity: 3.5, timeStep: 0.02, cn: 0.9, ct: 0.1, rollingFriction: 0.05, cnVariability: 33, ctVariability: 47, maxDuration: 12, fractureEnergy: 9000, fractureDissipation: 0.25 };
    for (const row of ROWS) {
        assert.equal(row.read(sim), expected[row.key], `${row.key} válido debe conservarse`);
    }
});

test('numRocks no entero cae al defecto 100', () => {
    for (const value of [2.5, 100.5, 0.5]) {
        const { sim } = configured({ numRocks: value });
        assert.equal(sim.totalRocks, 100, `numRocks=${value} no es entero y debe caer a 100`);
    }
});

test('fragmentationEnabled solo conserva booleanos, incluido false', () => {
    for (const value of [true, false]) {
        const { sim } = configured({ fragmentationEnabled: value });
        assert.equal(sim.physics.fragmentationEnabled, value, `fragmentationEnabled=${value} debe conservarse`);
    }
    const invalid = [undefined, null, 0, 1, 'false', NaN, Infinity, -Infinity];
    let checks = 0;
    for (const value of invalid) {
        const { sim } = configured({ fragmentationEnabled: value });
        assert.equal(sim.physics.fragmentationEnabled, true, `fragmentationEnabled=${String(value)} debe caer a true`);
        checks++;
    }
    assert.equal(checks, invalid.length);
});

test('maxStepsPerRock se deriva de dt y maxDuration efectivos', () => {
    const { sim } = configured({ maxDuration: 7, timeStep: 0.02 });
    assert.equal(sim.physics.dt, 0.02);
    assert.equal(sim.maxDuration, 7);
    assert.equal(sim.maxStepsPerRock, Math.ceil(7 / 0.02));

    const { sim: cero } = configured({ maxDuration: 4, timeStep: 0 });
    assert.equal(cero.physics.dt, 0.005, 'timeStep=0 no es válido y cae al defecto');
    assert.equal(cero.maxStepsPerRock, Math.ceil(4 / 0.005));
});

test('start con maxDuration=0 conserva el configurado y con positivo lo usa', () => {
    const { sim } = configured({ numRocks: 1, timeStep: 0.01, maxDuration: 2, fragmentationEnabled: false });
    sim.start(0, 0, 0.5, 2700, 1, 0, 0, true, 'sphere', 0.6, 'freefall', null);
    assert.equal(sim.maxDuration, 2, 'maxDuration=0 en start conserva el configurado');
    assert.equal(sim.maxStepsPerRock, Math.ceil(2 / 0.01));

    const { sim: otra } = configured({ numRocks: 1, timeStep: 0.01, maxDuration: 2, fragmentationEnabled: false });
    otra.start(0, 0, 0.5, 2700, 1, 0, 5, true, 'sphere', 0.6, 'freefall', null);
    assert.equal(otra.maxDuration, 5, 'un maxDuration positivo en start se usa');
    assert.equal(otra.maxStepsPerRock, Math.ceil(5 / 0.01));
});

test('start ignora null, NaN, infinitos y negativos de maxDuration', () => {
    for (const bad of [null, NaN, Infinity, -Infinity, -3]) {
        const { sim } = configured({ numRocks: 1, timeStep: 0.01, maxDuration: 3, fragmentationEnabled: false });
        sim.start(0, 0, 0.5, 2700, 1, 0, bad, true, 'sphere', 0.6, 'freefall', null);
        assert.equal(sim.maxDuration, 3, `start con maxDuration=${String(bad)} debe conservar 3`);
        assert.equal(sim.maxStepsPerRock, Math.ceil(3 / 0.01));
    }
});

// Expresión anterior de configure, calculada aquí como referencia de equivalencia.
function before(params) {
    return {
        totalRocks: params.numRocks || 100,
        animationSpeed: params.animationSpeed || 50,
        gravity: params.gravity || 9.81,
        dt: params.timeStep || 0.005,
        cn: params.cn || 0.6,
        ct: params.ct || 0.4,
        rollingFriction: params.rollingFriction || 0.15,
        cnVariability: params.cnVariability || 10,
        ctVariability: params.ctVariability || 10,
        maxDuration: params.maxDuration || 30,
        fragmentationEnabled: params.fragmentationEnabled !== undefined ? params.fragmentationEnabled : true,
        fractureEnergy: params.fractureEnergy !== undefined ? params.fractureEnergy : 25000,
        fractureDissipation: params.fractureDissipation !== undefined ? params.fractureDissipation : 0.4
    };
}

test('equivalencia: configuraciones válidas distintas de cero dan los mismos efectivos', () => {
    const matrix = [
        { numRocks: 12, animationSpeed: 80, gravity: 9.81, timeStep: 0.005, cn: 0.6, ct: 0.4, rollingFriction: 0.15, cnVariability: 10, ctVariability: 10, maxDuration: 30, fragmentationEnabled: true, fractureEnergy: 25000, fractureDissipation: 0.4 },
        { numRocks: 3, animationSpeed: 1, gravity: 12.4, timeStep: 0.033, cn: 0.83, ct: 0.27, rollingFriction: 0.42, cnVariability: 3, ctVariability: 21, maxDuration: 9.5, fragmentationEnabled: false, fractureEnergy: 1000, fractureDissipation: 0.05 },
        { numRocks: 250, animationSpeed: 200, gravity: 1.62, timeStep: 0.001, cn: 0.05, ct: 0.95, rollingFriction: 0.9, cnVariability: 49, ctVariability: 1, maxDuration: 600, fragmentationEnabled: true, fractureEnergy: 90000, fractureDissipation: 0.9 }
    ];
    let checks = 0;
    for (const params of matrix) {
        const { sim } = configured(params);
        const old = before(params);
        assert.equal(sim.totalRocks, old.totalRocks);
        assert.equal(sim.animationSpeed, old.animationSpeed);
        assert.equal(sim.physics.gravity, old.gravity);
        assert.equal(sim.physics.dt, old.dt);
        assert.equal(sim.physics.cn, old.cn);
        assert.equal(sim.physics.ct, old.ct);
        assert.equal(sim.physics.rollingFriction, old.rollingFriction);
        assert.equal(sim.physics.cnVariability, old.cnVariability);
        assert.equal(sim.physics.ctVariability, old.ctVariability);
        assert.equal(sim.maxDuration, old.maxDuration);
        assert.equal(sim.maxStepsPerRock, Math.ceil(old.maxDuration / old.dt));
        assert.equal(sim.physics.fragmentationEnabled, old.fragmentationEnabled);
        assert.equal(sim.physics.fractureEnergy, old.fractureEnergy);
        assert.equal(sim.physics.fractureDissipation, old.fractureDissipation);
        checks += 14;
    }
    assert.equal(checks, 42, 'tres configuraciones por catorce campos efectivos');
});
