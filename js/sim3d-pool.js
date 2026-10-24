/**
 * SimRocas 3D — Pool de Workers para simulaciones 3D (contrato C7, T4.4).
 *
 * Reparte las rockSpecs (generadas en el hilo principal, para reproducibilidad)
 * en bloques balanceados entre `size` workers (defecto
 * max(1, hardwareConcurrency − 1)). Cada worker recibe una semilla única
 * (seed + índice), los parámetros del motor/la simulación y el DEM:
 *  - Si globalThis.crossOriginIsolated y existe SharedArrayBuffer: copiar las
 *    alturas UNA vez a un SharedArrayBuffer y enviarlo a todos los workers
 *    (memoria compartida, sin copia por worker).
 *  - Si no: copiar las alturas una por worker y transferir cada copia.
 *
 * El pool fusiona los resultados (orden de specs global) y recalcula stats
 * con SimRocas.computeStats3D. Errores del worker, cancelación y bloqueos →
 * la promesa de run() rechaza con un mensaje en español.
 *
 * Puro en datos (sin DOM): funciona en ventana y Node (tests con Worker falso
 * inyectando WorkerClass).
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    function defaultSize() {
        if (typeof navigator !== 'undefined' && navigator &&
            Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency >= 1) {
            return Math.max(1, Math.floor(navigator.hardwareConcurrency) - 1);
        }
        return 1;
    }

    /**
     * @param {object} [opts]
     * @param {string} [opts.workerUrl='js/workers/sim3d-worker.js'] URL del
     *   worker (admite sufijo ?v=N para cache-busting, que el worker propaga).
     * @param {number} [opts.size=max(1, hardwareConcurrency − 1)] Entero >= 1.
     * @param {class} [opts.WorkerClass=globalThis.Worker] Para tests (Worker falso).
     */
    class Sim3DPool {
        constructor(opts = {}) {
            this.workerUrl = opts.workerUrl !== undefined ? opts.workerUrl : 'js/workers/sim3d-worker.js';
            const WorkerClass = opts.WorkerClass !== undefined ? opts.WorkerClass : globalThis.Worker;
            if (typeof WorkerClass !== 'function') {
                throw new Error('Sim3DPool: se necesita una clase Worker (WorkerClass o globalThis.Worker)');
            }
            const size = opts.size !== undefined ? opts.size : defaultSize();
            if (!Number.isInteger(size) || size < 1) {
                throw new Error('Sim3DPool: size debe ser un entero >= 1 (recibido: ' + String(size) + ')');
            }
            this.size = size;
            this._WorkerClass = WorkerClass;
            this._runs = new Set();
        }

        /**
         * Ejecuta una simulación en paralelo.
         * @param {object} payload
         * @param {SimRocas.Dem} payload.dem
         * @param {object} [payload.engineParams] Parámetros de PhysicsEngine3D.
         * @param {object} [payload.simParams] { maxDuration, trajectoryInterval, stepsPerRock? }.
         * @param {Array<{x, y, z, vx?, vy?, vz?, diameter, density, sourceId?}>} payload.rockSpecs
         * @param {number} payload.seed Semilla entera finita (worker i: seed + i).
         * @param {function|null} [payload.onProgress] (p: { done, total }) => void.
         * @returns {Promise<{rocks: Array, stats: object, timing: {ms, workers}}>}
         */
        run(payload) {
            return new Promise((resolve, reject) => {
                try {
                    this._startRun(payload || {}, resolve, reject);
                } catch (err) {
                    reject(err);
                }
            });
        }

        _startRun(payload, resolve, reject) {
            const dem = payload.dem;
            if (!dem || typeof dem.toTransferable !== 'function') {
                throw new Error('Sim3DPool: dem debe ser un SimRocas.Dem (toTransferable)');
            }
            const rockSpecs = payload.rockSpecs;
            if (!Array.isArray(rockSpecs)) {
                throw new Error('Sim3DPool: rockSpecs debe ser un array de especificaciones');
            }
            const seed = payload.seed;
            if (!Number.isFinite(seed)) {
                throw new Error('Sim3DPool: seed debe ser un número finito (recibido: ' + String(seed) + ')');
            }
            const engineParams = payload.engineParams || {};
            const simParams = payload.simParams || {};
            const onProgress = typeof payload.onProgress === 'function' ? payload.onProgress : null;
            const total = rockSpecs.length;

            const t0 = performance.now();
            const useShared = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
            const baseDem = dem.toTransferable();

            // DEM: una copia a SharedArrayBuffer o una copia por worker.
            let demShared = null;
            if (useShared) {
                const sab = new SharedArrayBuffer(baseDem.heights.length * 4);
                new Float32Array(sab).set(baseDem.heights);
                demShared = Object.assign({}, baseDem, { heights: sab });
            }

            const workerCount = Math.max(1, Math.min(this.size, total));
            const blockSize = Math.floor(total / workerCount);
            const remainder = total % workerCount;

            const donePerWorker = new Array(workerCount).fill(0);
            const blockSizePerWorker = new Array(workerCount).fill(0);
            const resultsPerWorker = new Array(workerCount).fill(null);
            const workers = [];
            const record = {
                cancelled: false,
                settled: false,
                reject: reject,
                workers: workers,
            };
            this._runs.add(record);

            const finishIfComplete = () => {
                for (let i = 0; i < workerCount; i++) {
                    if (!resultsPerWorker[i]) {
                        return;
                    }
                }
                if (record.settled) {
                    return;
                }
                record.settled = true;
                // Fusionar en el ORDEN global de rockSpecs (índice de spec).
                const merged = [];
                for (let i = 0; i < workerCount; i++) {
                    for (let j = 0; j < resultsPerWorker[i].length; j++) {
                        merged.push(resultsPerWorker[i][j]);
                    }
                }
                const items = merged.map((rock, g) => ({
                    stopReason: rock.stopReason,
                    maxKineticEnergy: rock.maxKineticEnergy,
                    finalX: rock.finalX,
                    finalY: rock.finalY,
                    x0: rockSpecs[g].x,
                    y0: rockSpecs[g].y,
                }));
                const stats = SimRocas.computeStats3D(items);
                const result = {
                    rocks: merged,
                    stats: stats,
                    timing: {
                        ms: performance.now() - t0,
                        workers: workerCount,
                    },
                };
                this._teardown(record);
                resolve(result);
            };

            const fail = (workerIdx, message) => {
                if (record.cancelled || record.settled) {
                    return;
                }
                record.settled = true;
                this._teardown(record);
                reject(new Error('Sim3DPool: el worker ' + workerIdx + ' falló: ' + String(message)));
            };

            let blockStart = 0;
            for (let i = 0; i < workerCount; i++) {
                const blockCount = blockSize + (i < remainder ? 1 : 0);
                blockSizePerWorker[i] = blockCount;
                const blockSpecs = rockSpecs.slice(blockStart, blockStart + blockCount);
                blockStart += blockCount;

                let worker;
                try {
                    worker = new this._WorkerClass(this.workerUrl);
                } catch (err) {
                    fail(-1, 'no se pudo crear el worker: ' + ((err && err.message) || String(err)));
                    return;
                }
                workers.push(worker);
                const idx = i;

                worker.onmessage = (e) => {
                    const msg = e && e.data;
                    if (!msg || record.cancelled || record.settled) {
                        return;
                    }
                    if (msg.type === 'progress') {
                        donePerWorker[idx] = msg.done;
                        if (onProgress) {
                            let done = 0;
                            for (let k = 0; k < workerCount; k++) {
                                done += donePerWorker[k];
                            }
                            onProgress({ done: done, total: total });
                        }
                    } else if (msg.type === 'complete') {
                        donePerWorker[idx] = blockSizePerWorker[idx];
                        resultsPerWorker[idx] = msg.rocks || [];
                        try {
                            worker.terminate();
                        } catch (_alreadyGone) {
                            // El fake o el worker real ya murieron: sin drama.
                        }
                        finishIfComplete();
                    } else if (msg.type === 'error') {
                        fail(idx, msg.message);
                    }
                };
                worker.onerror = (event) => {
                    fail(idx, (event && (event.message || event.error && (event.error.message || String(event.error)))) || 'error desconocido en el worker');
                };

                if (useShared) {
                    worker.postMessage({
                        type: 'start',
                        dem: demShared,
                        engineParams: engineParams,
                        simParams: simParams,
                        rockSpecs: blockSpecs,
                        seed: seed + i,
                    });
                } else {
                    // Copia por worker + transfer de la copia (el original queda
                    // intacto en el hilo principal).
                    const heightsCopy = new Float32Array(baseDem.heights);
                    const copyDem = Object.assign({}, baseDem, { heights: heightsCopy });
                    worker.postMessage({
                        type: 'start',
                        dem: copyDem,
                        engineParams: engineParams,
                        simParams: simParams,
                        rockSpecs: blockSpecs,
                        seed: seed + i,
                    }, [heightsCopy.buffer]);
                }
            }
        }

        abortRun(record, message) {
            if (!record || record.settled) {
                return;
            }
            record.cancelled = true; // los mensajes tardíos ya no cuentan
            record.settled = true;
            this._teardown(record);
            record.reject(new Error(message));
        }

        _teardown(record) {
            for (const worker of record.workers) {
                try {
                    worker.terminate();
                } catch (_alreadyGone) {
                    // Nada que hacer.
                }
                if (worker._terminated !== undefined) {
                    worker._terminated = true;
                }
            }
            this._runs.delete(record);
        }

        /**
         * Cancela todas las corridas activas: termina los workers y rechaza
         * sus promesas con un error en español. Es asíncrono para los workers
         * reales (terminate) pero el rechazo es inmediato.
         */
        cancel() {
            let aborted = false;
            for (const record of Array.from(this._runs)) {
                this.abortRun(record, 'Sim3DPool: simulación cancelada por el usuario');
                aborted = true;
            }
            return aborted;
        }
    }

    SimRocas.Sim3DPool = Sim3DPool;
})(globalThis.SimRocas);
