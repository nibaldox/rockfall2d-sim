'use strict';

/**
 * Tests T4.7: proyección de trayectorias 3D sobre el perfil 2D
 * (corredor de ancho configurable) Se cubre:
 *  - SimRocas.ProfileCorridor.project (contrato puro)
 *  - Renderer.setCorridorOverlay / drawCorridorOverlay con un contexto
 *    Canvas falso que registra llamadas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// ---------- utilidades ----------

/** Roca 3D serializada con trayectoria de cuádruplos (x, y, z, speed). */
function makeRock(quads, extra = {}) {
    const traj = new Float32Array(quads.length * 4);
    quads.forEach((q, i) => {
        traj[i * 4] = q[0];
        traj[i * 4 + 1] = q[1];
        traj[i * 4 + 2] = q[2] !== undefined ? q[2] : 0;
        traj[i * 4 + 3] = q[3] !== undefined ? q[3] : 5;
    });
    return {
        trajectory: traj,
        trajectoryLength: quads.length,
        stopReason: extra.stopReason || null,
        finalX: extra.finalX !== undefined ? extra.finalX : 0,
        finalY: extra.finalY !== undefined ? extra.finalY : 0,
        finalZ: extra.finalZ !== undefined ? extra.finalZ : 0,
        maxKineticEnergy: extra.maxKineticEnergy !== undefined ? extra.maxKineticEnergy : 0
    };
}

/** Roca cuyo buffer tiene basura extra pero getTrajectory() recorta. */
function makeRockGetTrajectory(quads, bufferQuads, extra = {}) {
    const rock = makeRock(quads, extra);
    const buf = new Float32Array(bufferQuads.length * 4);
    bufferQuads.forEach((q, i) => {
        buf[i * 4] = q[0];
        buf[i * 4 + 1] = q[1];
        buf[i * 4 + 2] = q[2] !== undefined ? q[2] : 0;
        buf[i * 4 + 3] = q[3] !== undefined ? q[3] : 5;
    });
    rock.trajectory = buf;
    rock.trajectoryLength = bufferQuads.length;
    rock.getTrajectory = () => buf.subarray(0, quads.length * 4);
    rock._rawQuads = bufferQuads.length;
    return rock;
}

function loadProfileCorridor() {
    const ctx = loadScripts(['js/profile-corridor.js'], { env: 'browser' });
    const pc = ctx.SimRocas.ProfileCorridor;
    assert.equal(typeof pc.project, 'function', 'falta ProfileCorridor.project');
    return pc;
}

// ---------- RED: contrato puro de proyección ----------

const pc = loadProfileCorridor();

test('T4.7: project devuelve estructura vacía sin datos', () => {
    const empty = pc.project([], { polylineLocal: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    assert.equal(empty.tracks.length, 0);
    assert.equal(empty.stops.length, 0);
    assert.equal(empty.count, 0);
    assert.equal(empty.total, 0);
    assert.equal(empty.halfWidth, 10);
    assert.equal(empty.stats.reachP50, 0);
    assert.equal(empty.stats.reachP95, 0);
    assert.equal(empty.stats.maxEnergyKJ, 0);
    // Sin sección (o incompleta) también.
    const noSection = pc.project([makeRock([[1, 0]])], null);
    assert.equal(noSection.count, 0);
});

test('T4.7: roca que recorre la sección en el eje → s creciente y d = 0', () => {
    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const quads = [];
    for (let i = 0; i <= 20; i++) {
        quads.push([i * 5, 0, 10 + i * 0.5, 8 + i]);
    }
    const res = pc.project([makeRock(quads)], section);
    assert.equal(res.count, 1);
    assert.equal(res.total, 1);
    assert.equal(res.tracks.length, 1);

    const pts = res.tracks[0].points;
    assert.equal(pts.length, quads.length * 3);
    let prev = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
        assert.ok(pts[i] > prev, 's creciente');
        prev = pts[i];
    }
    // d = 0: cada punto proyecta exactamente sobre si mismo.
    assert.equal(pts[0], 0);
    assert.equal(pts[pts.length - 3], 100);
    assert.equal(pts[1], 10 + 0);           // z conservado
    assert.equal(pts[2], 8);                // speed conservada
});

test('T4.7: proyección exacta en vértices de la polilínea en L (s continua)', () => {
    // L: (0,0) → (100,0) → (100,100)
    const section = {
        polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    };
    // d con signo a mano usando el helper interno.
    const L = section.polylineLocal;
    assert.equal(pc._projectPoint(50, 15, L).d, 15);
    assert.equal(pc._projectPoint(50, -10, L).d, -10);

    const quads = [];
    for (let i = 0; i <= 100; i++) quads.push([i, 0, 5, 10]);
    for (let j = 1; j <= 100; j++) quads.push([100, j, 5, 10]);
    const res = pc.project([makeRock(quads)], section);
    assert.equal(res.tracks.length, 1);
    const pts = res.tracks[0].points;
    // En el vértice (100, 0): s = 100 y sigue creciendo sin salto.
    const vertexIdx = 100 * 3;
    assert.ok(Math.abs(pts[vertexIdx] - 100) < 1e-6, 's en el vértice = 100');
    for (let j = 1; j <= 100; j++) {
        const idx = (100 + j) * 3;
        assert.ok(Math.abs(pts[idx] - (100 + j)) < 1e-6, 's continua en la L: ' + (100 + j));
    }
    assert.ok(Math.abs(pts[pts.length - 3] - 200) < 1e-6, 's máximo = 200');
});

test('T4.7: roca paralela a 15 m con halfWidth 10 → ignorada', () => {
    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const quads = [];
    for (let i = 0; i <= 20; i++) quads.push([i * 5, 15, 0, 10]);
    const res = pc.project([makeRock(quads)], section, { halfWidth: 10 });
    assert.equal(res.tracks.length, 0);
    assert.equal(res.count, 0);
    assert.equal(res.stops.length, 0);
    // Con halfWidth 16 sí entra.
    const wide = pc.project([makeRock(quads)], section, { halfWidth: 16 });
    assert.equal(wide.count, 1);
    assert.equal(wide.halfWidth, 16);
});

test('T4.7: roca que entra/sale del corredor → dos tracks', () => {
    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const quads = [];
    for (let i = 0; i <= 7; i++) quads.push([i * 5, 8, 0, 10]);   // dentro (d=8)
    for (let i = 1; i <= 4; i++) quads.push([40 + i * 5, 20, 0, 10]); // fuera (d=20)
    for (let i = 1; i <= 8; i++) quads.push([60 + i * 5, 8, 0, 10]);  // de nuevo dentro
    const res = pc.project([makeRock(quads)], section);
    assert.equal(res.count, 1);
    assert.equal(res.tracks.length, 2);
    assert.equal(res.tracks[0].rockIndex, 0);
    assert.equal(res.tracks[1].rockIndex, 0);
    // Segundo track empieza después del hueco fuera de corredor.
    assert.ok(res.tracks[0].points[res.tracks[0].points.length - 3] < 40);
    assert.ok(res.tracks[1].points[0] >= 60);
});

test('T4.7: detenciones dentro/fuera del corredor', () => {
    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const rocks = [
        makeRock([[45, 0, 1, 10]], { stopReason: 'rest', finalX: 50, finalY: 0, finalZ: 120, maxKineticEnergy: 8000 }),
        makeRock([[200, 40, 1, 10]], { stopReason: 'rest', finalX: 140, finalY: -15, finalZ: 10 }),
        makeRock([[60, 0, 1, 10]], { stopReason: 'culled', finalX: 60, finalY: 0, finalZ: 1 })
    ];
    const res = pc.project(rocks, section);
    assert.equal(res.stops.length, 1);
    assert.equal(res.stops[0].rockIndex, 0);
    assert.ok(Math.abs(res.stops[0].s - 50) < 1e-9);
    assert.equal(res.stops[0].z, 120);
    // 'culled' dentro del corredor no es detención, pero sí cuenta en count.
    assert.equal(res.count, 2);
    assert.equal(res.total, 3);
    assert.ok(Math.abs(res.stats.maxEnergyKJ - 8) < 1e-9); // 8000 J → 8 kJ
    assert.ok(Math.abs(res.stats.reachP50 - 50) < 1e-9);
});

test('T4.7: percentiles de alcance (reachP50 / reachP95)', () => {
    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const ss = [10, 20, 30, 40];
    const rocks = ss.map((s) => makeRock([[s, 0, 0, 10]], {
        stopReason: 'rest', finalX: s, finalY: 0, finalZ: 0
    }));
    const res = pc.project(rocks, section);
    assert.equal(res.stops.length, 4);
    assert.ok(Math.abs(res.stats.reachP50 - 25) < 1e-9);
    assert.ok(Math.abs(res.stats.reachP95 - 38.5) < 1e-9);
});

test('T4.7: acepta rocas con getTrajectory() recortado', () => {
    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const quads = [];
    for (let i = 0; i < 5; i++) quads.push([i * 10, 0, 2, 6]);
    const bufferQuads = quads.concat([[999, 999, 0, 0], [888, 888, 0, 0]]);
    const rock = makeRockGetTrajectory(quads, bufferQuads);
    const res = pc.project([rock], section);
    assert.equal(res.tracks.length, 1);
    assert.equal(res.tracks[0].points.length, 5 * 3);
    assert.ok(res.tracks[0].points[res.tracks[0].points.length - 3] >= 0);
    assert.ok(res.tracks[0].points[res.tracks[0].points.length - 3] <= 100);
});

test('T4.7: rendimiento 2000 rocas × 1500 puntos, polilínea de 5 tramos < 2 s', () => {
    const section = {
        polylineLocal: [
            { x: 0, y: 0 }, { x: 60, y: 3 }, { x: 140, y: 9 },
            { x: 220, y: 4 }, { x: 300, y: 0 }, { x: 420, y: -2 }
        ]
    };
    const rocks = [];
    const N = 2000, P = 1500;
    for (let r = 0; r < N; r++) {
        const quads = new Array(P);
        for (let i = 0; i < P; i++) {
            const x = (i / (P - 1)) * 400 * (r % 4) * 0.25;
            const d = 12 * Math.sin(r + i * 0.01) + (i % 7);
            quads[i] = [x, d, 3 + (i % 11), 4 + (i % 13)];
        }
        rocks.push(makeRock(quads, { maxKineticEnergy: 1000 + r }));
    }
    const t0 = process.hrtime.bigint();
    const res = pc.project(rocks, section);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.total, N);
    assert.ok(res.count > 0);
    assert.ok(ms < 2000, 'project tardó ' + ms.toFixed(0) + ' ms (límite 2000)');
});

// ---------- renderer: contexto Canvas falso ----------

function fakeCtx() {
    const calls = [];
    const methodNames = ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'arc',
        'fill', 'stroke', 'fillText', 'setLineDash', 'strokeRect', 'closePath',
        'measureText', 'fillStyle', 'strokeStyle', 'measure'];
    const ctx = {
        calls,
        _max(name) {
            let c = 0;
            for (const m of calls) if (m.method === name) c++;
            return c;
        },
        measureText: () => ({ width: 0 })
    };
    for (const name of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'arc',
        'fill', 'stroke', 'fillText', 'setLineDash', 'strokeRect', 'closePath', 'save', 'restore']) {
        ctx[name] = function (...args) {
            calls.push({ method: name, args });
        };
    }
    return ctx;
}

/** Terrain mínimo con la misma transformación que Terrain.worldToCanvas. */
function fakeTerrain() {
    return {
        points: [{ x: 0, y: 0 }],
        segments: [],
        scale: 2,
        offsetX: 50,
        offsetY: 50,
        canvas: { width: 800, height: 600 },
        worldToCanvas(wx, wy) {
            return {
                cx: wx * this.scale + this.offsetX,
                cy: this.canvas.height - (wy * this.scale + this.offsetY)
            };
        }
    };
}

function loadRenderer() {
    const ctx = loadScripts(['js/renderer.js'], {
        env: 'browser',
        extra: {
            SimRocas: {},
            getComputedStyle: () => ({ getPropertyValue: () => '' }),
            document: {
                documentElement: {},
                getElementById: () => null,
                querySelector: () => null,
                querySelectorAll: () => []
            }
        }
    });
    return ctx.SimRocas.Renderer;
}

test('T4.7: renderer con overlay null no dibuja nada del corredor', () => {
    const Ctx = loadRenderer();
    const canvas = { width: 800, height: 600, getContext: () => fakeCtx() };
    const renderer = new Ctx(canvas, fakeTerrain());
    assert.equal(renderer.corridorOverlay, null);

    renderer.setCorridorOverlay(null);
    const before = renderer.ctx.calls.length;
    renderer.drawCorridorOverlay();
    assert.equal(renderer.ctx.calls.length, before);
    assert.equal(renderer.ctx._max('lineTo'), 0);
});

test('T4.7: renderer dibuja tracks en coordenadas transformadas y detenciones', () => {
    const Ctx = loadRenderer();
    const ctxObj = fakeCtx();
    const canvas = { width: 800, height: 600, getContext: () => ctxObj };
    const renderer = new Ctx(canvas, fakeTerrain());

    const section = { polylineLocal: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const rocks = [
        makeRock([[0, 0, 20, 10], [10, 0, 22, 12], [20, 0, 24, 14]], {
            stopReason: 'rest', finalX: 20, finalY: 0, finalZ: 25
        })
    ];
    const Overlay = loadProfileCorridor();
    const res = Overlay.project(rocks, section);
    renderer.setCorridorOverlay(res, { colorBy: 'speed' });
    renderer.drawCorridorOverlay();

    // 3 puntos → 2 segmentos lineTo con moveTo previo.
    assert.equal(ctxObj._max('lineTo'), 2);
    assert.equal(ctxObj._max('moveTo'), 2);
    // 1 detención → 1 círculo.
    assert.equal(ctxObj._max('arc'), 1);

    // Coordenadas mundo transformadas: mundo (0, 20) → (0*2+50, 600-(20*2+50))
    const first = ctxObj.calls.find((c) => c.method === 'moveTo');
    assert.ok(first, 'falta moveTo del primer segmento');
    assert.ok(Math.abs(first.args[0] - (0 * 2 + 50)) < 1e-6);
    assert.ok(Math.abs(first.args[1] - (600 - (20 * 2 + 50))) < 1e-6);

    // Leyenda breve en español.
    const legend = ctxObj.calls.find((c) => c.method === 'fillText' &&
        String(c.args[0]).indexOf('Trayectorias 3D en corredor') !== -1);
    assert.ok(legend, 'falta leyenda del corredor');
    assert.ok(String(legend.args[0]).indexOf('±10 m') !== -1, String(legend.args[0]));
});

test('T4.7: render() del 2D integra el overlay (leyenda visible, timeline intacto)', () => {
    const Ctx = loadRenderer();
    const ctxObj = fakeCtx();
    const canvas = { width: 800, height: 600, getContext: () => ctxObj };
    const renderer = new Ctx(canvas, fakeTerrain());

    renderer.setCorridorOverlay({
        tracks: [{ rockIndex: 0, points: Float32Array.from([0, 30, 5, 10, 32, 7]) }],
        stops: [{ s: 10, z: 32, rockIndex: 0 }],
        count: 1, total: 1, halfWidth: 10,
        stats: { reachP50: 10, reachP95: 10, maxEnergyKJ: 1 }
    });
    renderer.render(null);

    const legend = ctxObj.calls.find((c) => c.method === 'fillText' &&
        String(c.args[0]).indexOf('Trayectorias 3D en corredor ±10 m (1 rocas)') !== -1);
    assert.ok(legend, 'falta leyenda tras render()');
    assert.ok(ctxObj._max('arc') >= 1, 'falta el círculo de detención');
});
