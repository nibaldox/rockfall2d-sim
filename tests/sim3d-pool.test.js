'use strict';

/**
 * Tests T4.4 — SimRocas.Sim3DPool con una clase Worker FALSA que ejecuta
 * js/workers/sim3d-worker.js en un contexto vm 'worker' (importScripts shim +
 * postMessage asíncrono). Casos:
 *  - Paridad EXACTA (±1e-9 en finalX/Y/Z emparejando por índice de spec, con
 *    variabilidad 0 y rugosidad 0) con Simulation3D en un solo hilo, con pool
 *    de 1, 3 y 4 workers.
 *  - Rama sin SharedArrayBuffer (una copia por worker) y rama con
 *    SharedArrayBuffer simulado (crossOriginIsolated: heights compartido,
 *    sin copia por worker).
 *  - cancel() rechaza; error en el worker → rechazo con mensaje en español.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createContext, loadScripts, runScript } = require('./helpers/load.js');

const SEED = 2027;
const TAN35 = Math.tan(35 * Math.PI / 180);

const BASE_FILES = [
    'js/dem.js',
    'js/math3d.js',
    'js/physics3d.js',
    'js/source-zones.js',
    'js/simulation3d.js',
];
const POOL_FILES = [...BASE_FILES, 'js/sim3d-pool.js'];

// Motor determinista: variabilidad 0 y rugosidad 0 → paridad exacta posible.
const ENGINE_PARAMS = {
    gravity: 9.81,
    dt: 0.005,
    kn: 0.35,
    kt: 0.75,
    knVariability: 0,
    ktVariability: 0,
    rollingFriction: 0.15,
    roughnessDeg: 0,
};
const SIM_PARAMS = { maxDuration: 30, trajectoryInterval: 4, stepsPerRock: 50 };

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

function makeSlopeDem(ctx) {
    // Ladera de 35° que desciende hacia +x hasta x=150 y llano después.
    return ctx.SimRocas.Dem.fromFunction(
        240, 42, 1,
        (x) => Math.max(0, (150 - x) * TAN35),
    );
}

// --- Caso base: Simulation3D en un solo hilo (memoizado) --------------------

let BASE = null;
function baseline() {
    if (!BASE) {
        const ctx = loadScripts(POOL_FILES, { env: 'browser', seed: SEED });
        const dem = makeSlopeDem(ctx);
        const specs = ctx.SimRocas.Simulation3D.buildRockSpecs(
            dem, OPTS, ctx.SimRocas.seededRandom(SEED),
        );
        const engine = new ctx.SimRocas.PhysicsEngine3D(ENGINE_PARAMS);
        const sim = new ctx.SimRocas.Simulation3D(dem, engine);
        sim.configure(SIM_PARAMS);
        sim.startWithSpecs(specs);
        while (sim.isRunning) { sim.step(50); }
        const results = sim.getResults();
        BASE = { ctx, dem, specs, rocks: results.rocks, stats: results.stats };
    }
    return BASE;
}

// --- Worker FALSO: sim3d-worker en un contexto vm ---------------------------

/**
 * Crea la clase FakeWorker. Cada instancia ejecuta js/workers/sim3d-worker.js
 * en su propio vm context 'worker' con shims de postMessage (saliente →
 * this.onmessage en queueMicrotask) e importScripts (resuelve rutas relativas
 * a js/workers/, quitando el sufijo ?v). postMessage entrante → self.onmessage
 * del sandbox con queueMicrotask (asíncrono, igual que un worker real).
 * `logs` registra entradas/salidas para inspeccionar las copias del DEM.
 */
function makeFakeWorkerClass(logs) {
    return class FakeWorker {
        constructor(url) {
            const self = this;
            this.url = url;
            this.onmessage = null;
            this.onerror = null;
            this._terminated = false;
            if (logs) { logs.push({ type: 'new', url }); }
            this._ctx = createContext({
                env: 'worker',
                extra: {
                    postMessage: (msg, transfer) => {
                        if (self._terminated) { return; }
                        if (logs) { logs.push({ type: 'out', from: self.url, message: msg }); }
                        queueMicrotask(() => {
                            if (!self._terminated && self.onmessage) {
                                self.onmessage({ data: msg });
                            }
                        });
                    },
                    importScripts: (...files) => {
                        for (const f of files) {
                            const rel = path.posix.normalize(
                                path.join('js', 'workers', String(f).split('?')[0]),
                            );
                            runScript(self._ctx, rel);
                        }
                    },
                },
            });
            runScript(this._ctx, 'js/workers/sim3d-worker.js');
        }

        postMessage(msg, transfer) {
            if (this._terminated) { return; }
            const ctx = this._ctx;
            const self = this;
            if (logs) { logs.push({ type: 'in', to: this.url, message: msg, transfer: transfer !== undefined }); }
            queueMicrotask(() => {
                if (!self._terminated && ctx.onmessage) {
                    ctx.onmessage({ data: msg });
                }
            });
        }

        terminate() {
            this._terminated = true;
            return true;
        }
    };
}

function loadPoolCtx({ useShared = false } = {}) {
    return loadScripts(POOL_FILES, { env: 'browser', extra: { crossOriginIsolated: !!useShared } });
}

async function runPool({ size, useShared = false, dem, specs, seed = SEED }) {
    const logs = [];
    const FakeWorkerClass = makeFakeWorkerClass(logs);
    const ctx = loadPoolCtx({ useShared });
    const progress = [];
    const pool = new ctx.SimRocas.Sim3DPool({
        size,
        WorkerClass: FakeWorkerClass,
        workerUrl: 'js/workers/sim3d-worker.js?v=1',
    });
    const result = await pool.run({
        dem,
        engineParams: ENGINE_PARAMS,
        simParams: SIM_PARAMS,
        rockSpecs: specs,
        seed,
        onProgress: (p) => progress.push(p),
    });
    return { result, logs, progress };
}

// --- Paridad exacta ---------------------------------------------------------

for (const size of [1, 3, 4]) {
    test('pool paridad exacta con Simulation3D (' + size + ' worker(s), sin SharedArrayBuffer)', async () => {
        const base = baseline();
        const { result, progress } = await runPool({ size, dem: base.dem, specs: base.specs });

        assert.ok(Array.isArray(result.rocks));
        assert.equal(result.rocks.length, base.specs.length);
        for (let i = 0; i < base.specs.length; i++) {
            const b = base.rocks[i];
            const r = result.rocks[i];
            assert.equal(r.stopReason, b.stopReason, 'roca ' + i + ' stopReason');
            assert.ok(Math.abs(r.finalX - b.finalX) <= 1e-9, 'roca ' + i + ' finalX');
            assert.ok(Math.abs(r.finalY - b.finalY) <= 1e-9, 'roca ' + i + ' finalY');
            assert.ok(Math.abs(r.finalZ - b.finalZ) <= 1e-9, 'roca ' + i + ' finalZ');
        }

        // El pool recalcula stats y son idénticos al hilo principal.
        assert.ok(Math.abs(result.stats.meanRunout - base.stats.meanRunout) <= 1e-9);
        assert.ok(Math.abs(result.stats.p95Runout - base.stats.p95Runout) <= 1e-9);
        assert.ok(Math.abs(result.stats.maxEnergyKJ - base.stats.maxEnergyKJ) <= 1e-9);
        assert.equal(result.stats.total, base.specs.length);
        assert.equal(result.stats.rest + result.stats.culled + result.stats.maxSteps, result.stats.total);

        // El runout se mide desde el punto de liberación de cada spec.
        const runouts = base.specs.map((s, i) => Math.hypot(
            result.rocks[i].finalX - s.x,
            result.rocks[i].finalY - s.y,
        )).sort((a, b) => a - b);
        const mean = runouts.reduce((a, b) => a + b, 0) / runouts.length;
        const p95 = runouts[Math.ceil(runouts.length * 0.95) - 1];
        assert.ok(Math.abs(mean - result.stats.meanRunout) <= 1e-9, 'meanRunout semántico');
        assert.ok(Math.abs(p95 - result.stats.p95Runout) <= 1e-9, 'p95Runout semántico');

        assert.ok(result.timing.ms > 0);
        assert.equal(result.timing.workers, size);

        // Progreso: hay mensajes con total = specs y done creciente.
        assert.ok(progress.length > 0, 'hay mensajes de progress');
        for (const p of progress) {
            assert.equal(p.total, base.specs.length);
            assert.ok(p.done >= 0 && p.done <= p.total);
        }
    });
}

test('pool paridad exacta con SharedArrayBuffer simulado (crossOriginIsolated)', async () => {
    const base = baseline();
    const { result } = await runPool({ size: 2, useShared: true, dem: base.dem, specs: base.specs });
    for (let i = 0; i < base.specs.length; i++) {
        const b = base.rocks[i];
        const r = result.rocks[i];
        assert.equal(r.stopReason, b.stopReason);
        assert.ok(Math.abs(r.finalX - b.finalX) <= 1e-9, 'roca ' + i + ' finalX (SAB)');
        assert.ok(Math.abs(r.finalY - b.finalY) <= 1e-9, 'roca ' + i + ' finalY (SAB)');
        assert.ok(Math.abs(r.finalZ - b.finalZ) <= 1e-9, 'roca ' + i + ' finalZ (SAB)');
    }
    assert.equal(result.timing.workers, 2);
});

test('pool: sin SAB envía una copia distinta por worker; con SAB comparte un único SharedArrayBuffer', async () => {
    const base = baseline();
    const originalHeights = base.dem.heights;

    const noSab = await runPool({ size: 3, useShared: false, dem: base.dem, specs: base.specs });
    const startsNoSab = noSab.logs.filter(
        (l) => l.type === 'in' && l.message && l.message.type === 'start',
    );
    assert.equal(startsNoSab.length, 3);
    const copies = startsNoSab.map((l) => l.message.dem.heights);
    for (const c of copies) {
        assert.ok(ArrayBuffer.isView(c), 'sin SAB: heights es un TypedArray copiado');
        assert.ok(c !== originalHeights, 'no se envía el heights original');
        assert.equal(Object.prototype.toString.call(c.buffer), '[object ArrayBuffer]',
            'copia local: buffer NO es SharedArrayBuffer');
    }
    assert.notEqual(copies[0], copies[1]);
    assert.notEqual(copies[1], copies[2]);
    // Misma elevación: las copias tienen el mismo contenido que el original.
    for (let k = 0; k < copies.length; k++) {
        for (let i = 0; i < 10; i++) {
            assert.equal(copies[k][i], originalHeights[i]);
        }
    }

    const withSab = await runPool({ size: 3, useShared: true, dem: base.dem, specs: base.specs });
    const startsSab = withSab.logs.filter(
        (l) => l.type === 'in' && l.message && l.message.type === 'start',
    );
    assert.equal(startsSab.length, 3);
    const sabs = startsSab.map((l) => l.message.dem.heights);
    for (const s of sabs) {
        // Intrínseco del contexto del pool: instanceof cruzado cae; comparar
        // con la clase del objeto.
        assert.equal(Object.prototype.toString.call(s), '[object SharedArrayBuffer]', 'SAB compartido');
    }
    assert.equal(sabs[0], sabs[1]);
    assert.equal(sabs[1], sabs[2], 'un único SharedArrayBuffer para todos los workers');
});

test('pool.cancel() rechaza la promesa en curso', async () => {
    const base = baseline();
    const logs = [];
    const FakeWorkerClass = makeFakeWorkerClass(logs);
    const ctx = loadPoolCtx();
    const pool = new ctx.SimRocas.Sim3DPool({
        size: 2,
        WorkerClass: FakeWorkerClass,
        workerUrl: 'js/workers/sim3d-worker.js?v=1',
    });
    const promise = pool.run({
        dem: base.dem,
        engineParams: ENGINE_PARAMS,
        simParams: SIM_PARAMS,
        rockSpecs: base.specs,
        seed: SEED,
    });
    pool.cancel();
    await assert.rejects(
        promise,
        (err) => err && /cancelada/i.test(err.message),
    );
    // Nada se ejecutó hasta complete.
    const outs = logs.filter((l) => l.type === 'out' && l.message.type === 'complete');
    assert.equal(outs.length, 0);
});

test('pool: error en el worker → la promesa rechaza con mensaje en español', async () => {
    const base = baseline();
    // heights con tamaño incorrecto → Dem lanza su error en español en el worker.
    const badDem = Object.assign({}, base.dem.toTransferable(), { heights: new Float32Array(3) });
    badDem.toTransferable = () => badDem; // pasa la validación del pool, falla al reconstruir
    const FakeWorkerClass = makeFakeWorkerClass(null);
    const ctx = loadPoolCtx();
    const pool = new ctx.SimRocas.Sim3DPool({
        size: 1,
        WorkerClass: FakeWorkerClass,
        workerUrl: 'js/workers/sim3d-worker.js?v=1',
    });
    await assert.rejects(
        pool.run({
            dem: badDem,
            engineParams: ENGINE_PARAMS,
            simParams: SIM_PARAMS,
            rockSpecs: base.specs,
            seed: SEED,
        }),
        (err) => err && /Sim3DPool/.test(err.message) && /Dem:/.test(err.message),
    );
});

test('pool: construcción con valores por defecto', () => {
    const ctx = loadScripts(POOL_FILES, { env: 'browser', extra: { navigator: { hardwareConcurrency: 8 } } });
    const R = ctx.SimRocas;
    const pool = new R.Sim3DPool({ WorkerClass: function Fake() {} });
    assert.equal(pool.size, 7, 'defecto: max(1, hardwareConcurrency − 1)');
    assert.equal(pool.workerUrl, 'js/workers/sim3d-worker.js');
    assert.throws(
        () => new R.Sim3DPool({ size: 0, WorkerClass: function Fake() {} }),
        (err) => err && /Sim3DPool/.test(err.message) && /size/.test(err.message),
    );
    assert.throws(
        () => new R.Sim3DPool({ size: 2 }),
        (err) => err && /Sim3DPool/.test(err.message) && /Worker/.test(err.message),
    );
});
