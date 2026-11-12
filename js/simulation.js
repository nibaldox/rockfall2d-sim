// Valor efectivo de un parámetro numérico: se conserva si es finito y cumple
// el dominio (negativo admitido o solo positivo; entero cuando se exige) y, si
// no, se usa el defecto. Los ceros válidos no se sustituyen.
function effectiveNumber(value, fallback, allowZero, requireInteger) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    if (requireInteger && !Number.isInteger(value)) return fallback;
    if (allowZero ? value < 0 : value <= 0) return fallback;
    return value;
}

class Simulation {
    constructor(terrain, physics) {
        this.terrain = terrain;
        this.physics = physics;
        this.rocks = [];
        this.activeRocks = [];
        this.finishedRocks = [];
        this.isRunning = false;
        this.isPaused = false;
        this.totalRocks = 100;
        this.simulatedCount = 0;
        this.animationSpeed = 50;
        this._maxStepsPerRock = 5000;
        this._maxStepsExplicit = false;
        this.maxDuration = 30;
        this.ignoreResting = false;
        this.downhillMode = 'auto';
        this.onUpdate = null;
        this.onComplete = null;
        // Frame recording for timeline playback (throttled)
        this.frames = [];
        this._frameCounter = 0;
        this.frameRecordInterval = 5; // Record every Nth step to limit memory
        this.maxFrames = 5000; // Hard cap to prevent OOM
        // Barriers (line segments for containment structures)
        this.barriers = [];
    }

    get maxStepsPerRock() {
        return this._maxStepsPerRock;
    }

    set maxStepsPerRock(value) {
        this._maxStepsPerRock = value;
        this._maxStepsExplicit = true;
    }

    configure(params) {
        this.totalRocks = effectiveNumber(params.numRocks, 100, false, true);
        this.animationSpeed = effectiveNumber(params.animationSpeed, 50, false, false);
        this.physics.gravity = effectiveNumber(params.gravity, 9.81, false, false);
        this.physics.dt = effectiveNumber(params.timeStep, 0.005, false, false);
        this.physics.cn = effectiveNumber(params.cn, 0.6, true, false);
        this.physics.ct = effectiveNumber(params.ct, 0.4, true, false);
        this.physics.rollingFriction = effectiveNumber(params.rollingFriction, 0.15, true, false);
        this.physics.cnVariability = effectiveNumber(params.cnVariability, 10, true, false);
        this.physics.ctVariability = effectiveNumber(params.ctVariability, 10, true, false);
        this.maxDuration = effectiveNumber(params.maxDuration, 30, false, false);
        this._maxStepsPerRock = Math.ceil(this.maxDuration / this.physics.dt);
        this._maxStepsExplicit = false;
        this.ignoreResting = !!params.ignoreResting;
        this.downhillMode = params.downhillMode === '+x' || params.downhillMode === '-x' ? params.downhillMode : 'auto';

        // Sync fragmentation properties
        this.physics.fragmentationEnabled = typeof params.fragmentationEnabled === 'boolean' ? params.fragmentationEnabled : true;
        this.physics.fractureEnergy = effectiveNumber(params.fractureEnergy, 25000, false, false);
        this.physics.fractureDissipation = effectiveNumber(params.fractureDissipation, 0.4, true, false);
    }

    start(releaseX, releaseY, diameter, density, initialVelocity, angle, maxDuration, ignoreResting, shapeType, aspectRatio, releaseMode, multiReleasePoints) {
        this.rocks = [];
        this.activeRocks = [];
        this.finishedRocks = [];
        this.simulatedCount = 0;
        this.isRunning = true;
        this.isPaused = false;
        this.maxDuration = effectiveNumber(maxDuration, this.maxDuration, false, false);
        // Only assignments after configure are independent consumer overrides.
        if (!this._maxStepsExplicit) {
            this._maxStepsPerRock = Math.ceil(this.maxDuration / this.physics.dt);
        }
        this.ignoreResting = !!ignoreResting;
        this.frames = [];

        const isDetachment = releaseMode === 'detachment';

        // Build list of release origins
        let origins;
        if (multiReleasePoints && multiReleasePoints.length > 0) {
            origins = multiReleasePoints;
        } else {
            origins = [{ x: releaseX, y: releaseY, velocity: initialVelocity, angle: angle }];
        }

        // Distribute rocks evenly across origins
        const perOrigin = Math.ceil(this.totalRocks / origins.length);
        let rocksCreated = 0;

        for (let oi = 0; oi < origins.length; oi++) {
            const origin = origins[oi];
            let downhillSign = this.downhillMode === '+x' ? 1 : this.downhillMode === '-x' ? -1 : null;
            if (this.downhillMode === 'auto') {
                const bounds = this.terrain.getBounds();
                const clamp = x => bounds ? Math.max(bounds.minX, Math.min(bounds.maxX, x)) : x;
                const delta = this.terrain.getHeightAt(clamp(origin.x - 10)) - this.terrain.getHeightAt(clamp(origin.x + 10));
                downhillSign = delta >= 0.5 ? 1 : delta <= -0.5 ? -1 : null;
            }
            const count = Math.min(perOrigin, this.totalRocks - rocksCreated);
            const originVel = origin.velocity !== undefined ? origin.velocity : initialVelocity;
            const originAng = origin.angle !== undefined ? origin.angle : angle;

            for (let i = 0; i < count; i++) {
                const jitterX = (Math.random() - 0.5) * diameter;
                const jitterY = isDetachment ? 0 : (Math.random() - 0.5) * diameter * 0.5;
                let rx = origin.x + jitterX;
                let ry = origin.y + jitterY;

                // Ensure rock starts above terrain to prevent embedding
                const terrainY = this.terrain.getHeightAt(rx);
                const minSafeY = terrainY + diameter * 0.55 + 0.05;
                if (ry < minSafeY) {
                    ry = minSafeY;
                }

                const rock = this.physics.createRock(
                    rx,
                    ry,
                    diameter,
                    density,
                    originVel,
                    originAng,
                    shapeType,
                    aspectRatio
                );
                rock.sourceIndex = oi;
                rock.downhillSign = downhillSign;
                rock.maxDownhillAdvance = downhillSign === null ? null : 0;
                rock.stepsTaken = 0;
                rock.elapsedTime = 0;
                rock.ignoreResting = this.ignoreResting;
                this.rocks.push(rock);
            }
            rocksCreated += count;
        }

        this.activeRocks = [...this.rocks];
        this.recordFrame();
    }

    step() {
        if (!this.isRunning || this.isPaused) return;

        const stepsPerRock = this.animationSpeed;

        let writeIdx = 0;
        const allNewChildren = [];

        for (let i = 0; i < this.activeRocks.length; i++) {
            const rock = this.activeRocks[i];
            let rockChildren = null;

            for (let s = 0; s < stepsPerRock; s++) {
                const spawned = this.physics.simulateStep(rock, this.terrain, this.physics.dt, this.barriers);
                if (spawned) {
                    rockChildren = rockChildren || [];
                    rockChildren.push(...spawned);
                }
                if (rock.isResting) break;
                // Fixed absolute margin required by the duration contract.
                if (this.maxDuration - rock.elapsedTime <= 1e-9) {
                    rock.finish('maxTime');
                    break;
                }
                if (rock.stepsTaken >= this.maxStepsPerRock) {
                    rock.finish('maxSteps');
                    break;
                }
            }

            if (rock.isResting) {
                this.finishedRocks.push(rock);
                this.simulatedCount++;
                if (rockChildren && rockChildren.length > 0) {
                    allNewChildren.push(...rockChildren);
                }
            } else {
                this.activeRocks[writeIdx++] = rock;
            }
        }

        this.activeRocks.length = writeIdx;

        // Push new child rocks to activeRocks and total list
        if (allNewChildren.length > 0) {
            for (const child of allNewChildren) {
                this.activeRocks.push(child);
                this.rocks.push(child);
            }
        }

        this.recordFrame();

        if (this.onUpdate) {
            this.onUpdate({
                activeRocks: this.activeRocks,
                finishedRocks: this.finishedRocks,
                progress: this.simulatedCount / this.totalRocks
            });
        }

        if (this.activeRocks.length === 0) {
            this.isRunning = false;
            if (this.onComplete) {
                this.onComplete(this.rocks);
            }
        }
    }

    /**
     * Records a lightweight snapshot of all rock positions for timeline playback.
     * Throttled to every Nth step to limit memory. Capped at maxFrames.
     * Only stores {x, y, rotation, isResting} per rock — shape and color
     * are read from the rock objects during rendering.
     */
    recordFrame() {
        this._frameCounter++;
        if (this._frameCounter % this.frameRecordInterval !== 0) return;
        if (this.frames.length >= this.maxFrames) return;

        const snapshot = new Array(this.rocks.length);
        for (let i = 0; i < this.rocks.length; i++) {
            const r = this.rocks[i];
            snapshot[i] = {
                x: r.x,
                y: r.y,
                rotation: r.rotation,
                isResting: r.isResting,
                isFragmented: r.isFragmented
            };
        }
        this.frames.push(snapshot);
    }

    getFrame(index) {
        if (index < 0 || index >= this.frames.length) return null;
        return this.frames[index];
    }

    get frameCount() {
        return this.frames.length;
    }

    stop(reason = 'cancelled') {
        this.isRunning = false;
        for (const rock of this.activeRocks) {
            if (rock.finish(reason)) this.finishedRocks.push(rock);
        }
        this.activeRocks = [];
        this.simulatedCount = this.finishedRocks.length;
    }

    reset() {
        this.isRunning = false;
        this.isPaused = false;
        this.rocks = [];
        this.activeRocks = [];
        this.finishedRocks = [];
        this.simulatedCount = 0;
        this.frames = [];
    }

    togglePause() {
        this.isPaused = !this.isPaused;
    }

    getResults() {
        return this.rocks.filter(r => r.isResting);
    }
}

SimRocas.Simulation = Simulation;
