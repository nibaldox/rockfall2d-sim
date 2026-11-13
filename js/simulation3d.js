/**
 * SimRocas 3D — controlador de simulación sobre DEM (contrato C7, T4.3).
 *
 * Simulation3D orquesta PhysicsEngine3D: genera las especificaciones de
 * liberación (buildRockSpecs, estático y puro, reproducible con un PRNG
 * sembrado), lanza la corrida (start/startWithSpecs) y avanza las rocas por
 * bloques de pasos (step) hasta que todas terminan (reposo, culling o tope de
 * pasos). Los resultados incluyen stats: total/rest/culled/maxSteps, runout
 * medio y p95 (distancia horizontal desde el punto de liberación) y energía
 * máxima.
 *
 * Puro en datos: sin DOM; funciona en ventana, Web Worker y Node (load.js).
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * PRNG mulberry32 sembrado. Mismo algoritmo que tests/helpers/load.js para
     * que las corridas sembradas en tests (Math.random reemplazado) y las
     * unidades que piden un rng explícito consuman la misma secuencia.
     * @param {number} seed Semilla (entera; se trunca a uint32).
     * @returns {function(): number} Devuelve [0, 1).
     */
    function seededRandom(seed) {
        if (!Number.isFinite(seed)) {
            throw new Error('Simulation3D.seededRandom: seed debe ser un número finito (recibido: ' + String(seed) + ')');
        }
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const NO_DATA_MAX_ATTEMPTS = 10;

    /**
     * Stats del contrato: total/rest/culled/maxSteps, runout medio y p95 y
     * energía máxima. `items` = [{ stopReason, maxKineticEnergy, finalX,
     * finalY, x0, y0 }] (runout = distancia horizontal desde (x0, y0)).
     * La usa Simulation3D.getResults y el pool tras fusionar workers.
     */
    function computeStats3D(items) {
        const total = items.length;
        let rest = 0;
        let culled = 0;
        let maxStepsCount = 0;
        let maxEnergyJ = 0;
        const runouts = [];
        for (let i = 0; i < total; i++) {
            const item = items[i];
            if (item.stopReason === 'rest') {
                rest++;
            } else if (item.stopReason === 'culled') {
                culled++;
            } else if (item.stopReason === 'maxSteps') {
                maxStepsCount++;
            }
            if (item.maxKineticEnergy > maxEnergyJ) {
                maxEnergyJ = item.maxKineticEnergy;
            }
            runouts.push(Math.hypot(item.finalX - item.x0, item.finalY - item.y0));
        }
        let meanRunout = 0;
        let p95Runout = 0;
        if (total > 0) {
            let sum = 0;
            for (let i = 0; i < total; i++) {
                sum += runouts[i];
            }
            meanRunout = sum / total;
            const sorted = runouts.slice().sort((a, b) => a - b);
            p95Runout = sorted[Math.max(0, Math.ceil(total * 0.95) - 1)];
        }
        return {
            total: total,
            rest: rest,
            culled: culled,
            maxSteps: maxStepsCount,
            meanRunout: meanRunout,
            p95Runout: p95Runout,
            maxEnergyKJ: maxEnergyJ / 1000,
        };
    }

    /**
     * Controlador de simulación 3D de masa concentrada sobre DEM.
     */
    class Simulation3D {
        /**
         * @param {SimRocas.Dem} dem
         * @param {SimRocas.PhysicsEngine3D} engine
         */
        constructor(dem, engine) {
            if (!dem || typeof dem.heightAt !== 'function' || typeof dem.normalAt !== 'function') {
                throw new Error('Simulation3D: dem debe ser un SimRocas.Dem (heightAt/normalAt)');
            }
            if (!engine || !(engine.dt > 0) || typeof engine.simulateStep !== 'function') {
                throw new Error('Simulation3D: engine debe ser un SimRocas.PhysicsEngine3D válido (simulateStep/dt)');
            }
            this.dem = dem;
            this.engine = engine;
            this.maxDuration = 60;
            this.trajectoryInterval = 4;
            this.maxSteps = Math.ceil(this.maxDuration / engine.dt);
            this.rocks = [];
            this._initial = [];
            this.isRunning = false;
        }

        /**
         * @param {object} [opts]
         * @param {number} [opts.maxDuration=60] s → maxSteps = ceil(maxDuration / dt).
         * @param {number} [opts.trajectoryInterval=4] pasos entre muestras.
         */
        configure(opts = {}) {
            const maxDuration = opts.maxDuration !== undefined ? opts.maxDuration : 60;
            if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
                throw new Error('Simulation3D.configure: maxDuration debe ser finito y > 0 (recibido: ' + String(maxDuration) + ')');
            }
            const trajectoryInterval = opts.trajectoryInterval !== undefined ? opts.trajectoryInterval : 4;
            if (!Number.isInteger(trajectoryInterval) || trajectoryInterval < 1) {
                throw new Error('Simulation3D.configure: trajectoryInterval debe ser un entero >= 1 (recibido: ' + String(trajectoryInterval) + ')');
            }
            this.maxDuration = maxDuration;
            this.trajectoryInterval = trajectoryInterval;
            this.maxSteps = Math.ceil(maxDuration / this.engine.dt);
            return this;
        }

        /** Rocas ya terminadas (stopReason asignado). */
        get settledCount() {
            let settled = 0;
            for (let i = 0; i < this.rocks.length; i++) {
                if (this.rocks[i].stopReason !== null) {
                    settled++;
                }
            }
            return settled;
        }

        /**
         * Genera las specs de liberación (buildRockSpecs) y arranca.
         * @param {object} opts Ver buildRockSpecs (más rng opcional para las
         *   posiciones).
         */
        start(opts = {}) {
            const specs = Simulation3D.buildRockSpecs(this.dem, opts, opts.rng || Math.random);
            return this.startWithSpecs(specs);
        }

        /**
         * Arranca con specs ya generadas (reproducibilidad en el hilo principal).
         * @param {Array<{x, y, z, vx?, vy?, vz?, diameter, density, sourceId?}>} specs
         */
        startWithSpecs(specs) {
            if (!Array.isArray(specs)) {
                throw new Error('Simulation3D.startWithSpecs: specs debe ser un array de especificaciones');
            }
            const rocks = [];
            // C7-rigid: con motor 'rigid-body' cada spec se materializa como
            // RigidBody3D con forma real; el rng de la spec (shapeSeed)
            // construye forma y actitud de forma reproducible también en el
            // worker (mono-hilo y pool dan la misma trayectoria).
            const rigid = this.engine.method === 'rigid-body';
            for (let i = 0; i < specs.length; i++) {
                const s = specs[i];
                let opts = {
                    x: s.x,
                    y: s.y,
                    z: s.z,
                    vx: s.vx,
                    vy: s.vy,
                    vz: s.vz,
                    diameter: s.diameter,
                    density: s.density,
                    sourceId: s.sourceId,
                    trajectoryInterval: this.trajectoryInterval,
                };
                if (rigid) {
                    if (typeof SimRocas.Rigid3DFactory !== 'object') {
                        throw new Error('Simulation3D.startWithSpecs: method "rigid-body" requiere js/physics3d-rigid.js (SimRocas.Rigid3DFactory)');
                    }
                    const rng = SimRocas.seededRandom(s.shapeSeed !== undefined ? s.shapeSeed : 0);
                    const principal = SimRocas.Rigid3DFactory.buildPrincipal(s, rng);
                    const init = SimRocas.Rigid3DFactory.initOrientation(
                        rng, s.initialAngularVelocityMax !== undefined ? s.initialAngularVelocityMax : 0.2);
                    // La com se coloca con el radio envolvente REAL de la
                    // forma (la spec usa el radio esférico equivalente): así
                    // ningún vértice arranca bajo el terreno con cualquier
                    // actitud; los modos de liberación conservan su semántica.
                    opts.z = s.z - s.diameter / 2 + principal.boundingRadius;
                    opts.method = 'rigid-body';
                    opts.principal = principal;
                    opts.shape = s.shape !== undefined ? s.shape : 'irregular';
                    opts.shapeSeed = s.shapeSeed !== undefined ? s.shapeSeed : null;
                    opts.orientation = init.orientation;
                    opts.angularVelocity = init.angularVelocity;
                }
                rocks.push(new SimRocas.Rock3D(opts));
            }
            this.rocks = rocks;
            this._initial = specs.map((s) => ({ x: s.x, y: s.y }));
            this.isRunning = true;
            return this;
        }

        /**
         * Avanza cada roca activa hasta `stepsPerRock` pasos (sin pasarse de
         * maxSteps). No se puede reactivar una roca terminada.
         * @param {number} [stepsPerRock=50]
         */
        step(stepsPerRock = 50) {
            if (!Number.isFinite(stepsPerRock) || stepsPerRock < 1) {
                throw new Error('Simulation3D.step: stepsPerRock debe ser finito y >= 1 (recibido: ' + String(stepsPerRock) + ')');
            }
            if (!this.isRunning) {
                return;
            }
            let settled = 0;
            for (let i = 0; i < this.rocks.length; i++) {
                const rock = this.rocks[i];
                if (rock.isResting) {
                    settled++;
                    continue;
                }
                for (let k = 0; k < stepsPerRock && rock.stepsTaken < this.maxSteps; k++) {
                    this.engine.simulateStep(rock, this.dem);
                }
                if (!rock.isResting && rock.stepsTaken >= this.maxSteps) {
                    rock.isResting = true;
                    rock.stopReason = 'maxSteps';
                }
                if (rock.isResting) {
                    settled++;
                }
            }
            if (settled >= this.rocks.length) {
                this.isRunning = false;
            }
        }

        /**
         * Resultados: { rocks: Rock3D[], stats } — ver computeStats3D.
         */
        getResults() {
            const items = [];
            for (let i = 0; i < this.rocks.length; i++) {
                const rock = this.rocks[i];
                const init = this._initial[i];
                items.push({
                    stopReason: rock.stopReason,
                    maxKineticEnergy: rock.maxKineticEnergy,
                    finalX: rock.finalX,
                    finalY: rock.finalY,
                    x0: init.x,
                    y0: init.y,
                });
            }
            return { rocks: this.rocks, stats: computeStats3D(items) };
        }

        /**
         * Generador estático y PURO de especificaciones de liberación:
         * reparte totalRocks entre las zonas (SourceZones.distribute), muestrea
         * posiciones (SourceZones.sample) descartando y reintentando las sin
         * dato en el DEM (tope NO_DATA_MAX_ATTEMPTS) y materializa la posición
         * inicial y el diámetro.
         *
         * El orden de consumo del rng es fijo (por roca: posición, luego
         * variación de diámetro), de forma que la misma semilla produce
         * exactamente las mismas specs.
         *
         * @param {SimRocas.Dem} dem
         * @param {object} opts
         * @param {Array<{id, type}>} opts.zones Zonas fuente (≥ 1).
         * @param {number} opts.totalRocks Entero >= 0.
         * @param {number} opts.diameter Diámetro base (m) > 0.
         * @param {number} opts.density Densidad (kg/m³) > 0.
         * @param {'detachment'|'fall'} [opts.releaseMode='detachment']
         * @param {number} [opts.heightAboveGround=2] Solo en 'fall' (m).
         * @param {{vx?: number, vy?: number, vz?: number}} [opts.initialVelocity]
         * @param {number} [opts.diameterVariability=0] % en [0, 100].
         * @param {function(): number} [rng] PRNG en [0, 1); por defecto Math.random.
         * @returns {Array<{x, y, z, vx, vy, vz, diameter, density, sourceId}>}
         */
        static buildRockSpecs(dem, opts = {}, rng) {
            if (!dem || typeof dem.heightAt !== 'function') {
                throw new Error('Simulation3D.buildRockSpecs: dem debe ser un SimRocas.Dem con heightAt');
            }
            const zones = opts.zones;
            if (!Array.isArray(zones) || zones.length === 0) {
                throw new Error('Simulation3D.buildRockSpecs: zones debe ser un array con al menos una zona');
            }
            const totalRocks = opts.totalRocks;
            if (!Number.isInteger(totalRocks) || totalRocks < 0) {
                throw new Error('Simulation3D.buildRockSpecs: totalRocks debe ser un entero >= 0 (recibido: ' + String(totalRocks) + ')');
            }
            const diameter = opts.diameter;
            if (!Number.isFinite(diameter) || diameter <= 0) {
                throw new Error('Simulation3D.buildRockSpecs: diameter debe ser finito y > 0 (recibido: ' + String(diameter) + ')');
            }
            const density = opts.density;
            if (!Number.isFinite(density) || density <= 0) {
                throw new Error('Simulation3D.buildRockSpecs: density debe ser finita y > 0 (recibido: ' + String(density) + ')');
            }
            const releaseMode = opts.releaseMode !== undefined ? opts.releaseMode : 'detachment';
            if (releaseMode !== 'detachment' && releaseMode !== 'fall') {
                throw new Error('Simulation3D.buildRockSpecs: releaseMode debe ser "detachment" o "fall" (recibido: "' + String(releaseMode) + '")');
            }
            const heightAboveGround = opts.heightAboveGround !== undefined ? opts.heightAboveGround : 2;
            if (!Number.isFinite(heightAboveGround) || heightAboveGround < 0) {
                throw new Error('Simulation3D.buildRockSpecs: heightAboveGround debe ser finito y >= 0 (recibido: ' + String(heightAboveGround) + ')');
            }
            const diameterVariability = opts.diameterVariability !== undefined ? opts.diameterVariability : 0;
            if (!Number.isFinite(diameterVariability) || diameterVariability < 0 || diameterVariability > 100) {
                throw new Error('Simulation3D.buildRockSpecs: diameterVariability debe ser un porcentaje finito en [0, 100] (recibido: ' + String(diameterVariability) + ')');
            }
            const velocity = { vx: 0, vy: 0, vz: 0 };
            if (opts.initialVelocity) {
                for (const key of ['vx', 'vy', 'vz']) {
                    const v = opts.initialVelocity[key];
                    if (v === undefined) {
                        continue;
                    }
                    if (!Number.isFinite(v)) {
                        throw new Error('Simulation3D.buildRockSpecs: initialVelocity.' + key + ' debe ser un número finito (recibido: ' + String(v) + ')');
                    }
                    velocity[key] = v;
                }
            }
            const random = rng || Math.random;

            // C7-rigid (T5.3): forma real y actitud inicial por roca. Los
            // campos nuevos SOLO se consumen con method 'rigid-body', de forma
            // que con 'lumped-mass' la secuencia del rng (y por tanto las
            // specs) sigue siendo idéntica a la del contrato original.
            const method = opts.method !== undefined ? opts.method : 'lumped-mass';
            if (Simulation3D.supportedMethods.indexOf(method) < 0) {
                throw new Error('Simulation3D.buildRockSpecs: method "' + String(method) + '" no soportado — usar lumped-mass o rigid-body');
            }
            const rigid = method === 'rigid-body';
            const shape = rigid ? (opts.shape !== undefined ? opts.shape : 'irregular') : null;
            if (rigid && ['irregular', 'box', 'ellipsoid'].indexOf(shape) < 0) {
                throw new Error('Simulation3D.buildRockSpecs: shape "' + String(shape) + '" no soportada — usar irregular, box o ellipsoid');
            }
            const aspect = rigid && opts.aspect !== undefined ? opts.aspect : null;
            if (rigid && aspect !== null && !(aspect.b > 0 && aspect.c > 0)) {
                throw new Error('Simulation3D.buildRockSpecs: aspect.b y aspect.c deben ser > 0');
            }
            const segments = rigid && opts.segments !== undefined ? opts.segments : null;
            if (rigid && segments !== null && !(Number.isInteger(segments) && segments > 2)) {
                throw new Error('Simulation3D.buildRockSpecs: segments debe ser un entero > 2 (ellipsoid)');
            }
            const omegaMax = opts.initialAngularVelocityMax !== undefined ? opts.initialAngularVelocityMax : 0.2;
            if (rigid && (!Number.isFinite(omegaMax) || omegaMax < 0)) {
                throw new Error('Simulation3D.buildRockSpecs: initialAngularVelocityMax debe ser finito y >= 0');
            }

            const reparto = SimRocas.SourceZones.distribute(zones, totalRocks);
            const specs = [];
            for (let z = 0; z < reparto.length; z++) {
                const zone = reparto[z].zone;
                const count = reparto[z].count;
                for (let i = 0; i < count; i++) {
                    // Posición con dato: descarta y reintenta con tope.
                    let point = null;
                    for (let attempt = 0; attempt < NO_DATA_MAX_ATTEMPTS; attempt++) {
                        const candidate = SimRocas.SourceZones.sample(zone, 1, random)[0];
                        if (dem.contains(candidate.x, candidate.y)) {
                            point = candidate;
                            break;
                        }
                    }
                    if (point === null) {
                        throw new Error('Simulation3D.buildRockSpecs: no se encontró una posición con dato en el DEM para la zona "' + String(zone.id) + '" tras ' + NO_DATA_MAX_ATTEMPTS + ' intentos');
                    }
                    const h = dem.heightAt(point.x, point.y);
                    const diameterFactor = 1 + (random() * 2 - 1) * (diameterVariability / 100);
                    const d = diameter * diameterFactor;
                    const radius = d / 2;
                    const zInitial = h + radius + (releaseMode === 'fall' ? heightAboveGround : 0);
                    // C7-rigid: shapeSeed por roca (forma actitud reproducible
                    // en el hilo principal y en cada worker del pool).
                    const shapeSeed = rigid ? Math.floor(random() * 4294967296) : null;
                    const spec = {
                        x: point.x,
                        y: point.y,
                        z: zInitial,
                        vx: velocity.vx,
                        vy: velocity.vy,
                        vz: velocity.vz,
                        diameter: d,
                        density: density,
                        sourceId: z,
                    };
                    if (rigid) {
                        spec.method = 'rigid-body';
                        spec.shape = shape;
                        spec.aspect = aspect;
                        spec.segments = segments;
                        spec.initialAngularVelocityMax = omegaMax;
                        spec.shapeSeed = shapeSeed;
                    }
                    specs.push(spec);
                }
            }
            return specs;
        }
    }

    /** Métodos de contacto soportados (C7-rigid; idem PhysicsEngine3D). */
    Simulation3D.supportedMethods = ['lumped-mass', 'rigid-body'];

    SimRocas.Simulation3D = Simulation3D;
    SimRocas.seededRandom = seededRandom;
    SimRocas.computeStats3D = computeStats3D;
})(globalThis.SimRocas);
