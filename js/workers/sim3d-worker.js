/**
 * SimRocas 3D — Web Worker de simulación (contrato C7, T4.4).
 *
 * Ejecuta el MISMO código que el hilo principal (Dem, PhysicsEngine3D,
 * Simulation3D de js/): sin física duplicada. El pool lo abre como
 * `new Worker('js/workers/sim3d-worker.js?v=N')`, así que importScripts es
 * relativo a js/workers/ y el sufijo ?v se propaga (como js/worker.js).
 *
 * Mensajes IN:
 *   { type: 'start', dem: (toTransferable con heights en Float32Array o
 *                          SharedArrayBuffer → se envuelve como vista),
 *                    engineParams, simParams, rockSpecs: [{x, y, z, vx, vy,
 *                    vz, diameter, density, sourceId}], seed }
 *   { type: 'stop' } — el pool lo termina realmente con worker.terminate().
 *
 * Mensajes OUT:
 *   { type: 'progress', done, total } ~ cada 5 % de rocas terminadas.
 *   { type: 'complete', rocks: [serialización plana], (transfer: buffers de
 *                       trajectory) }.
 *   { type: 'error', message } — mensaje en español; la excepción anterior a
 *     postMessage no debe quedar sin registrar.
 *
 * Reproducibilidad: Math.random del worker se reemplaza por
 * SimRocas.seededRandom(seed) ANTES de crear motor/simulación; así, con la
 * misma semilla, el bloque de rocas es determinista aunque el host sea otro.
 */

// Cache-busting propagado (?v=N); en tests headless sin self.location queda ''.
const _v = (self.location && self.location.search) || '';
importScripts(
    '../dem.js' + _v,
    '../math3d.js' + _v,
    '../rigid3d.js' + _v,
    '../physics3d.js' + _v,
    '../physics3d-rigid.js' + _v,
    '../simulation3d.js' + _v,
);

const STEPS_PER_ROCK_DEFAULT = 50;

self.onmessage = function (e) {
    const msg = e && e.data;
    if (!msg || msg.type !== 'start') {
        return; // 'stop': el worker se termina desde fuera con terminate().
    }
    try {
        runBlock(msg);
    } catch (err) {
        try {
            const message = (err && err.message) || String(err);
            self.postMessage({ type: 'error', message: message });
        } catch (_postError) {
            // postMessage fallido: el pool detecta el bloqueo vía onerror.
        }
    }
};

/**
 * Dem local a partir del payload. heights llega como Float32Array (rama con
 * copia transferida) o como SharedArrayBuffer (rama compartida): se envuelve
 * en una vista sin copiar.
 */
function buildLocalDem(demPayload) {
    let dem = demPayload;
    // SharedArrayBuffer (rama compartida): envolver en una vista sin copiar.
    // Float32Array (rama con copia transferida): ya es vista, va directo.
    if (dem.heights && !ArrayBuffer.isView(dem.heights)) {
        dem = Object.assign({}, dem, { heights: new Float32Array(dem.heights) });
    }
    return SimRocas.Dem.fromTransferable(dem);
}

function serializeRock(rock) {
    return {
        // Posición/estado final (x, y, z = finalX/finalY/finalZ).
        x: rock.finalX,
        y: rock.finalY,
        z: rock.finalZ,
        finalX: rock.finalX,
        finalY: rock.finalY,
        finalZ: rock.finalZ,
        vx: rock.vx,
        vy: rock.vy,
        vz: rock.vz,
        isResting: rock.isResting,
        stopReason: rock.stopReason,
        bounces: rock.bounces,
        stepsTaken: rock.stepsTaken,
        elapsedTime: rock.elapsedTime,
        diameter: rock.diameter,
        radius: rock.radius,
        density: rock.density,
        mass: rock.mass,
        sourceId: rock.sourceId,
        maxKineticEnergy: rock.maxKineticEnergy,
        maxImpactVelocity: rock.maxImpactVelocity,
        maxBounceHeight: rock.maxBounceHeight,
        totalEnergyDissipated: rock.totalEnergyDissipated,
        impacts: rock.impacts,
        // Trayectoria: Float32Array transferible + número de cuádruplos válidos.
        trajectory: rock.trajectory,
        trajectoryLength: rock.trajectoryLength,
        trajectoryInterval: rock.trajectoryInterval,
        maxTrajectoryPoints: rock.maxTrajectoryPoints,
        // C7-rigid: orientaciones (cuaterniones w,x,y,z) alineadas con la
        // trayectoria; Float32Array transferible (null en lumped-mass).
        orientations: rock.orientations,
        orientationLength: rock.orientations ? rock._orientLength : 0,
        shapeKind: rock.shapeKind,
        shapeSeed: rock.shapeSeed,
    };
}

function runBlock(msg) {
    // Reproducibilidad: reemplazar Math.random ANTES de tocar la física.
    if (msg.seed !== undefined && msg.seed !== null) {
        Math.random = SimRocas.seededRandom(msg.seed);
    }

    const dem = buildLocalDem(msg.dem);
    const engine = new SimRocas.PhysicsEngine3D(msg.engineParams || {});
    const sim = new SimRocas.Simulation3D(dem, engine);
    sim.configure(msg.simParams || {});
    sim.startWithSpecs(msg.rockSpecs || []);

    const total = msg.rockSpecs ? msg.rockSpecs.length : 0;
    const stepsPerRock = (msg.simParams && msg.simParams.stepsPerRock) || STEPS_PER_ROCK_DEFAULT;
    let lastPublishedPct = 0;

    while (sim.isRunning) {
        sim.step(stepsPerRock);
        // Sin rocas: el bucle no entra; con rocas, publicar cada ~5 %.
        if (total > 0) {
            const pct = Math.min(99, Math.floor(sim.settledCount * 100 / total));
            if (pct >= lastPublishedPct + 5) {
                lastPublishedPct = pct;
                self.postMessage({ type: 'progress', done: sim.settledCount, total: total });
            }
        }
    }

    const transfer = [];
    const rocks = msg.rockSpecs ? new Array(total) : [];
    for (let i = 0; i < total; i++) {
        const serialized = serializeRock(sim.rocks[i]);
        rocks[i] = serialized;
        // Transferir el buffer de cada trayectoria (su propietario es este
        // worker; en el hilo principal llega sin copia) y, si existe, el de
        // orientaciones (C7-rigid).
        if (serialized.trajectory && serialized.trajectory.buffer) {
            transfer.push(serialized.trajectory.buffer);
        }
        if (serialized.orientations && serialized.orientations.buffer) {
            transfer.push(serialized.orientations.buffer);
        }
    }
    if (total > 0) {
        self.postMessage({ type: 'progress', done: total, total: total });
    }
    self.postMessage({ type: 'complete', rocks: rocks }, transfer);
}
