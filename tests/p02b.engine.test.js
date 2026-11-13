'use strict';

/**
 * Tests del motor P0.2-β (WB1): eventos de impacto por episodio (C1), altura
 * de vuelo (C3), los 8 campos por roca, su serialización y la variabilidad
 * aplicada al Cn/Ct de cada tramo (U4/I4).
 *
 * Contrafactual: `js/physics.js` de P0.3 (commit 67b34e52) se carga desde una
 * copia temporal en exec/WB1/ para verificar I1–I3 bit a bit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts, createContext, runScript } = require('./helpers/load');

const SEED = 20261112;
const C = '/home/xodla/.hermes/profiles/rocxkfall/reports/rockfall-p0';
const P03_PHYSICS = process.env.P03_PHYSICS || path.join(C, 'exec', 'WB1', 'p03-physics.js');
const G = 9.81;
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const DT = 0.005;

// --- Contextos --------------------------------------------------------------

function currentCtx(seed = SEED) {
    return loadScripts(['js/terrain.js', 'js/physics.js'], { seed });
}

function p03Ctx(seed = SEED) {
    const ctx = createContext({ seed });
    runScript(ctx, 'js/terrain.js');
    vm.runInContext(fs.readFileSync(P03_PHYSICS, 'utf8'), ctx, { filename: 'p03-physics.js' });
    return ctx;
}

// --- Terrenos ---------------------------------------------------------------

// Perfil con cuatro presets distintos (tramos 0..4).
function mixedTerrain(ctx) {
    const t = new ctx.SimRocas.Terrain();
    t.addPoint(0, 120, 'roca-suave');
    t.addPoint(60, 90, 'concreto');
    t.addPoint(130, 55, 'roca-dura');
    t.addPoint(220, 20, 'suelo');
    t.addPoint(350, 8, 'roca-suave');
    t.addPoint(450, 8, 'concreto');
    return t;
}

// Suelo plano; `cn`/`ct`/`roughness` sobrescriben el preset del tramo 0.
function flatTerrain(ctx, opts = {}) {
    const t = new ctx.SimRocas.Terrain();
    const type = opts.type || 'concreto';
    t.addPoint(0, 0, type);
    t.addPoint(opts.len || 2000, 0, type);
    if (opts.cn !== undefined) {
        t.segments[0].cn = opts.cn;
        t.segments[0].ct = opts.ct;
        t.segments[0].roughness = opts.roughness === undefined ? 0 : opts.roughness;
    }
    return t;
}

// Dos tramos con presets distintos: el 1 es 'roca-dura' (cn 0.80, ct 0.20).
function twoSegmentTerrain(ctx) {
    const t = new ctx.SimRocas.Terrain();
    t.addPoint(0, 20, 'concreto');
    t.addPoint(100, 0, 'concreto');
    t.addPoint(400, 0, 'roca-dura');
    return t;
}

function makeEngine(ctx, calcMethod, opts = {}) {
    const e = new ctx.SimRocas.PhysicsEngine();
    e.calcMethod = calcMethod;
    e.fragmentationEnabled = false;
    for (const k of Object.keys(opts)) e[k] = opts[k];
    return e;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// --- I1/I2: contrafactual bit a bit ----------------------------------------

const BIT_FIELDS = ['x', 'y', 'vx', 'vy', 'angularVelocity', 'stopReason', 'elapsedTime', 'bounces'];

function runSuite(ctx, variability, withBarrier) {
    const terrain = mixedTerrain(ctx);
    const barriers = withBarrier
        ? [{ x1: 205, y1: 0, x2: 205, y2: 40, cn: 0.5, ct: 0.4, thickness: 0.15 }]
        : [];
    const out = {};
    let offProfile = 0;
    for (const method of METHODS) {
        const e = makeEngine(ctx, method, { cnVariability: variability, ctVariability: variability });
        const rows = [];
        for (let i = 0; i < 4; i++) {
            const rock = e.createRock(10, 125, 0.5, 2700, 1, 0, 'polygon', 0.6);
            for (let s = 0; s < 4000 && !rock.isResting; s++) e.simulateStep(rock, terrain, DT, barriers);
            const row = {};
            for (const f of BIT_FIELDS) row[f] = rock[f];
            rows.push(row);
            offProfile += offProfileImpacts(rock, terrain);
        }
        out[method] = rows;
    }
    out.offProfile = offProfile;
    return out;
}

// Guarda de I1 (E2.2): impactos de terreno cuyo centro queda a menos de 1 m
// (dos radios) del extremo del perfil o más allá. P0.3 no registra eventos.
function offProfileImpacts(rock, terrain) {
    const first = terrain.points[0].x;
    const last = terrain.points[terrain.points.length - 1].x;
    return (rock.impactEvents || []).filter(ev => ev.surface === 'terrain' &&
        !(ev.x >= first + 1 && ev.x <= last - 1)).length;
}

function assertBitEqual(got, want, label) {
    for (const method of METHODS) {
        for (let i = 0; i < got[method].length; i++) {
            for (const f of BIT_FIELDS) {
                const a = got[method][i][f];
                const b = want[method][i][f];
                assert.ok(Object.is(a, b),
                    `${label} ${method} roca ${i} ${f}: P0.2-β=${a} P0.3=${b}`);
            }
        }
    }
}

// Corrida de masa concentrada aislada: su física no cambia con U4, así que
// debe coincidir bit a bit con P0.3 con cualquier variabilidad (I2) y gastar
// exactamente los mismos sorteos (I3).
function runLumped(ctx, variability) {
    const terrain = mixedTerrain(ctx);
    const e = makeEngine(ctx, 'lumped-mass', { cnVariability: variability, ctVariability: variability });
    const rows = [];
    for (let i = 0; i < 4; i++) {
        const rock = e.createRock(10, 125, 0.5, 2700, 1, 0, 'polygon', 0.6);
        for (let s = 0; s < 4000 && !rock.isResting; s++) e.simulateStep(rock, terrain, DT, []);
        const row = {};
        for (const f of BIT_FIELDS) row[f] = rock[f];
        rows.push(row);
    }
    return rows;
}

test('I1: variabilidad 0 reproduce P0.3 bit a bit en los 3 métodos, con y sin barrera', () => {
    const got = runSuite(currentCtx(), 0, false);
    const want = runSuite(p03Ctx(), 0, false);
    assert.equal(got.offProfile, 0, 'guarda I1 sin barrera: el fixture no tiene impactos fuera del perfil');
    assertBitEqual(got, want, 'I1 sin barrera');

    const gotB = runSuite(currentCtx(), 0, true);
    const wantB = runSuite(p03Ctx(), 0, true);
    assert.equal(gotB.offProfile, 0, 'guarda I1 con barrera: el fixture no tiene impactos fuera del perfil');
    assertBitEqual(gotB, wantB, 'I1 con barrera');
});

test('I2: masa concentrada es idéntica a P0.3 con variabilidad del 30 %', () => {
    const got = runLumped(currentCtx(), 30);
    const want = runLumped(p03Ctx(), 30);
    for (let i = 0; i < got.length; i++) {
        for (const f of BIT_FIELDS) {
            assert.ok(Object.is(got[i][f], want[i][f]), `I2 lumped-mass roca ${i} ${f}`);
        }
    }
});

// --- I3: sorteos ------------------------------------------------------------

function countRandom(ctx) {
    ctx.__randCalls = 0;
    vm.runInContext(
        'Math.random = (function (orig) { return function () { __randCalls++; return orig(); }; })(Math.random);',
        ctx
    );
}

test('I3: la cantidad de llamadas a Math.random por corrida no cambia', () => {
    // Masa concentrada: su física no cambia, así que la corrida completa debe
    // gastar exactamente los mismos sorteos que P0.3.
    const a = currentCtx();
    countRandom(a);
    runLumped(a, 10);
    const b = p03Ctx();
    countRandom(b);
    runLumped(b, 10);
    assert.equal(a.__randCalls, b.__randCalls, 'sorteos P0.2-β vs P0.3');
    assert.ok(a.__randCalls > 0, 'la corrida debe sortear');

    // Sin contactos la variación gasta un sorteo por coeficiente y paso.
    const c = currentCtx();
    countRandom(c);
    const e = makeEngine(c, 'rigid-body', { cnVariability: 10, ctVariability: 10 });
    const rock = e.createRock(100, 500, 0.5, 2700, 0, 0, 'sphere');
    const before = c.__randCalls;
    e.simulateStep(rock, mixedTerrain(c), DT, []);
    assert.equal(c.__randCalls - before, 4, 'cuatro sorteos por paso (cn, ct, kn, kt)');
});

// --- I4: Cn/Ct efectivos del tramo -----------------------------------------

function firstImpactOnSecondSegment(ctx, opts) {
    const terrain = twoSegmentTerrain(ctx);
    const e = makeEngine(ctx, 'rigid-body', opts);
    const rock = e.createRock(120, 6, 0.5, 2700, 0, 0, 'sphere');
    rock.angularVelocity = 0;
    rock.vx = 0;
    ctx.__draws = [];
    vm.runInContext(
        'Math.random = (function (orig) { return function () { const v = orig(); __draws.push(v); return v; }; })(Math.random);',
        ctx
    );
    let firstDraw = null;
    for (let s = 0; s < 400 && rock.impactEvents.length === 0; s++) {
        const before = ctx.__draws.length;
        e.simulateStep(rock, terrain, DT, []);
        if (rock.impactEvents.length > 0) {
            firstDraw = ctx.__draws[before];
        }
    }
    return { rock, terrain, engine: e, firstDraw };
}

test('I4: con variabilidad 0 el cnEff es el cn del tramo y los globales no influyen', () => {
    const ctx = currentCtx();
    const { rock } = firstImpactOnSecondSegment(ctx, { cnVariability: 0, ctVariability: 0, cn: 0.9, ct: 0.05 });
    assert.equal(rock.impactEvents.length, 1, 'un impacto');
    const ev = rock.impactEvents[0];
    assert.equal(ev.surface, 'terrain');
    assert.equal(ev.index, 1, 'tramo 1');
    assert.equal(ev.cnEff, 0.8, 'cnEff = cn del tramo (roca-dura)');
    assert.equal(ev.ctEff, 0.2, 'ctEff = ct del tramo (roca-dura)');
});

test('I4: con variabilidad > 0 el cnEff es clamp01(seg.cn × factor) del mismo sorteo', () => {
    const ctx = currentCtx();
    const variability = 20;
    const { rock, firstDraw } = firstImpactOnSecondSegment(ctx, { cnVariability: variability, ctVariability: variability });
    assert.ok(typeof firstDraw === 'number', 'debe haber un sorteo en el paso del impacto');
    const factor = 1 + (firstDraw * 2 - 1) * (variability / 100);
    const ev = rock.impactEvents[0];
    assert.equal(ev.cnEff, clamp01(0.8 * factor));
    assert.ok(ev.cnEff !== 0.8, 'la variabilidad debe mover el coeficiente');
});


// --- E2.2: impactos sobre la prolongación del perfil ------------------------

// Tramo 0 'concreto' en [0, 5] y tramo 1 'roca-dura' (cn 0.80, ct 0.20) en [5, 10].
function shortTerrain(ctx) {
    const t = new ctx.SimRocas.Terrain();
    t.addPoint(0, 0, 'concreto');
    t.addPoint(5, 0, 'concreto');
    t.addPoint(10, 0, 'roca-dura');
    return t;
}

function dropOffProfile(ctx, method, x, opts) {
    const terrain = shortTerrain(ctx);
    const e = makeEngine(ctx, method, opts);
    const rock = e.createRock(x, 6, 0.5, 2700, 0, 0, 'sphere');
    rock.angularVelocity = 0;
    rock.vx = 0;
    ctx.__draws = [];
    vm.runInContext(
        'Math.random = (function (orig) { return function () { const v = orig(); __draws.push(v); return v; }; })(Math.random);',
        ctx
    );
    let firstDraw = null;
    for (let s = 0; s < 600 && !rock.isResting; s++) {
        const before = ctx.__draws.length;
        const had = rock.impactEvents.length;
        e.simulateStep(rock, terrain, DT, []);
        if (had === 0 && rock.impactEvents.length > 0) firstDraw = ctx.__draws[before];
    }
    const state = {};
    for (const f of BIT_FIELDS) state[f] = rock[f];
    return { rock, terrain, firstDraw, state, draws: ctx.__draws.length };
}

for (const method of ['rigid-body', 'nonsmooth']) {
    for (const [side, x, index] of [['derecha', 15, 1], ['izquierda', -5, 0]]) {
        test(`E2.2 ${method}: el impacto fuera del perfil por la ${side} usa el tramo extremo`, () => {
            const base = dropOffProfile(currentCtx(), method, x, { cnVariability: 0, ctVariability: 0 });
            const seg = base.terrain.segments[index];
            assert.ok(base.rock.impactEvents.length > 0, 'debe haber impactos');
            for (const ev of base.rock.impactEvents) {
                assert.equal(ev.surface, 'terrain');
                assert.ok(ev.x < 0 || ev.x > 10, 'el impacto ocurre fuera del perfil');
                assert.equal(ev.index, index, 'index del tramo extremo más cercano');
                assert.equal(ev.cnEff, seg.cn, 'cnEff = cn del tramo extremo');
                if (method === 'rigid-body') assert.equal(ev.ctEff, seg.ct, 'ctEff = ct del tramo extremo');
            }
            // Los globales no alteran la corrida ni la cantidad de sorteos (I3).
            const other = dropOffProfile(currentCtx(), method, x, { cnVariability: 0, ctVariability: 0, cn: 0.95, ct: 0.05 });
            for (const f of BIT_FIELDS) {
                assert.ok(Object.is(other.state[f], base.state[f]), `globales sin efecto en ${f}: ${other.state[f]} vs ${base.state[f]}`);
            }
            assert.equal(other.draws, base.draws, 'misma cantidad de sorteos');
            assert.equal(JSON.stringify(other.rock.impactEvents), JSON.stringify(base.rock.impactEvents));
        });
    }
}

test('E2.2: fuera del perfil la variabilidad multiplica el cn del tramo extremo (factor de I4)', () => {
    const variability = 20;
    const { rock, firstDraw } = dropOffProfile(currentCtx(), 'rigid-body', 15, { cnVariability: variability, ctVariability: variability });
    assert.ok(typeof firstDraw === 'number', 'debe haber un sorteo en el paso del impacto');
    const factor = 1 + (firstDraw * 2 - 1) * (variability / 100);
    assert.equal(rock.impactEvents[0].index, 1);
    assert.equal(rock.impactEvents[0].cnEff, clamp01(0.8 * factor));
});

test('E2.2: con menos de 2 puntos siguen actuando los Cn/Ct globales', () => {
    const run = (cn) => {
        const ctx = currentCtx();
        const t = new ctx.SimRocas.Terrain();
        t.addPoint(0, 0, 'concreto');
        const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0, cn, ct: 0.4 });
        const rock = e.createRock(3, 6, 0.5, 2700, 0, 0, 'sphere');
        rock.angularVelocity = 0;
        rock.vx = 0;
        for (let s = 0; s < 400 && rock.impactEvents.length === 0; s++) e.simulateStep(rock, t, DT, []);
        return rock.impactEvents[0];
    };
    const ev = run(0.33);
    assert.ok(ev, 'debe haber un impacto');
    assert.equal(ev.cnEff, 0.33, 'cnEff = Cn global');
    assert.equal(ev.index, 0);
});

// --- C1: eventos ------------------------------------------------------------

function runTillEvents(engine, terrain, rock, count, maxSteps = 6000, barriers = []) {
    for (let s = 0; s < maxSteps; s++) {
        if (rock.impactCount >= count) return true;
        if (rock.isResting) return false;
        engine.simulateStep(rock, terrain, DT, barriers);
    }
    return rock.impactCount >= count;
}

test('C1: caída vertical sobre suelo plano registra 1 evento antes del impulso', () => {
    const expected = Math.sqrt(2 * G * (5 - 0.25));
    for (const method of METHODS) {
        const ctx = currentCtx();
        const terrain = flatTerrain(ctx, { cn: 0.85, ct: 0.15, roughness: 0 });
        const e = makeEngine(ctx, method, { cnVariability: 0, ctVariability: 0 });
        const rock = e.createRock(100, 5, 0.5, 2700, 0, 0, 'sphere');
        rock.vx = 0;
        rock.angularVelocity = 0;
        assert.ok(runTillEvents(e, terrain, rock, 1), `${method}: debe haber un evento`);
        assert.equal(rock.impactEvents.length, 1, `${method}: exactamente un evento`);
        const ev = rock.impactEvents[0];
        assert.equal(ev.surface, 'terrain', method);
        assert.equal(ev.index, 0, method);
        assert.ok(Math.abs(ev.vn - expected) / expected < 0.05,
            `${method}: vn ${ev.vn} debe ser la velocidad de llegada ${expected}`);
        assert.ok(Math.abs(ev.speed - expected) / expected < 0.05,
            `${method}: speed ${ev.speed} debe ser la rapidez de llegada ${expected}`);
        assert.ok(Math.abs(ev.energy - 0.5 * rock.mass * expected * expected) / (0.5 * rock.mass * expected * expected) < 0.1,
            `${method}: energía previa ${ev.energy}`);
        assert.ok(ev.t > 0 && ev.x > 0 && ev.y > 0, `${method}: t, x e y finitos`);
        assert.ok(rock.maxImpactNormalSpeed >= ev.vn - 1e-12, method);
        if (method === 'lumped-mass') {
            assert.equal(ev.contactSpeed, null, 'masa concentrada no tiene punto de contacto');
        } else {
            assert.ok(Math.abs(ev.contactSpeed - expected) / expected < 0.05, `${method}: contactSpeed`);
        }
    }
});

test('C1: una roca rodando en contacto sostenido no genera eventos', () => {
    const ctx = currentCtx();
    const terr = new ctx.SimRocas.Terrain();
    terr.addPoint(0, 20, 'suelo');
    terr.addPoint(400, 0, 'suelo');
    terr.segments[0].roughness = 5;
    const e = makeEngine(ctx, 'lumped-mass', { cnVariability: 0, ctVariability: 0 });
    // Apoyada sobre el talud y con velocidad tangencial: contacto sostenido.
    const x0 = 20;
    const y0 = terr.getHeightAt(x0) + 0.25;
    const rock = e.createRock(x0, y0, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 2;
    rock.vy = -0.02;
    rock.angularVelocity = 0;
    for (let s = 0; s < 600; s++) e.simulateStep(rock, terr, DT, []);
    assert.ok(rock.x > x0, 'la roca debe haber rodado');
    assert.equal(rock.impactCount, 0, 'el contacto sostenido no es un impacto');
    assert.equal(rock.impactEvents.length, 0);
    assert.equal(rock.maxImpactNormalSpeed, null);
});

test('C1: una roca en reposo sostenido no genera eventos nuevos', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 0.6, ct: 0.3, roughness: 0 });
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0 });
    const rock = e.createRock(100, 1.5, 0.5, 2700, 0, 0, 'sphere');
    rock.angularVelocity = 0;
    for (let s = 0; s < 4000 && !rock.isResting; s++) e.simulateStep(rock, terrain, DT, []);
    assert.ok(rock.isResting, 'la roca debe quedar en reposo');
    const count = rock.impactCount;
    for (let s = 0; s < 300; s++) e.simulateStep(rock, terrain, DT, []);
    assert.equal(rock.impactCount, count, 'el reposo no agrega eventos');
});

test('C1: un rebote doble genera 2 eventos', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 0.85, ct: 0.15, roughness: 0 });
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0 });
    const rock = e.createRock(100, 8, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.angularVelocity = 0;
    assert.ok(runTillEvents(e, terrain, rock, 2), 'debe haber 2 eventos');
    assert.equal(rock.impactEvents.length, 2);
    assert.equal(rock.impactEvents[0].surface, 'terrain');
    assert.ok(rock.impactEvents[1].t > rock.impactEvents[0].t, 'en orden temporal');
    assert.ok(rock.impactEvents[0].vn > rock.impactEvents[1].vn, 'el segundo rebote es más débil');
});

test('C1: el evento de barrera trae surface barrier, índice correcto y contactSpeed null', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 0.6, ct: 0.3, roughness: 0, len: 2000 });
    terrain.points[0].y = -200;
    terrain.points[1].y = -200;
    const barriers = [
        { x1: 900, y1: 0, x2: 900, y2: 40, cn: 0.5, ct: 0.4, thickness: 0.15 },
        { x1: 110, y1: -5, x2: 110, y2: 20, cn: 0.5, ct: 0.4, thickness: 0.15 }
    ];
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0 });
    const rock = e.createRock(100, 5, 0.5, 2700, 0, 0, 'sphere');
    rock.angularVelocity = 0;
    rock.vx = 12;
    rock.vy = 0;
    assert.ok(runTillEvents(e, terrain, rock, 1, 400, barriers), 'debe golpear la barrera');
    const ev = rock.impactEvents[0];
    assert.equal(ev.surface, 'barrier');
    assert.equal(ev.index, 1, 'índice de la barrera golpeada');
    assert.equal(ev.contactSpeed, null);
    assert.ok(ev.vn > 0 && ev.speed > 0 && ev.energy > 0);
});

// --- C3: altura de vuelo ----------------------------------------------------

test('C3: sin vuelo posterior a un impacto, maxFlightHeight es null', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 0.6, ct: 0.3, roughness: 0 });
    // kn = 0: el impulso anula la velocidad normal y la roca queda en reposo
    // en el mismo sub-paso, sin ningún vuelo que muestrear.
    const e = makeEngine(ctx, 'lumped-mass', { cnVariability: 0, ctVariability: 0, kn: 0, kt: 0 });
    const rock = e.createRock(100, 0.25 + 0.02, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -2;
    rock.angularVelocity = 0;
    rock.bounces = 3;
    rock._restCheckCount = 3;
    let sawEvent = false;
    for (let s = 0; s < 50; s++) {
        e.simulateStep(rock, terrain, DT, []);
        if (rock.impactCount > 0) sawEvent = true;
        if (rock.isResting) break;
    }
    assert.ok(sawEvent, 'debe registrarse el impacto');
    assert.ok(rock.isResting, 'la roca queda en reposo en ese impacto');
    assert.equal(rock.maxFlightHeight, null, 'sin muestras de vuelo');
});

test('C3: con vuelo, la altura máxima coincide con la balística y alimenta el 2º evento', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 0.6, ct: 0.3, roughness: 0 });
    // Masa concentrada: punto material sin giro, así el vuelo es balístico
    // puro y la altura se puede comparar con la analítica.
    const e = makeEngine(ctx, 'lumped-mass', { cnVariability: 0, ctVariability: 0, kn: 0.9, kt: 0.9 });
    const rock = e.createRock(100, 6, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.angularVelocity = 0;
    assert.ok(runTillEvents(e, terrain, rock, 2, 4000), 'debe haber 2 eventos');
    assert.ok(rock.maxFlightHeight !== null, 'debe medirse el vuelo');

    // Vuelo entre dos contactos a la misma altura: el máximo del centro sobre
    // el terreno es y_contacto + v²/(2g) con v la rapidez normal de llegada
    // del 2º contacto (independiente de la restitución).
    const second = rock.impactEvents[1];
    const ballistic = second.y + (second.vn * second.vn) / (2 * G);
    assert.ok(Math.abs(rock.maxFlightHeight - ballistic) < 0.05,
        `altura de vuelo ${rock.maxFlightHeight} vs balística ${ballistic}`);
    assert.ok(Math.abs(second.flightHeightBefore - ballistic) < 0.05,
        `flightHeightBefore ${second.flightHeightBefore} vs balística ${ballistic}`);
    assert.equal(second.flightHeightBefore, rock.maxFlightHeight,
        'el máximo del vuelo es el heredado por el 2º evento');
    assert.equal(rock.impactEvents[0].flightHeightBefore, null, 'el primer impacto no tiene vuelo previo');
    assert.ok(rock.maxFlightHeight > 1, 'el rebote debe ser apreciable');
});

test('C3: fuera del perfil no se toman muestras', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 1, ct: 1, roughness: 0, len: 5 });
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0 });
    const rock = e.createRock(4.5, 3, 0.5, 2700, 0, 0, 'sphere');
    rock.angularVelocity = 0;
    rock.vx = 60;
    rock.vy = 0;
    for (let s = 0; s < 400 && !rock.isResting; s++) e.simulateStep(rock, terrain, DT, []);
    assert.ok(rock.impactCount > 0, 'debe haber contactos (se extrapola el extremo)');
    assert.equal(rock.maxFlightHeight, null, 'ninguna muestra dentro del perfil');
});

// --- Tope de eventos --------------------------------------------------------

test('tope: más de 200 eventos guarda los primeros 200 y droppedImpactEvents cuadra', () => {
    const ctx = currentCtx();
    const terrain = flatTerrain(ctx, { cn: 0.85, ct: 0.15, roughness: 0 });
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0 });
    const rock = e.createRock(100, 0.24, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;

    for (let i = 0; i < 250; i++) {
        rock.isResting = false;
        rock._restCheckCount = 0;
        rock.y = 0.2;
        rock.vy = -6;
        rock.vx = 0;
        rock.angularVelocity = 0;
        rock._verticesDirty = true;
        rock.handleCollision(terrain, 0.85, 0.15, 'impulse', 0.7, 'rigid-body', 0.35, 0.75, 1, 1);
        rock.closeImpactEpisodes();
        rock.y = 6;
        rock.vy = 0;
        rock._verticesDirty = true;
        rock.handleCollision(terrain, 0.85, 0.15, 'impulse', 0.7, 'rigid-body', 0.35, 0.75, 1, 1);
        rock.closeImpactEpisodes();
    }

    assert.equal(rock.impactCount, 250, 'cuenta también los descartados');
    assert.equal(rock.impactEvents.length, 200, 'guarda los primeros 200');
    assert.equal(rock.droppedImpactEvents, 50);
    assert.equal(rock.maxImpactNormalSpeed, 6, 'los máximos incluyen los descartados');
    assert.equal(rock.maxImpactSpeed, 6);
});

// --- Serialización ----------------------------------------------------------

function loadWorker() {
    const msgs = [];
    const ctx = createContext({
        env: 'worker',
        extra: {
            postMessage: (m) => msgs.push(m),
            importScripts: (...files) => files.forEach((f) => runScript(ctx, 'js/' + f))
        }
    });
    runScript(ctx, 'js/worker.js');
    ctx.__msgs = msgs;
    return ctx;
}

test('serialización: serializeRocks incluye los 8 campos con copias de los eventos', () => {
    const ctx = loadWorker();
    const terrain = flatTerrain(ctx, { cn: 0.85, ct: 0.15, roughness: 0 });
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: 0, ctVariability: 0 });
    const rock = e.createRock(100, 4, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.angularVelocity = 0;
    assert.ok(runTillEvents(e, terrain, rock, 1, 2000), 'debe haber un impacto');

    const out = ctx.serializeRocks([rock])[0];
    const keys = ['impactCount', 'maxImpactNormalSpeed', 'maxImpactSpeed', 'maxImpactContactSpeed',
        'maxImpactEnergy', 'maxFlightHeight', 'impactEvents', 'droppedImpactEvents'];
    for (const k of keys) {
        assert.ok(Object.prototype.hasOwnProperty.call(out, k), `falta ${k}`);
    }
    assert.equal(out.impactCount, rock.impactCount);
    assert.equal(out.droppedImpactEvents, out.impactCount - out.impactEvents.length);
    assert.ok(Array.isArray(out.impactEvents) && out.impactEvents.length === 1);
    assert.notStrictEqual(out.impactEvents[0], rock.impactEvents[0], 'copia, no referencia');
    assert.deepEqual(Object.keys(out.impactEvents[0]).sort(), [
        'cnEff', 'contactSpeed', 'ctEff', 'energy', 'flightHeightBefore', 'index', 'surface', 'speed', 't', 'vn', 'x', 'y'
    ].sort());
    for (const v of Object.values(out.impactEvents[0])) {
        if (typeof v === 'number') assert.ok(Number.isFinite(v), 'números finitos');
    }
});

// --- CB2b: P02B-3 y RVBa-2 ---------------------------------------------------

for (const [side, x, index] of [['derecha', 15, 1], ['izquierda', -5, 0]]) {
    test(`P02B-3 masa concentrada: fuera del perfil por la ${side} el index es el del tramo extremo`, () => {
        const run = dropOffProfile(currentCtx(), 'lumped-mass', x, { cnVariability: 0, ctVariability: 0 });
        assert.ok(run.rock.impactEvents.length > 0, 'debe haber impactos');
        for (const ev of run.rock.impactEvents) {
            assert.equal(ev.surface, 'terrain');
            assert.ok(ev.x < 0 || ev.x > 10, 'el impacto ocurre fuera del perfil');
            assert.equal(ev.index, index, 'index del tramo extremo más cercano');
            assert.equal(ev.contactSpeed, null);
        }
    });
}

// Masa concentrada que cruza el extremo derecho del perfil corto: estado y
// cantidad de sorteos, para comparar con P0.3 (que no registra eventos).
function runLumpedOffProfile(ctx, variability) {
    const terrain = shortTerrain(ctx);
    const e = makeEngine(ctx, 'lumped-mass', { cnVariability: variability, ctVariability: variability });
    countRandom(ctx);
    const rows = [];
    const events = [];
    for (let i = 0; i < 4; i++) {
        const rock = e.createRock(7, 6, 0.5, 2700, 3, 0, i % 2 ? 'sphere' : 'polygon', 0.6);
        for (let s = 0; s < 3000 && !rock.isResting; s++) e.simulateStep(rock, terrain, DT, []);
        const row = {};
        for (const f of BIT_FIELDS) row[f] = rock[f];
        rows.push(row);
        events.push(...(rock.impactEvents || []));
    }
    return { rows, events, draws: ctx.__randCalls };
}

test('I2 con P02B-3: masa concentrada con impactos fuera del perfil sigue idéntica a P0.3', () => {
    for (const variability of [0, 30]) {
        const got = runLumpedOffProfile(currentCtx(), variability);
        const want = runLumpedOffProfile(p03Ctx(), variability);
        const outside = got.events.filter(ev => ev.surface === 'terrain' && ev.x > 10);
        assert.ok(outside.length > 0, 'precondición: hay impactos fuera del perfil');
        for (const ev of outside) assert.equal(ev.index, 1, 'index del tramo extremo');
        for (let i = 0; i < got.rows.length; i++) {
            for (const f of BIT_FIELDS) {
                assert.ok(Object.is(got.rows[i][f], want.rows[i][f]),
                    `I2 variabilidad ${variability} roca ${i} ${f}: ${got.rows[i][f]} vs ${want.rows[i][f]}`);
            }
        }
        assert.equal(got.draws, want.draws, 'misma cantidad de sorteos (I3)');
    }
});

test('RVBa-2: un tramo sin type recibe la variabilidad del 30 % (I4)', () => {
    const ctx = currentCtx();
    const terrain = new ctx.SimRocas.Terrain();
    terrain.fromJSON(JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
        segments: [{ cn: 0.5, ct: 0.5, roughness: 0 }], scale: 1 }));
    assert.ok(!terrain.segments[0].type, 'precondición: el tramo no tiene type');
    const variability = 30;
    const e = makeEngine(ctx, 'rigid-body', { cnVariability: variability, ctVariability: variability, cn: 0.11, ct: 0.93 });
    const rock = e.createRock(200, 6, 0.5, 2700, 0, 0, 'sphere');
    rock.angularVelocity = 0;
    rock.vx = 0;
    ctx.__draws = [];
    vm.runInContext(
        'Math.random = (function (orig) { return function () { const v = orig(); __draws.push(v); return v; }; })(Math.random);',
        ctx
    );
    let firstDraw = null;
    for (let s = 0; s < 400 && rock.impactEvents.length === 0; s++) {
        const before = ctx.__draws.length;
        e.simulateStep(rock, terrain, DT, []);
        if (rock.impactEvents.length > 0) firstDraw = ctx.__draws[before];
    }
    assert.ok(typeof firstDraw === 'number', 'debe haber un sorteo en el paso del impacto');
    const ev = rock.impactEvents[0];
    assert.equal(ev.index, 0);
    assert.equal(ev.cnEff, clamp01(0.5 * (1 + (firstDraw * 2 - 1) * (variability / 100))));
    assert.notEqual(ev.cnEff, 0.5, 'la variabilidad debe mover el coeficiente');
});
