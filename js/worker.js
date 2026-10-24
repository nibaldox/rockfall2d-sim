/**
 * SimRocas 2D — Web Worker for simulation
 *
 * Runs the SAME simulation classes as the main thread (SimRocas.Terrain,
 * SimRocas.PhysicsEngine, SimRocas.Simulation from js/terrain.js,
 * js/physics.js and js/simulation.js) so there is no duplicated physics.
 * The worker is created with `new Worker('js/worker.js')`, so importScripts
 * paths are relative to js/.
 *
 * Messages IN:
 *   { type: 'start', terrainJSON, simParams, physicsParams, barriers, startArgs }
 *     - terrainJSON:    string — Terrain.toJSON() del hilo principal
 *     - simParams:      objeto params de getSimulationParams (para sim.configure)
 *     - physicsParams:  copia de las propiedades primitivas del PhysicsEngine
 *                       del hilo principal (calcMethod, kn/kt, energyModel...)
 *     - barriers:       array de barreras {x1,y1,x2,y2,...} o []
 *     - startArgs:      argumentos exactos y en el mismo orden que la llamada
 *                       a simulation.start del modo normal (js/app.js)
 *   { type: 'stop' } — el worker se termina desde fuera (worker.terminate)
 *
 * Messages OUT:
 *   { type: 'progress', data: { simulatedCount, totalRocks, progress } }
 *     cada iteración del bucle, como simulation.onUpdate del modo normal.
 *   { type: 'frame', frame: [{ id, x, y, rotation, isResting, parentId, isFragmented }] }
 *     cada 3 iteraciones; cada frame se alinea por índice con el array de
 *     rocas informado en 'complete' (misma pareja que usa la timeline).
 *   { type: 'complete', rocks: [...] }
 *     serialización de Simulation.rocks con todos los campos que consumen
 *     js/stats.js y js/renderer.js (ver los puntos de consumo en cada campo).
 */

// Cache-busting: el host abre el worker con una consulta (?v=N); se repite
// aquí para que terrain/physics/simulation se invaliden a la vez. Si el
// entorno no expone self.location (tests headless), no se añade sufijo.
const _v = (self.location && self.location.search) || '';
importScripts('terrain.js' + _v, 'physics.js' + _v, 'simulation.js' + _v);

// Publicar snapshot cada N iteraciones del bucle (igual que antes).
const FRAME_EVERY = 3;

// Red de seguridad: el stop duro de Simulation (maxStepsPerRock por roca)
// ya acota el bucle, pero evita un hang entero si algo se vuelve NaN.
const MAX_ITERATIONS_SIMULATED = 100000;

self.onmessage = function (e) {
    const msg = e.data;

    if (msg.type === 'start') {
        runWorkerSimulation(msg);
    } else if (msg.type === 'stop') {
        // Worker will be terminated from outside
    }
};

function runWorkerSimulation(msg) {
    const terrain = new SimRocas.Terrain();
    terrain.fromJSON(msg.terrainJSON);

    const physics = new SimRocas.PhysicsEngine();
    const sim = new SimRocas.Simulation(terrain, physics);
    sim.configure(msg.simParams);
    Object.assign(physics, msg.physicsParams);
    sim.barriers = msg.barriers || [];

    // Mismos argumentos y orden que simulation.start en el modo normal.
    sim.start(...msg.startArgs);

    const totalRocks = sim.totalRocks;
    let iterations = 0;

    while (sim.isRunning) {
        sim.step();
        iterations++;

        if (iterations > MAX_ITERATIONS_SIMULATED) {
            sim.stop();
        }

        if (iterations % FRAME_EVERY === 0) {
            self.postMessage({ type: 'frame', frame: snapshotFrame(sim.rocks) });
        }

        self.postMessage({
            type: 'progress',
            data: {
                simulatedCount: sim.simulatedCount,
                totalRocks,
                progress: totalRocks > 0 ? sim.simulatedCount / totalRocks : 0
            }
        });
    }

    self.postMessage({ type: 'complete', rocks: serializeRocks(sim.rocks) });
}

// Snapshot indexado igual que Simulation.recordFrame: frame[i] <-> rocks[i].
function snapshotFrame(rocks) {
    return rocks.map(r => ({
        id: r.id,
        x: r.x,
        y: r.y,
        rotation: r.rotation,
        isResting: r.isResting,
        parentId: r.parentId,
        isFragmented: r.isFragmented
    }));
}

/**
 * Serializa las rocas terminadas para el hilo principal. Campos conforme a
 * sus consumidores:
 *   - js/stats.js compute(): maxKineticEnergy, maxBounceHeight, finalX,
 *     maxImpactVelocity, bounces, impactEnergies, isResting
 *   - js/renderer.js drawTrajectories(): trajectory (tripletes planos x,y,v),
 *     id, parentId
 *   - js/renderer.js drawBouncePoints(): bouncePoints
 *   - js/renderer.js drawRocks(): getShapeVertices() (recosturido en el hilo
 *     principal), radius, _colorActive/_colorResting/_colorStroke
 *   - js/renderer.js renderTimelineFrame(): shape, color ({r,g,b}), radius
 *   - fragmentación: generation, parentId, isFragmented, isCore,
 *     massLossRatio, originalDiameter
 */
function serializeRocks(rocks) {
    return rocks.map(r => ({
        id: r.id,
        generation: r.generation,
        parentId: r.parentId,
        isFragmented: r.isFragmented,
        isCore: r.isCore,
        massLossRatio: r.massLossRatio,
        originalDiameter: r.originalDiameter,
        x: r.x,
        y: r.y,
        vx: r.vx,
        vy: r.vy,
        diameter: r.diameter,
        radius: r.radius,
        density: r.density,
        rotation: r.rotation,
        angularVelocity: r.angularVelocity,
        bounces: r.bounces,
        maxBounceHeight: r.maxBounceHeight,
        maxKineticEnergy: r.maxKineticEnergy,
        maxImpactVelocity: r.maxImpactVelocity,
        trajectory: r.trajectory,
        bouncePoints: r.bouncePoints,
        impactEnergies: r.impactEnergies,
        finalX: r.finalX,
        finalY: r.finalY,
        isResting: r.isResting,
        totalEnergyDissipated: r.totalEnergyDissipated,
        stepsTaken: r.stepsTaken,
        elapsedTime: r.elapsedTime,
        mass: r.mass,
        shape: r.shape,
        shapeType: r.shapeType,
        color: r.color,
        _colorActive: r._colorActive,
        _colorResting: r._colorResting,
        _colorStroke: r._colorStroke
    }));
}
