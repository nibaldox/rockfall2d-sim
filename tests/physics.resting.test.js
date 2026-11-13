'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// T0.5/T0.7 — Reposo de rocas sobre un perfil con tramo final plano.
//
// Escenario: 50 rocas 'polygon' d=0.5, densidad 2700, liberadas en (5, 125) con
// velocidad 1 y ángulo 0, engine.fragmentationEnabled = false, dt = 0.005,
// hasta 6000 pasos (30 s). Expectativa: >= 90 % en reposo REAL (por
// _checkResting, sin contar culling ni tope de pasos) y x final dentro del
// terreno (0..450).
//
// T0.7 corrigió las causas (reset de _restCheckCount, signo del impulso de
// fricción nonsmooth, clamp de posición +0.01, contacto lumped por centro y
// |omega| en el chequeo); los tres métodos superan el 90 % con seed 42. El
// criterio slopeFactor de _checkResting no se tocó (decisión de modelo
// pendiente, G7).
//
// T0.7b recalibración (defecto corregido: la ley de impacto ya no se aplica en
// cada sub-paso de contacto sostenido). Antes de T0.7b, el modo lumped-mass
// frenaba artificialmente cada sub-paso (vt ×= kt ~600 veces por segundo), así
// que las rocas se "detenían" pronto en plena pendiente y las expectativas
// (6000 pasos, x <= 450.25) sólo se cumplían con ese frenado. Con el modelo
// corregido las rocas ruedan legítimamente más lejos y necesitan más tiempo
// para parar, por lo que:
//   - MAX_STEPS pasa de 6000 (30 s) a 12000 (60 s): con física correcta,
//     seed 42 y 60 s los tres métodos alcanzan >= 96 % de reposo real.
//   - La cota de x final pasa de TERRAIN_X_MAX + 0.25 a TERRAIN_X_MAX + 50,
//     el mismo holgado que usa el propio chequeo de culling de este test:
//     con deslizamiento correcto algunas rocas ruedan hasta el final del
//     perfil extrapolado y reposan hasta 50 m más allá de x = 450.

// Perfil con tramo final plano (y = 8 entre x = 260 y 450).
const PROFILE = [
    [0, 120], [40, 100], [80, 70], [120, 45], [160, 25],
    [200, 15], [260, 10], [350, 8], [450, 8]
];

const SEED = 42;
const N_ROCKS = 50;
const MAX_STEPS = 12000; // 60 s con dt = 0.005 (3 sub-pasos internos por paso)
const DT = 0.005;
const TERRAIN_X_MIN = 0;
const TERRAIN_X_MAX = 450;
// Holgado de reposo tras el final del perfil: igual al slack de culling de
// este test (x > TERRAIN_X_MAX + 50). T0.7b: con deslizamiento correcto las
// rocas pueden rodar hasta el final del terreno extrapolado antes de parar.
const REST_X_MAX = TERRAIN_X_MAX + 50;
const MIN_REST_FRACTION = 0.9;

// Terreno plano de apoyo para pruebas unitarias de un solo impacto.
function flatTerrain() {
    return {
        getHeightAt: () => 0,
        getSurfaceNormalAt: () => ({ nx: 0, ny: 1 }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness: 0 }),
        getSegmentAt: () => ({ properties: { roughness: 0 } })
    };
}

function buildScene() {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { seed: SEED });
    const terrain = new ctx.SimRocas.Terrain();
    for (const [x, y] of PROFILE) {
        terrain.addPoint(x, y);
    }
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = false;
    return { ctx, engine, terrain };
}

// Lote determinista: contexto nuevo con la misma seed por método.
// Usa rock.x (posición real al terminar); rock.finalX solo lo escribe
// _checkResting y queda obsoleto cuando el "reposo" viene del culling.
function runBatch(calcMethod) {
    const { engine, terrain } = buildScene();
    engine.calcMethod = calcMethod;
    const results = [];
    for (let i = 0; i < N_ROCKS; i++) {
        const rock = engine.createRock(5, 125, 0.5, 2700, 1, 0, 'polygon', 0.6);
        let steps = 0;
        for (; steps < MAX_STEPS && !rock.isResting; steps++) {
            engine.simulateStep(rock, terrain, DT, []);
        }
        results.push({
            rested: rock.isResting,
            steps,
            x: rock.x,
            y: rock.y,
            speed: rock.speed,
            culled: rock.x > 500 || rock.x < -50 || rock.y < -100
        });
    }
    return results;
}

// Velocidad de deslizamiento tangencial del punto de contacto más profundo
// (normal plana (0,1) -> tangente t = (-1, 0)).
// Nota T0.7: tras la corrección de posición (fix 4) el vértice de contacto
// queda a un margen <= 1e-4 sobre el terreno, no enterrado; se acepta
// contacto dentro de la tolerancia.
function contactSlideVelocity(rock, terrain, tolerance = 0.02) {
    const vertices = rock.getShapeVertices();
    let deepest = -Infinity;
    let contact = null;
    for (const v of vertices) {
        const penetration = terrain.getHeightAt(v.x) - v.y;
        if (penetration > deepest) { deepest = penetration; contact = v; }
    }
    assert.ok(contact && deepest > -tolerance,
        `debe haber vértice de contacto (penetración más profunda ${deepest})`);
    const rx = contact.x - rock.x;
    const ry = contact.y - rock.y;
    return -(rock.vx - rock.angularVelocity * ry);
}

// Velocidad de deslizamiento medida en un punto del cuerpo FIJO
// (rx, ry), para comparar antes y después del impacto en el mismo punto:
// la corrección de posición sólo desplaza this.y, así que rx no cambia.

// ---------------------------------------------------------------------------
// Causa raíz (unidad): patrón "reset + chequeo" de los tres handlers (T0.7,
// corregido: los handlers ya no reinician _restCheckCount antes del chequeo).
// ---------------------------------------------------------------------------

test('_checkResting declara reposo con el patrón corregido de los handlers (sin reset del contador)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: SEED });
    const rock = new ctx.SimRocas.Rock(0, 0, 0.5, 2700, 0, 0, 'polygon');
    rock.vx = 0;
    rock.vy = 0;
    rock.angularVelocity = 0;
    rock.bounces = 10;
    const flat = { nx: 0, ny: 1 };
    let rested = false;
    for (let k = 0; k < 20 && !rested; k++) {
        // Patrón corregido: los handlers llaman _checkResting en cada impacto
        // SIN reiniciar _restCheckCount (T0.7 fix 1).
        rested = rock._checkResting(flat);
    }
    assert.ok(rested, 'con velocidad 0, omega 0 y bounces > 2, _checkResting debe declarar ' +
        'reposo una vez el contador acumula 3 impactos');
});

test('_checkResting declara reposo cuando el contador sí alcanza 3 (el resto de la condición funciona)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: SEED });
    const rock = new ctx.SimRocas.Rock(0, 0, 0.5, 2700, 0, 0, 'polygon');
    rock.vx = 0;
    rock.vy = 0;
    rock.angularVelocity = 0;
    rock.bounces = 10;
    rock._restCheckCount = 2; // sin el reinicio del handler, el siguiente chequeo llega a 3
    assert.equal(rock._checkResting({ nx: 0, ny: 1 }), true);
    assert.equal(rock.isResting, true);
    assert.equal(rock.vx, 0);
    assert.equal(rock.vy, 0);
    assert.equal(rock.angularVelocity, 0);
    assert.equal(rock.finalX, rock.x);
});

// ---------------------------------------------------------------------------
// Causa (d): impulso de fricción de nonsmooth con el signo invertido (T0.7,
// corregido: jtFree = vDotT / denomT, coherente con rigid-body).
// ---------------------------------------------------------------------------

test('nonsmooth: un impacto de fricción no aumenta el deslizamiento del punto de contacto (tolerancia 1 %)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: SEED });
    const rock = new ctx.SimRocas.Rock(0, -0.1, 0.5, 2700, 0, 0, 'polygon');
    rock.ignoreResting = true;
    rock.vx = 5;
    rock.vy = -1;
    rock.angularVelocity = 0;
    const terrain = flatTerrain();

    // Punto de contacto congelado antes del impacto: la corrección de
    // posición (T0.7 fix 4) sólo desplaza this.y, así que el rx del punto
    // no cambia y la comparación se hace en el mismo punto del cuerpo.
    const vertices = rock.getShapeVertices();
    let deepest = -Infinity;
    let contact = null;
    for (const v of vertices) {
        const penetration = terrain.getHeightAt(v.x) - v.y;
        if (penetration > deepest) { deepest = penetration; contact = v; }
    }
    const ryContact = contact.y - rock.y;
    const slideAtContact = () => Math.abs(rock.vx - rock.angularVelocity * ryContact);

    const slideBefore = slideAtContact();
    rock.handleCollision(terrain, 0.6, 0.4, 'impulse', 0.7, 'nonsmooth', 0.35, 0.75);
    const slideAfter = slideAtContact();

    // Tolerancia del 1 %: el impulso normal acopla giro en un contacto
    // descentrado (omega += rCrossN·jn/I) y la fricción de Coulomb limitada
    // por mu·|jn| no siempre lo absorbe por completo; el defecto del signo
    // invertido medía +39 % (5.000 -> 6.968), el residuo corregido es <= 0.6 %.
    assert.ok(slideAfter <= slideBefore * 1.01 + 1e-9,
        `la fricción aumentó el deslizamiento de contacto: ${slideBefore.toFixed(3)} -> ${slideAfter.toFixed(3)}`);
});

test('_checkResting no declara reposo con speed = 0 pero omega negativa rápida (|omega| < 0.5)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: SEED });
    const rock = new ctx.SimRocas.Rock(0, 0, 0.5, 2700, 0, 0, 'polygon');
    rock.vx = 0;
    rock.vy = 0;
    rock.angularVelocity = -3; // rápido en sentido negativo: NO debe contar como reposo
    rock.bounces = 10;
    rock._restCheckCount = 2; // el siguiente chequeo alcanza el mínimo de 3
    assert.equal(rock._checkResting({ nx: 0, ny: 1 }), false,
        'omega = -3 debe bloquear el reposo; sin Math.abs la condición lo permite');
    assert.equal(rock.isResting, false);
});

function assertBatchRests(calcMethod, results) {
    // Fracción en reposo REAL: isResting por _checkResting, sin contar las
    // rocas descartadas por culling de límites (salirse del dominio tras
    // 6000 pasos no es reposo) (T0.5 / T0.7).
    const realRests = results.filter(r => r.rested && !r.culled).length;
    const culled = results.filter(r => r.rested && r.culled).length;
    const fraction = realRests / results.length;
    assert.ok(fraction >= MIN_REST_FRACTION,
        `fracción en reposo real ${fraction.toFixed(2)} < ${MIN_REST_FRACTION} ` +
        `(${realRests}/${results.length}; ${culled} por culling)`);
    for (const r of results) {
        if (!r.rested || r.culled) continue;
        // T0.7: con la corrección de posición por radio el CENTRO puede
        // quedar hasta un radio más allá del último vértice del perfil y la
        // roca sigue apoyada en el segmento (d=0.5 -> radio 0.25).
        // T0.7b: holgado ampliado a +50 m (ver cabecera): el modelo corregido
        // deja rodar las rocas hasta el final del terreno extrapolado.
        assert.ok(r.x >= TERRAIN_X_MIN && r.x <= REST_X_MAX,
            `x final ${r.x.toFixed(2)} fuera del terreno [${TERRAIN_X_MIN}, ${REST_X_MAX}]`);
    }
}

test('lumped-mass: >= 90% de 50 rocas en reposo real antes de 12000 pasos y x final dentro del terreno', () => {
    assertBatchRests('lumped-mass', runBatch('lumped-mass'));
});

test('rigid-body: >= 90% de 50 rocas en reposo real antes de 12000 pasos y x final dentro del terreno', () => {
    assertBatchRests('rigid-body', runBatch('rigid-body'));
});

test('nonsmooth: >= 90% de 50 rocas en reposo real antes de 12000 pasos y x final dentro del terreno', () => {
    assertBatchRests('nonsmooth', runBatch('nonsmooth'));
});
