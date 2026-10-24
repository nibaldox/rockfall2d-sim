'use strict';

/**
 * Test de js/view3d-trajectories.js — parte PURA (sin THREE) para Node:
 * SimRocas.Trajectories3D.segmentsFromRocks / speedColor / stopPointsFromRocks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

const ctx = loadScripts(['js/view3d-trajectories.js'], { env: 'browser' });
const T = ctx.SimRocas.Trajectories3D;

/** Roca falsa con trayectoria de cuádruplos (x, y, z, speed). */
function fakeRock(quads) {
    const n = quads.length;
    return {
        trajectoryLength: n,
        trajectory: new Float32Array(quads.flat()),
        stopReason: null,
        finalX: 0, finalY: 0, finalZ: 0,
    };
}

test('speedColor devuelve rgb en [0,1] con extremos de la rampa', () => {
    const c0 = T.speedColor(0);
    const c1 = T.speedColor(1);
    const mid = T.speedColor(0.5);
    for (const c of [c0, c1, mid]) {
        assert.equal(c.length, 3);
        for (const v of c) {
            assert.ok(v >= 0 && v <= 1, 'componente en [0, 1]');
            assert.ok(Number.isFinite(v), 'componente finita');
        }
    }
    // Extremos distintos y rampa mayormente creciente en r.
    assert.notDeepEqual(c0, c1);
    assert.ok(c1[0] > c0[0], 'rojo al final');
});

test('speedColor recorta t fuera de [0, 1] y no explota con NaN', () => {
    const lo = T.speedColor(-2);
    const hi = T.speedColor(5);
    assert.deepEqual(lo, T.speedColor(0));
    assert.deepEqual(hi, T.speedColor(1));
    const bad = T.speedColor(NaN);
    assert.equal(bad.length, 3);
    for (const v of bad) {
        assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
    }
});

test('segmentsFromRocks: cuenta segmentos, colores y rango de velocidad', () => {
    // 3 rocas de 4 quads con velocidades conocidas.
    const rocks = [
        fakeRock([[0, 0, 10, 1], [1, 0, 12, 3], [2, 0, 14, 5], [3, 0, 16, 7]]),
        fakeRock([[0, 10, 10, 2], [1, 10, 12, 4], [2, 10, 14, 6], [3, 10, 16, 8]]),
        fakeRock([[0, 20, 10, 3], [1, 20, 12, 5], [2, 20, 14, 7], [3, 20, 16, 9]]),
    ];
    const seg = T.segmentsFromRocks(rocks, { maxTracks: 3 });
    // Cada roca muestreada aporta (quads - 1) segmentos = 3; total 9 segmentos = 18 puntos.
    assert.equal(seg.positions.length, 18 * 3);
    assert.equal(seg.colors.length, 18 * 3);
    assert.equal(seg.nSampled, 3);
    // Rango de velocidad por los cuádruplos: 1..9.
    assert.equal(seg.minSpeed, 1);
    assert.equal(seg.maxSpeed, 9);
    // Posiciones: primer punto = primer quad de la primera roca.
    assert.equal(seg.positions[0], 0);
    assert.equal(seg.positions[1], 0);
    assert.equal(seg.positions[2], 10);
    // Fin del primer segmento = segundo quad.
    assert.equal(seg.positions[3], 1);
    assert.equal(seg.positions[4], 0);
    assert.equal(seg.positions[5], 12);
});

test('segmentsFromRocks muestrea como máximo maxTracks rocas de forma uniforme', () => {
    const rocks = [];
    for (let i = 0; i < 100; i++) {
        rocks.push(fakeRock([[0, i, 10, i + 1], [1, i, 11, i + 1], [2, i, 12, i + 1]]));
    }
    const seg = T.segmentsFromRocks(rocks, { maxTracks: 500 });
    assert.equal(seg.nSampled, 100); // sin exceso, todos.
    const seg500 = T.segmentsFromRocks(rocks, { maxTracks: 10 });
    assert.equal(seg500.nSampled, 10);
    // Con 100 rocas y maxTracks 10: stride 10 → índices 0, 10, ..., 90.
    // Cada roca muestreada aporta 3 quads → 2 segmentos → 12 floats de posición.
    assert.equal(seg500.positions.length, 10 * 12);
    // La primera roca muestreada es la 0: su primer quad es (0, 0, ...).
    assert.equal(seg500.positions[1], 0);
    // La última roca muestreada es la 90: su primer y = 90.
    assert.equal(seg500.positions[9 * 12 + 1], 90);
});

test('segmentsFromRocks: rocks sin trayectoria no aportan segmentos', () => {
    const rocks = [
        { trajectoryLength: 0, trajectory: new Float32Array(0), stopReason: null },
        fakeRock([[0, 0, 10, 4], [1, 0, 11, 4]]),
    ];
    const seg = T.segmentsFromRocks(rocks, { maxTracks: 50 });
    assert.equal(seg.nSampled, 1);
    assert.equal(seg.positions.length, 6); // 1 segmento = 2 puntos × 3
});

test('stopPointsFromRocks: solo rocas detenidas (rest), una entrada por roca', () => {
    const rocks = [
        Object.assign(fakeRock([[0, 0, 10, 1]]), { stopReason: 'rest', finalX: 5, finalY: 6, finalZ: 7 }),
        Object.assign(fakeRock([[0, 1, 10, 2]]), { stopReason: 'culled', finalX: 1, finalY: 1, finalZ: 1 }),
        Object.assign(fakeRock([[0, 2, 10, 3]]), { stopReason: 'rest', finalX: 8, finalY: 9, finalZ: 10 }),
    ];
    const st = T.stopPointsFromRocks(rocks);
    assert.equal(st.count, 2);
    assert.equal(st.positions.length, 6);
    assert.equal(st.positions[0], 5);
    assert.equal(st.positions[1], 6);
    assert.equal(st.positions[2], 7);
    assert.equal(st.positions[3], 8);
    assert.equal(st.positions[4], 9);
    assert.equal(st.positions[5], 10);
});
