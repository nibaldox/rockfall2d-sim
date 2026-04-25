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
        this.maxStepsPerRock = 5000;
        this.maxDuration = 30;
        this.ignoreResting = false;
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

    configure(params) {
        this.totalRocks = params.numRocks || 100;
        this.animationSpeed = params.animationSpeed || 50;
        this.physics.gravity = params.gravity || 9.81;
        this.physics.dt = params.timeStep || 0.005;
        this.physics.cn = params.cn || 0.6;
        this.physics.ct = params.ct || 0.4;
        this.physics.rollingFriction = params.rollingFriction || 0.15;
        this.physics.cnVariability = params.cnVariability || 10;
        this.physics.ctVariability = params.ctVariability || 10;
        this.maxDuration = params.maxDuration || 30;
        this.maxStepsPerRock = Math.ceil(this.maxDuration / this.physics.dt);
        this.ignoreResting = !!params.ignoreResting;
    }

    start(releaseX, releaseY, diameter, density, initialVelocity, angle, maxDuration, ignoreResting, shapeType, aspectRatio, releaseMode, multiReleasePoints) {
        this.rocks = [];
        this.activeRocks = [];
        this.finishedRocks = [];
        this.simulatedCount = 0;
        this.isRunning = true;
        this.isPaused = false;
        this.maxDuration = maxDuration || this.maxDuration;
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

        for (let i = 0; i < this.activeRocks.length; i++) {
            const rock = this.activeRocks[i];

            for (let s = 0; s < stepsPerRock; s++) {
                this.physics.simulateStep(rock, this.terrain, this.physics.dt, this.barriers);
                rock.stepsTaken++;
                rock.elapsedTime += this.physics.dt;

                if (rock.isResting) break;
                if (rock.stepsTaken >= this.maxStepsPerRock) {
                    rock.isResting = true;
                    break;
                }
                if (rock.elapsedTime >= this.maxDuration) {
                    rock.isResting = true;
                    break;
                }
            }

            if (rock.isResting) {
                this.finishedRocks.push(rock);
                this.simulatedCount++;
            } else {
                this.activeRocks[writeIdx++] = rock;
            }
        }

        this.activeRocks.length = writeIdx;

        this.recordFrame();

        if (this.onUpdate) {
            this.onUpdate({
                activeRocks: this.activeRocks,
                finishedRocks: this.finishedRocks,
                progress: this.simulatedCount / this.totalRocks
            });
        }

        if (this.simulatedCount >= this.totalRocks || this.activeRocks.length === 0) {
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
            snapshot[i] = { x: r.x, y: r.y, rotation: r.rotation, isResting: r.isResting };
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

    stop() {
        this.isRunning = false;
        for (const rock of this.activeRocks) {
            rock.isResting = true;
            this.finishedRocks.push(rock);
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

RockFall.Simulation = Simulation;
