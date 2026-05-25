/**
 * SimRocas 2D — Web Worker for simulation
 *
 * Runs rock physics in a separate thread to avoid blocking the main thread.
 * Receives serialized terrain + rock config, returns finished rock results.
 *
 * Messages IN:
 *   { type: 'start', terrain, rocks, config }
 *   { type: 'stop' }
 *
 * Messages OUT:
 *   { type: 'progress', data: { simulatedCount, totalRocks, progress } }
 *   { type: 'frame', frame: [{ x, y, rotation, isResting }] }
 *   { type: 'complete', rocks: [...] }
 */

// Inline minimal terrain class (no DOM dependency)
class WorkerTerrain {
    constructor(points, segmentMaterials) {
        this.points = points || [];
        this.segmentMaterials = segmentMaterials || [];
    }

    getHeightAt(x) {
        const pts = this.points;
        if (pts.length < 2) return 0;
        for (let i = 0; i < pts.length - 1; i++) {
            if (x >= pts[i].x && x <= pts[i + 1].x) {
                const t = (x - pts[i].x) / (pts[i + 1].x - pts[i].x);
                return pts[i].y + t * (pts[i + 1].y - pts[i].y);
            }
        }
        if (x <= pts[0].x) return pts[0].y;
        return pts[pts.length - 1].y;
    }

    getSurfaceNormalAt(x) {
        const pts = this.points;
        if (pts.length < 2) return { nx: 0, ny: 1 };
        for (let i = 0; i < pts.length - 1; i++) {
            if (x >= pts[i].x && x <= pts[i + 1].x) {
                const dx = pts[i + 1].x - pts[i].x;
                const dy = pts[i + 1].y - pts[i].y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len < 0.0001) return { nx: 0, ny: 1 };
                return { nx: -dy / len, ny: dx / len };
            }
        }
        return { nx: 0, ny: 1 };
    }

    getSegmentPropertiesAt(x, defaultCn, defaultCt) {
        for (let i = 0; i < this.points.length - 1; i++) {
            if (x >= this.points[i].x && x <= this.points[i + 1].x) {
                const mat = this.segmentMaterials[i];
                if (mat) {
                    return {
                        cn: mat.cn !== undefined ? mat.cn : defaultCn,
                        ct: mat.ct !== undefined ? mat.ct : defaultCt,
                        roughness: mat.roughness !== undefined ? mat.roughness : 0
                    };
                }
                break;
            }
        }
        return { cn: defaultCn, ct: defaultCt, roughness: 0 };
    }

    _findSegmentIndex(x) {
        for (let i = 0; i < this.points.length - 1; i++) {
            if (x >= this.points[i].x && x <= this.points[i + 1].x) return i;
        }
        return -1;
    }
}

// Inline minimal rock + physics
class WorkerRock {
    constructor(x, y, diameter, density, initialVelocity, angle, shapeType, aspectRatio) {
        this.x = x;
        this.y = y;
        this.vx = initialVelocity * Math.cos(angle * Math.PI / 180);
        this.vy = initialVelocity * Math.sin(angle * Math.PI / 180);
        this.diameter = diameter;
        this.radius = diameter / 2;
        this.density = density;
        this.shapeType = shapeType;
        this.aspectRatio = aspectRatio;
        this.rotation = Math.random() * Math.PI * 2;
        this.angularVelocity = (Math.random() - 0.5) * 2;
        this.bounces = 0;
        this.maxBounceHeight = 0;
        this.maxKineticEnergy = 0;
        this.maxImpactVelocity = 0;
        this.trajectory = [];
        this.bouncePoints = [];
        this.impactEnergies = [];
        this.finalX = x;
        this.finalY = y;
        this.isResting = false;
        this.restThreshold = 0.08;
        this._restCheckCount = 0;
        this.ignoreResting = false;
        this.totalEnergyDissipated = 0;
        this.stepsTaken = 0;
        this.elapsedTime = 0;
        this.mass = density * Math.PI * this.radius * this.radius * this.radius * 0.5;

        // Generate shape vertices
        this.shape = this._generateShape(shapeType, aspectRatio);

        // Fragmentation properties
        this.id = null;
        this.generation = 0;
        this.parentId = null;
        this.isFragmented = false;
        this._lastCollision = null;
    }

    _generateShape(type, ar) {
        if (type === 'sphere') {
            const pts = [];
            for (let i = 0; i < 16; i++) {
                const a = (i / 16) * Math.PI * 2;
                pts.push({ x: Math.cos(a) * this.radius, y: Math.sin(a) * this.radius });
            }
            return pts;
        }
        const n = 5 + Math.floor(Math.random() * 5);
        const pts = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const r = this.radius * (0.7 + Math.random() * 0.3);
            pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
        }
        return pts;
    }

    update(dt, gravity) {
        this.vy -= gravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.rotation += this.angularVelocity * dt;
    }

    get kineticEnergy() {
        return 0.5 * this.mass * (this.vx * this.vx + this.vy * this.vy);
    }

    get speed() {
        return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    }

    handleCollision(terrain, cn, ct) {
        if (this.isResting) return;

        const terrainY = terrain.getHeightAt(this.x);
        const penetration = terrainY - this.y;

        if (penetration <= 0) return;

        this.bounces++;

        const normal = terrain.getSurfaceNormalAt(this.x);

        // Fetch segment properties including cn, ct and roughness!
        const segProps = terrain.getSegmentPropertiesAt(this.x, cn, ct);
        const segCn = segProps.cn;
        const segCt = segProps.ct;
        const roughness = segProps.roughness || 0;

        // Apply stochastically perturbed normal vector calculation (CRSP-Style)
        let rnx = normal.nx;
        let rny = normal.ny;
        if (roughness > 0) {
            const phi = (Math.random() * 2 - 1) * roughness * Math.PI / 180;
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);
            const proposedRnx = normal.nx * cosPhi - normal.ny * sinPhi;
            const proposedRny = normal.nx * sinPhi + normal.ny * cosPhi;
            if (proposedRny > 0) {
                rnx = proposedRnx;
                rny = proposedRny;
            }
        }

        const vn = this.vx * rnx + this.vy * rny;

        if (vn >= 0) return;

        const keBefore = this.kineticEnergy;
        const impactSpeed = Math.abs(vn);
        if (impactSpeed > this.maxImpactVelocity) this.maxImpactVelocity = impactSpeed;

        const vtX = this.vx - vn * rnx;
        const vtY = this.vy - vn * rny;

        this.vx = -segCn * vn * rnx + segCt * vtX;
        this.vy = -segCn * vn * rny + segCt * vtY;

        this.y = terrainY + 0.01;

        const keAfter = this.kineticEnergy;
        this.totalEnergyDissipated += Math.max(0, keBefore - keAfter);
        if (keBefore > this.maxKineticEnergy) this.maxKineticEnergy = keBefore;
        this.impactEnergies.push(keBefore / 1000);

        // Save for fragmentation check
        this._lastCollision = { normal: { nx: rnx, ny: rny }, vn: vn };

        const bounceH = this.y - terrainY;
        if (bounceH > this.maxBounceHeight) this.maxBounceHeight = bounceH;

        this.bouncePoints.push({ x: this.x, y: this.y });

        // Check resting
        if (this.speed < this.restThreshold && !this.ignoreResting) {
            this._restCheckCount++;
            if (this._restCheckCount > 3 || this.bounces > 2) {
                this.isResting = true;
                this.finalX = this.x;
                this.finalY = this.y;
            }
        } else {
            this._restCheckCount = 0;
        }
    }

    handleBarrierCollisions(barriers) {
        for (const b of barriers) {
            this._checkBarrier(b);
            if (this.isResting) break;
        }
    }

    _checkBarrier(barrier) {
        const dx = barrier.x2 - barrier.x1;
        const dy = barrier.y2 - barrier.y1;
        const segLenSq = dx * dx + dy * dy;
        if (segLenSq < 0.0001) return;

        const t = ((this.x - barrier.x1) * dx + (this.y - barrier.y1) * dy) / segLenSq;
        const tc = Math.max(0, Math.min(1, t));
        const closestX = barrier.x1 + tc * dx;
        const closestY = barrier.y1 + tc * dy;
        const distX = this.x - closestX;
        const distY = this.y - closestY;
        const distSq = distX * distX + distY * distY;
        const collisionDist = this.radius + (barrier.thickness || 0.15);

        if (distSq >= collisionDist * collisionDist) return;

        const dist = Math.sqrt(distSq);
        if (dist < 0.001) return;

        const nx = distX / dist;
        const ny = distY / dist;
        const vn = this.vx * nx + this.vy * ny;
        if (vn >= 0) return;

        const barrierCn = barrier.cn !== undefined ? barrier.cn : 0.3;
        const barrierCt = barrier.ct !== undefined ? barrier.ct : 0.5;

        const vtX = this.vx - vn * nx;
        const vtY = this.vy - vn * ny;

        this.vx = -barrierCn * vn * nx + barrierCt * vtX;
        this.vy = -barrierCn * vn * ny + barrierCt * vtY;

        const penetration = collisionDist - dist;
        this.x += nx * (penetration + 0.01);
        this.y += ny * (penetration + 0.01);
        this.bounces++;

        // Save for fragmentation check
        this._lastCollision = { normal: { nx: nx, ny: ny }, vn: vn };
    }
}

self.onmessage = function(e) {
    const msg = e.data;

    if (msg.type === 'start') {
        runWorkerSimulation(msg);
    } else if (msg.type === 'stop') {
        // Worker will be terminated from outside
    }
};

function runWorkerSimulation(msg) {
    const { terrainData, rockConfigs, config, barriers } = msg;
    const terrain = new WorkerTerrain(terrainData.points, terrainData.segmentMaterials);

    const gravity = config.gravity || 9.81;
    const dt = config.dt || 0.005;
    const cn = config.cn || 0.6;
    const ct = config.ct || 0.4;
    const maxSteps = config.maxStepsPerRock || 5000;
    const maxDuration = config.maxDuration || 30;
    const stepsPerTick = config.animationSpeed || 50;

    const fragmentationEnabled = config.fragmentationEnabled !== undefined ? config.fragmentationEnabled : true;
    const fractureEnergy = config.fractureEnergy !== undefined ? config.fractureEnergy : 25000;
    const fractureDissipation = config.fractureDissipation !== undefined ? config.fractureDissipation : 0.4;

    // Create rocks
    let workerNextRockId = 1;
    const rocks = rockConfigs.map(rc => {
        const r = new WorkerRock(
            rc.x, rc.y, rc.diameter, rc.density, rc.velocity, rc.angle, rc.shapeType, rc.aspectRatio
        );
        r.id = rc.id !== undefined ? rc.id : workerNextRockId++;
        r.generation = rc.generation !== undefined ? rc.generation : 0;
        r.parentId = rc.parentId !== undefined ? rc.parentId : null;
        r.isFragmented = rc.isFragmented !== undefined ? rc.isFragmented : false;
        if (rc.id !== undefined && typeof rc.id === 'number' && rc.id >= workerNextRockId) {
            workerNextRockId = rc.id + 1;
        }
        return r;
    });

    const totalRocks = rocks.length;
    let simulatedCount = 0;
    let frameCounter = 0;

    // Simulate tick by tick, sending progress
    let allDone = false;

    while (!allDone) {
        let activeCount = 0;

        for (let i = 0; i < rocks.length; i++) {
            const rock = rocks[i];
            if (rock.isResting) continue;

            activeCount++;
            let rockChildren = null;

            for (let s = 0; s < stepsPerTick; s++) {
                // Reset collision tracking at each sub-step
                rock._lastCollision = null;

                const subSteps = 3;
                const subDt = dt / subSteps;
                for (let j = 0; j < subSteps; j++) {
                    rock.update(subDt, gravity);
                    rock.handleCollision(terrain, cn, ct);
                    if (!rock.isResting && barriers && barriers.length > 0) {
                        rock.handleBarrierCollisions(barriers);
                    }
                    if (rock.isResting) break;
                }

                rock.stepsTaken++;
                rock.elapsedTime += dt;

                // Check for fragmentation after collision
                if (fragmentationEnabled && rock._lastCollision) {
                    const { normal, vn } = rock._lastCollision;
                    const impactEnergy = 0.5 * rock.mass * vn * vn;
                    if (impactEnergy > fractureEnergy && rock.generation < 2 && rock.diameter > 0.15) {
                        rock.isFragmented = true;
                        rock.isResting = true;
                        rockChildren = workerFragmentRock(rock, normal, fractureDissipation, workerNextRockId);
                        workerNextRockId += rockChildren.length;
                        break;
                    }
                }

                if (rock.isResting) break;
                if (rock.stepsTaken >= maxSteps) { rock.isResting = true; break; }
                if (rock.elapsedTime >= maxDuration) { rock.isResting = true; break; }
                if (rock.x < -50 || rock.x > 500 || rock.y < -100) { rock.isResting = true; break; }
            }

            if (rock.isResting) {
                rock.finalX = rock.x;
                rock.finalY = rock.y;
                simulatedCount++;

                if (rockChildren && rockChildren.length > 0) {
                    for (const child of rockChildren) {
                        rocks.push(child);
                    }
                }
            }
        }

        // Send frame snapshot
        frameCounter++;
        if (frameCounter % 3 === 0) {
            const frame = rocks.map(r => ({
                id: r.id,
                x: r.x,
                y: r.y,
                rotation: r.rotation,
                isResting: r.isResting,
                parentId: r.parentId,
                isFragmented: r.isFragmented
            }));
            self.postMessage({ type: 'frame', frame });
        }

        // Send progress
        self.postMessage({
            type: 'progress',
            data: { simulatedCount, totalRocks, progress: simulatedCount / totalRocks }
        });

        // Loop dynamically adapts to the updated rocks array length!
        allDone = activeCount === 0;
    }

    // Serialize rock results
    const results = rocks.map(r => ({
        id: r.id,
        generation: r.generation,
        parentId: r.parentId,
        isFragmented: r.isFragmented,
        x: r.x, y: r.y,
        vx: r.vx, vy: r.vy,
        diameter: r.diameter,
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
        mass: r.mass,
        shape: r.shape,
        shapeType: r.shapeType
    }));

    self.postMessage({ type: 'complete', rocks: results });
}

function workerFragmentRock(rock, normal, fractureDissipation, startId) {
    const N = Math.random() < 0.5 ? 2 : 3;
    const childMasses = [];
    const parentMass = rock.mass;

    if (N === 2) {
        const f = 0.55 + Math.random() * 0.15;
        const m1 = f * parentMass;
        const m2 = parentMass - m1;
        childMasses.push(m1, m2);
    } else {
        const f1 = 0.50 + Math.random() * 0.15;
        const m1 = f1 * parentMass;
        const remainder = parentMass - m1;
        const f2 = 0.50 + Math.random() * 0.15;
        const m2 = f2 * remainder;
        const m3 = remainder - m2;
        childMasses.push(m1, m2, m3);
    }

    const vxReflected = rock.vx;
    const vyReflected = rock.vy;

    const E_reflected = 0.5 * parentMass * (vxReflected * vxReflected + vyReflected * vyReflected);
    const E_target = E_reflected * (1 - fractureDissipation);

    const childVBase = [];
    let sumKeBase = 0;

    for (let i = 0; i < N; i++) {
        const alpha = (Math.random() * 2 - 1) * 15 * Math.PI / 180;
        const cosAlpha = Math.cos(alpha);
        const sinAlpha = Math.sin(alpha);
        const vbx = vxReflected * cosAlpha - vyReflected * sinAlpha;
        const vby = vxReflected * sinAlpha + vyReflected * cosAlpha;
        childVBase.push({ vx: vbx, vy: vby });

        sumKeBase += 0.5 * childMasses[i] * (vbx * vbx + vby * vby);
    }

    let S = 1.0;
    if (sumKeBase > 0 && E_target > 0) {
        S = Math.sqrt(E_target / sumKeBase);
    }

    const tx = -normal.ny;
    const ty = normal.nx;

    const children = [];
    for (let i = 0; i < N; i++) {
        const childMass = childMasses[i];
        const childArea = childMass / rock.density;
        const childRadius = Math.sqrt(childArea / Math.PI);
        const childDiameter = childRadius * 2;

        const offsetFactor = (i - (N - 1) / 2) * childDiameter * 0.8;
        const cx = rock.x + tx * offsetFactor;
        const cy = rock.y + ty * offsetFactor;

        const child = new WorkerRock(
            cx, cy, childDiameter, rock.density, 0, 0, rock.shapeType, rock.aspectRatio
        );

        child.vx = childVBase[i].vx * S;
        child.vy = childVBase[i].vy * S;
        child.angularVelocity = rock.angularVelocity * (0.8 + Math.random() * 0.4);

        child.mass = childMass;
        child.id = startId + i;
        child.parentId = rock.id;
        child.generation = rock.generation + 1;

        children.push(child);
    }

    return children;
}
