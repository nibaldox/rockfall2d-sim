'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function load(extraGlobals = {}) {
    const files = ['js/dem.js', 'js/results3d.js'];
    if (extraGlobals.__withAscImporter) {
        files.push('js/importers/asc.js');
        delete extraGlobals.__withAscImporter;
    }
    const ctx = loadScripts(files, {
        env: 'worker',
        extra: extraGlobals,
    });
    return ctx.SimRocas;
}

// ── Helpers para rocas falsas con la forma del contrato C7 ──────────────────

function makeRock({ quads, mass, radius, stopReason = null, finalX = null, finalY = null }) {
    const trajectory = new Float32Array(quads.length * 4);
    for (let k = 0; k < quads.length; k++) {
        trajectory[k * 4 + 0] = quads[k][0];
        trajectory[k * 4 + 1] = quads[k][1];
        trajectory[k * 4 + 2] = quads[k][2];
        trajectory[k * 4 + 3] = quads[k][3];
    }
    return {
        trajectory: trajectory,
        trajectoryLength: quads.length,
        maxKineticEnergy: 0,
        impacts: [],
        stopReason: stopReason,
        finalX: finalX !== null ? finalX : quads[quads.length - 1][0],
        finalY: finalY !== null ? finalY : quads[quads.length - 1][1],
        finalZ: quads[quads.length - 1][2],
        mass: mass,
        radius: radius,
        getTrajectory() {
            return trajectory;
        },
    };
}

function quadLine(x0, y0, z, v, x1, y1, step) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const n = Math.floor(len / step);
    const quads = [];
    for (let k = 0; k <= n; k++) {
        const t = k / n;
        quads.push([x0 + dx * t, y0 + dy * t, z, v]);
    }
    return quads;
}

function filledCells(raster, cols, rows) {
    const out = [];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            if (raster[j * cols + i] > 0) {
                out.push([i, j]);
            }
        }
    }
    return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

// Conjunto de celdas tocadas por una polilínea, calculado de forma independiente
// con Liang-Barsky (segmento vs rectángulo de celda).
function expectedCells(quads, cellSize) {
    const set = new Set();
    function segCells(ax, ay, bx, by) {
        const i0 = Math.floor(Math.min(ax, bx) / cellSize);
        const i1 = Math.floor(Math.max(ax, bx) / cellSize);
        const j0 = Math.floor(Math.min(ay, by) / cellSize);
        const j1 = Math.floor(Math.max(ay, by) / cellSize);
        const dx = bx - ax;
        const dy = by - ay;
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const xmin = i * cellSize;
                const ymin = j * cellSize;
                const xmax = xmin + cellSize;
                const ymax = ymin + cellSize;
                // Liang-Barsky: (P,Q) paramétricas en t∈[0,1]
                let t0 = 0;
                let t1 = 1;
                const p = [-dx, dx, -dy, dy];
                const q = [ax - xmin, xmax - ax, ay - ymin, ymax - ay];
                let fuera = false;
                for (let e = 0; e < 4; e++) {
                    if (p[e] === 0) {
                        if (q[e] < 0) { fuera = true; break; }
                    } else {
                        const r = q[e] / p[e];
                        if (p[e] < 0) {
                            if (r > t1) { fuera = true; break; }
                            if (r > t0) { t0 = r; }
                        } else {
                            if (r < t0) { fuera = true; break; }
                            if (r < t1) { t1 = r; }
                        }
                    }
                }
                if (!fuera) { set.add(j * 100 + i); }
            }
        }
    }
    segCells(quads[0][0], quads[0][1], quads[0][0], quads[0][1]);
    for (let k = 1; k < quads.length; k++) {
        segCells(quads[k - 1][0], quads[k - 1][1], quads[k][0], quads[k][1]);
    }
    return set;
}

function flatDem(SimRocas, cols, rows, cs) {
    return SimRocas.Dem.fromFunction(cols, rows, cs, () => 0);
}

// ── Rasterización de pasadas ─────────────────────────────────────────────────

test('trayectoria diagonal marca exactamente las celdas esperadas (con comprobación independiente)', () => {
    const SR = load();
    const cs = 1;
    const dem = flatDem(SR, 6, 6, cs);
    // diagonal sin cruces exactos por esquinas: (0.2, 0.3) → (4.7, 3.9)
    const quads = quadLine(0.2, 0.3, 1, 5, 4.7, 3.9, 0.01);
    const rock = makeRock({ quads: quads, mass: 1, radius: 0.3 });
    const res = SR.Results3D.build(dem, [rock]);
    assert.equal(res.cellSize, cs);
    assert.equal(res.cols, 6);
    assert.equal(res.rows, 6);

    const esperado = expectedCells(quads, cs);
    const real = [];
    for (let j = 0; j < 6; j++) {
        for (let i = 0; i < 6; i++) {
            if (res.passCount[j * 6 + i] === 1) { real.push(j * 100 + i); }
        }
    }
    assert.equal(real.length, esperado.size);
    assert.deepEqual(new Set(real), esperado);
});

test('una roca que pasa dos veces por la misma celda cuenta 1 en passCount', () => {
    const SR = load();
    const dem = flatDem(SR, 6, 6, 1);
    // ida y vuelta por la fila j=2
    const quads = quadLine(0.5, 2.5, 1, 5, 3.5, 2.5, 1).concat(
        quadLine(3.5, 2.5, 1, 5, 0.5, 2.5, 1)
    );
    const rock = makeRock({ quads: quads, mass: 1, radius: 0.2 });
    const res = SR.Results3D.build(dem, [rock]);
    const pass = Array.from(res.passCount);
    assert.deepEqual(
        pass.map((c, k) => (c === 1 ? k : null)).filter((v) => v !== null),
        [2 * 6 + 0, 2 * 6 + 1, 2 * 6 + 2, 2 * 6 + 3],
        'exactamente las celdas (0..3, 2) con 1'
    );
});

test('energía máxima por celda: ½·m·v² con el speed del cuádruplo, en kJ', () => {
    const SR = load();
    const dem = flatDem(SR, 6, 6, 1);
    const quads = [
        [0.5, 2.5, 1, 10],
        [1.5, 2.5, 1, 20],
        [2.5, 2.5, 1, 30],
        [3.5, 2.5, 1, 40],
        [4.5, 2.5, 1, 40],
    ];
    const rock = makeRock({ quads: quads, mass: 2, radius: 0.2 });
    const res = SR.Results3D.build(dem, [rock]);
    // ½·2·v²/1000: 0.1, 0.4, 0.9, 1.6, 1.6
    assert.ok(Math.abs(res.maxEnergyKJ[2 * 6 + 0] - 0.1) < 1e-6);
    assert.ok(Math.abs(res.maxEnergyKJ[2 * 6 + 1] - 0.4) < 1e-6);
    assert.ok(Math.abs(res.maxEnergyKJ[2 * 6 + 2] - 0.9) < 1e-6);
    assert.ok(Math.abs(res.maxEnergyKJ[2 * 6 + 3] - 1.6) < 1e-6);
    assert.ok(Math.abs(res.maxEnergyKJ[2 * 6 + 4] - 1.6) < 1e-6);
    // celdas sin paso quedan en 0
    assert.equal(res.maxEnergyKJ[0], 0);
});

test('maxBounceHeight: z − altura del terreno − radio, máximo por celda, ≥ 0', () => {
    const SR = load();
    const dem = SR.Dem.fromFunction(6, 6, 1, () => 0);
    const quads = [
        [0.5, 2.5, 3, 5],
        [1.5, 2.5, 2, 5],
        [2.5, 2.5, 0.25, 5], // debajo del radio → ajusta a 0
        [3.5, 2.5, 4, 5],
    ];
    const rock = makeRock({ quads: quads, mass: 1, radius: 0.5 });
    const res = SR.Results3D.build(dem, [rock]);
    assert.ok(Math.abs(res.maxBounceHeight[2 * 6 + 0] - 2.5) < 1e-6);
    assert.ok(Math.abs(res.maxBounceHeight[2 * 6 + 1] - 1.5) < 1e-6);
    assert.ok(Math.abs(res.maxBounceHeight[2 * 6 + 2] - 0) < 1e-6);
    assert.ok(Math.abs(res.maxBounceHeight[2 * 6 + 3] - 3.5) < 1e-6);
    assert.ok(res.maxBounceHeight[2 * 6 + 4] === 0);
});

test('stopCount: solo rocas con stopReason rest, en su posición final', () => {
    const SR = load();
    const dem = flatDem(SR, 6, 6, 1);
    const quads = quadLine(0.5, 0.5, 1, 5, 3.5, 0.5, 1);
    const reposada = makeRock({
        quads: quads,
        mass: 1,
        radius: 0.2,
        stopReason: 'rest',
        finalX: 2.5,
        finalY: 3.5,
    });
    const culled = makeRock({
        quads: quads,
        mass: 1,
        radius: 0.2,
        stopReason: 'culled',
        finalX: 2.0,
        finalY: 0.0,
    });
    const enMarcha = makeRock({ quads: quads, mass: 1, radius: 0.2 });
    const res = SR.Results3D.build(dem, [reposada, culled, enMarcha]);
    const stops = Array.from(res.stopCount);
    const total = stops.reduce((a, b) => a + b, 0);
    assert.equal(total, 1);
    assert.equal(res.stopCount[3 * 6 + 2], 1);
    assert.equal(res.stopCount[2 * 6 + 0], 0);
});

test('reachProbability = passCount / nRocas', () => {
    const SR = load();
    const dem = flatDem(SR, 6, 6, 1);
    const r1 = makeRock({ quads: quadLine(0.5, 2.5, 1, 5, 3.5, 2.5, 1), mass: 1, radius: 0.2 });
    const r2 = makeRock({ quads: quadLine(0.5, 2.5, 1, 5, 4.5, 2.5, 1), mass: 1, radius: 0.2 });
    const res = SR.Results3D.build(dem, [r1, r2]);
    // celdas (2,2) y (3,2) las atraviesa r2; (0..2,2) r1 y (3,2) r1+r2
    // r1: 0..3 de la fila 2; r2: 0..4 de la fila 2
    assert.ok(Math.abs(res.reachProbability[2 * 6 + 0] - 1.0) < 1e-6);
    assert.ok(Math.abs(res.reachProbability[2 * 6 + 3] - 1.0) < 1e-6);
    assert.ok(Math.abs(res.reachProbability[2 * 6 + 4] - 0.5) < 1e-6);
    assert.equal(res.reachProbability[0], 0);
});

test('cellSize distinto del DEM: cols/rows derivados de la extensión del DEM', () => {
    const SR = load();
    const dem = flatDem(SR, 6, 6, 1); // extensión 5x5 m
    const quads = quadLine(0.2, 0.3, 1, 5, 4.7, 3.9, 0.05);
    const rock = makeRock({ quads: quads, mass: 1, radius: 0.2 });
    const res = SR.Results3D.build(dem, [rock], { cellSize: 2 });
    assert.equal(res.cellSize, 2);
    // ceil(5/2) + 1 = 4 en cada eje
    assert.equal(res.cols, 4);
    assert.equal(res.rows, 4);
    const esperado = expectedCells(quads, 2);
    const real = [];
    for (let j = 0; j < res.rows; j++) {
        for (let i = 0; i < res.cols; i++) {
            if (res.passCount[j * res.cols + i] > 0) { real.push(j * 100 + i); }
        }
    }
    assert.equal(real.length, esperado.size);
    assert.deepEqual(new Set(real), esperado);
});

// ── Exportación ESRI ASCII ───────────────────────────────────────────────────

test('toAsc parseable por el importador js/importers/asc.js y con orientación norte→sur', async () => {
    // TextDecoder/TextEncoder no existen en el context vm del sandbox: se inyectan.
    const SR = load({
        TextDecoder: TextDecoder,
        TextEncoder: TextEncoder,
        __withAscImporter: true,
    });
    // terreno con z = altura por fila (sur=0 … norte=5) para verificar orientación
    const dem = SR.Dem.fromFunction(5, 5, 1, (x, y) => y);
    const quads = [
        [0.5, 0.5, 2, 5],
        [1.5, 0.5, 3, 10],
    ];
    const rock = makeRock({ quads: quads, mass: 2, radius: 0.5 });
    const res = SR.Results3D.build(dem, [rock]);

    const ascCount = SR.Results3D.toAsc(res, dem, 'passCount');
    const ascEnergy = SR.Results3D.toAsc(res, dem, 'maxEnergyKJ');
    // cabecera con origen MUNDO (tokens separados por espacios)
    const lines = ascCount.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/));
    assert.deepEqual(lines[0], ['ncols', '5']);
    assert.deepEqual(lines[1], ['nrows', '5']);
    assert.deepEqual(lines[2], ['xllcenter', '0']);
    assert.deepEqual(lines[3], ['yllcenter', '0']);
    assert.equal(lines[4][0], 'cellsize');
    // el campo energía declara NODATA
    assert.ok(/NODATA_value\s+-9999/.test(ascEnergy));
    // donde no hay paso, NODATA en energía (fila de archivo 2 = j=2, columna i=4 sin paso)
    const headerLines = /NODATA_value/.test(ascEnergy) ? 6 : 5;
    const energyRows = ascEnergy.trim().split(/\r?\n/).slice(headerLines);
    assert.equal(energyRows[2].trim().split(/\s+/)[4], '-9999');

    // re-importar passCount y verificar valores por nodo
    const bytes = new TextEncoder().encode(ascCount);
    const parsed = await SR.importers.asc.parse(bytes);
    assert.equal(parsed.kind, 'grid');
    const dem2 = parsed.dem;
    assert.equal(dem2.cols, 5);
    assert.equal(dem2.rows, 5);
    // fila de archivo = norte →sur: la fila de archivo con mayor Y del mundo es j=4 del raster
    const pass = Array.from(res.passCount);
    for (let j = 0; j < 5; j++) {
        for (let i = 0; i < 5; i++) {
            assert.equal(
                dem2.heights[j * 5 + i],
                pass[j * 5 + i],
                `nodo (${i}, ${j}) re-importado`
            );
        }
    }
});

// ── Rendimiento ──────────────────────────────────────────────────────────────

test('rendimiento: 2000 trayectorias de 1500 puntos en DEM 1000x1000 en < 5 s', () => {
    const SR = load();
    const dem = SR.Dem.fromFunction(1000, 1000, 1, () => 0);
    const rocks = [];
    for (let r = 0; r < 2000; r++) {
        const x0 = r % 900;
        const y0 = (r * 13) % 900;
        const quads = new Array(1500);
        for (let k = 0; k < 1500; k++) {
            quads[k] = [x0 + k * 0.02, y0 + k * 0.01, 1 + (k % 7), 5 + (k % 11)];
        }
        rocks.push(makeRock({ quads: quads, mass: 1, radius: 0.2 }));
    }
    const t0 = performance.now();
    const res = SR.Results3D.build(dem, rocks);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 5000, `build tardó ${elapsed.toFixed(0)} ms (límite 5000)`);
    assert.ok(res.cols === 1000 && res.rows === 1000);
});
