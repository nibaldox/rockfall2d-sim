/**
 * SimRocas — App: ejecución de la simulación con Web Worker (T0.9).
 * Mixin sobre SimRocas.App.prototype; se carga después de js/app.js.
 */

// Cache-busting del worker: al cambiar el protocolo o los scripts cargados
// por js/worker.js, subir este número y el ?v= de los <script> de index.html.
const WORKER_VERSION = 13;

Object.assign(SimRocas.App.prototype, {
    runSimulationWithWorker(diameter, density, initVel, angle, shapeType, aspectRatio, params, multiPoints) {
        if (this._worker) {
            this._worker.terminate();
        }

        this._worker = new Worker('js/worker.js?v=' + WORKER_VERSION);
        this._workerActive = true;
        const worker = this._worker;
        const runEpoch = this._runEpoch;

        // Los mismos argumentos, en el mismo orden, que la llamada a
        // this.simulation.start del modo normal (runSimulation). El worker
        // ejecuta la MISMA clase Simulation — no se reconstruyen configs.
        const startArgs = [
            this.releasePoint.x,
            this.releasePoint.y,
            diameter,
            density,
            initVel,
            angle,
            params.maxDuration,
            params.ignoreResting,
            shapeType,
            aspectRatio,
            this.releaseMode,
            multiPoints ? multiPoints.map(p => ({ ...p })) : null
        ];

        // Copia de las propiedades primitivas del motor de física (el mismo
        // objeto que usa el modo normal: this.simulation.physics). Los valores
        // no primitivos (métodos, buffers) no se pueden estructurar por el
        // canal del worker y no los lee la simulación.
        const physics = this.simulation.physics || this.physics;
        const physicsParams = {};
        for (const key of Object.keys(physics)) {
            const value = physics[key];
            const type = typeof value;
            if (type === 'number' || type === 'string' || type === 'boolean') {
                physicsParams[key] = value;
            }
        }

        worker.onmessage = (e) => {
            if (this._worker !== worker || !this._workerActive || this._runEpoch !== runEpoch) return;
            const msg = e.data;

            if (msg.type === 'progress') {
                const count = document.getElementById('rock-count-display');
                if (count) {
                    count.textContent = `Rocas: ${msg.data.simulatedCount}`;
                    count.classList.remove('warning-amber', 'warning-red');
                    if (msg.data.simulatedCount >= 800) count.classList.add('warning-red');
                    else if (msg.data.simulatedCount >= 500) count.classList.add('warning-amber');
                }
                const progress = Math.round(msg.data.progress * 100);
                document.getElementById('simulation-status').textContent =
                    `Simulando (Worker)... ${progress}% (${msg.data.simulatedCount}/${msg.data.totalRocks}) · semilla ${params.seed}`;
            }

            if (msg.type === 'frame') {
                // Store in simulation frames for timeline playback!
                this.simulation.frames.push(msg.frame);

                // Reconstruct lightweight rock objects for rendering
                this._workerRocks = msg.frame.map(f => ({
                    id: f.id,
                    x: f.x,
                    y: f.y,
                    rotation: f.rotation,
                    isResting: f.isResting,
                    parentId: f.parentId,
                    isFragmented: f.isFragmented
                }));
                this._renderWorkerFrame();
            }

            if (msg.type === 'complete') {
                this._workerActive = false;
                this.simulation.isRunning = false;
                this._completeRun(msg.rocks, msg.status, true);
                this.render();
            }
        };

        worker.onerror = (err) => {
            if (this._worker !== worker || !this._workerActive || this._runEpoch !== runEpoch) return;
            console.error('Worker error:', err);
            alert('Error en Web Worker. Revisa la consola.');
            this._workerActive = false;
            this._worker = null;
            worker.terminate();
            this._runEpoch = (this._runEpoch || 0) + 1;
            this._workerRocks = null;
            this.simulation.reset();
            this._invalidateResults();
            document.getElementById('simulation-status').textContent = 'Error en Web Worker; corrida invalidada';
            document.getElementById('btn-run').disabled = false;
            document.getElementById('btn-stop').disabled = true;
            const fab = document.getElementById('fab-run');
            if (fab) { fab.classList.remove('running'); fab.textContent = '▶'; }
            this.render();
        };

        const message = {
            type: 'start',
            terrainJSON: this.terrain.toJSON(),
            simParams: params,
            physicsParams,
            barriers: (this.barriers || []).map(b => ({ ...b })),
            startArgs
        };
        // P1.3: los colectores congelados de esta corrida viajan al nivel de
        // barriers, campo por campo. Sin colectores el mensaje no cambia (I-A).
        const runInfo = this._runInfo && this._runInfo.epoch === runEpoch ? this._runInfo : null;
        if (runInfo && Array.isArray(runInfo.collectors) && runInfo.collectors.length > 0) {
            message.collectors = runInfo.collectors.map(c => ({ id: c.id, x: c.x, label: c.label }));
        }
        this._worker.postMessage(message);
    },

    // Vértigos de mundo de un Rock (misma fórmula que js/physics.js) para las
    // rocas reconstruidas del worker, que llegan como datos planos. Se invoca
    // con la roca como `this`.
    _workerRockShapeVertices() {
        const cos = Math.cos(this.rotation);
        const sin = Math.sin(this.rotation);
        const len = this.shape.length;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            const p = this.shape[i];
            result[i] = {
                x: this.x + p.x * cos - p.y * sin,
                y: this.y + p.x * sin + p.y * cos
            };
        }
        return result;
    },

    _renderWorkerFrame() {
        if (!this._workerRocks) return;
        // Quick render: just positions as dots
        const ctx = this.canvas.getContext('2d');
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;

        // Use the standard render pipeline but with worker rocks as positions
        this.renderer.render(null, this.releasePoint.x, this.releasePoint.y);

        // Overlay worker rock positions
        const rocks = this._workerRocks;
        ctx.fillStyle = 'rgba(180, 160, 140, 0.7)';
        for (let i = 0; i < rocks.length; i++) {
            const r = rocks[i];
            if (r.isResting) continue;
            const cx = r.x * scale + offsetX;
            const cy = canvasH - (r.y * scale + offsetY);
            ctx.beginPath();
            ctx.arc(cx, cy, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

});
