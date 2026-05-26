/**
 * SimRocas 2D — Physics Engine
 *
 * Four calculation methods:
 *   - Rigid Body (Impulse / Energy Ratio) — polygonal collision with torque
 *   - Lumped Mass (2DLM) — point mass with Kn/Kt restitution (GeoRock, CRSP)
 *   - Nonsmooth Dynamics (NSD) — hard contact, Poisson impact, Coulomb friction cone
 *
 * Rolling resistance: simple friction and Davis & McInnes deformation models.
 *
 * References:
 *   - Hungr & Evans (2004) "Rockfall analysis and modelling"
 *   - Corominas (2000) "Use of runout models"
 *   - Davis & McInnes (1991) "Rolling resistance of spheres"
 *   - Savigny (1983) "Rockfall prediction by the angle of reach"
 *   - Lenoir et al. (2009) "Verification of lumped mass rockfall models"
 *   - Leine et al. (2013) "Simulation of rockfall trajectories with consideration of rock shape"
 *   - Moreau (1988) "Numerical analysis of the unilateral contact problem"
 */

const _global = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self);
_global.SimRocas = _global.SimRocas || {};
_global.SimRocas.nextRockId = _global.SimRocas.nextRockId || 1;

class Rock {
    /**
     * @param {number} x - Release X coordinate (m)
     * @param {number} y - Release Y coordinate (m)
     * @param {number} diameter - Rock diameter/length (m)
     * @param {number} density - Rock density (kg/m³)
     * @param {number} initialVelocity - Initial velocity (m/s)
     * @param {number} angle - Release angle (degrees)
     * @param {string} shapeType - Shape model: 'sphere'|'ellipse'|'polygon'|'block'
     * @param {number} aspectRatio - Minor/major axis ratio (0.2-1.0)
     */
    constructor(x, y, diameter, density, initialVelocity = 0, angle = 0, shapeType = 'polygon', aspectRatio = 0.6) {
        this.x = x;
        this.y = y;
        this.vx = initialVelocity * Math.cos(angle * Math.PI / 180);
        this.vy = initialVelocity * Math.sin(angle * Math.PI / 180);
        this.diameter = diameter;
        this.radius = diameter / 2;
        this.density = density;
        this.shapeType = shapeType;
        this.aspectRatio = aspectRatio;

        // Generate shape FIRST — needed for area/mass/inertia computations
        this.shape = this.generateShape(shapeType, aspectRatio);

        // Mass: sphere volume vs polygon area × thickness
        if (shapeType === 'sphere') {
            this.mass = density * (4 / 3) * Math.PI * Math.pow(this.radius, 3);
        } else {
            const area = this.computePolygonArea();
            const thickness = this.radius * 0.5;
            this.mass = density * area * thickness;
        }

        this.momentOfInertia = this.computeMomentOfInertia();

        this.rotation = Math.random() * Math.PI * 2;
        this.angularVelocity = (Math.random() - 0.5) * 2;

        this.bounces = 0;
        this.maxBounceHeight = 0;
        this.maxKineticEnergy = 0;
        this.maxImpactVelocity = 0;
        this.trajectory = [];
        this._trajStepCounter = 0;
        this._maxTrajectoryPoints = 500;
        this.bouncePoints = [];
        this.impactEnergies = [];
        this.finalX = x;
        this.finalY = y;
        this.isResting = false;
        this.restThreshold = 0.08;
        this._restCheckCount = 0;
        this.ignoreResting = false;
        this.elapsedTime = 0;
        this.totalEnergyDissipated = 0;
        this.stepsTaken = 0;

        // Vertex cache — invalidated when position/rotation changes
        this._cachedVertices = null;
        this._verticesDirty = true;

        // Pre-computed color strings for rendering (avoid template literals per frame)
        this.color = this.generateColor();
        const c = this.color;
        this._colorActive = `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, 0.9)`;
        this._colorResting = `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, 0.5)`;
        this._colorStroke = `rgba(${Math.min(255, (c.r | 0) + 40)}, ${Math.min(255, (c.g | 0) + 40)}, ${Math.min(255, (c.b | 0) + 40)}, 0.54)`;

        // Fragmentation properties
        this.id = _global.SimRocas.nextRockId++;
        this.generation = 0;
        this.parentId = null;
        this.isFragmented = false;
        this._lastCollision = null;
        this.isCore = false;          // true if this rock is a surviving core
        this.massLossRatio = 0;       // cumulative fraction of mass lost to spalling (0-1)
        this.originalDiameter = diameter; // track original size for erosion display
    }

    /**
     * Shape factory — generates polygon vertices for different rock models.
     * All shapes are represented as vertex arrays for unified collision handling.
     *
     * @param {'sphere'|'ellipse'|'polygon'|'block'} type
     * @param {number} aspectRatio - minor/major axis ratio (0.2-1.0)
     * @returns {{x:number,y:number}[]}
     */
    generateShape(type, aspectRatio) {
        switch (type) {
            case 'sphere':
                return this._generateSphere();
            case 'ellipse':
                return this._generateEllipse(aspectRatio);
            case 'block':
                return this._generateBlock(aspectRatio);
            case 'polygon':
            default:
                return this._generatePolygon();
        }
    }

    /**
     * Sphere: regular polygon with 24 vertices approximating a circle.
     * Classic approach — no angular effects from shape.
     */
    _generateSphere() {
        const n = 24;
        const points = [];
        for (let i = 0; i < n; i++) {
            const theta = (i / n) * Math.PI * 2;
            points.push({ x: Math.cos(theta) * this.radius, y: Math.sin(theta) * this.radius });
        }
        return points;
    }

    /**
     * Ellipse: regular polygon scaled by aspect ratio on Y axis.
     * Models elongated rocks from directional fracture.
     * Based on: Hungr & Evans (2004) — ellipsoidal approximation.
     */
    _generateEllipse(aspectRatio) {
        const n = 16;
        const points = [];
        const rx = this.radius;
        const ry = this.radius * aspectRatio;
        for (let i = 0; i < n; i++) {
            const theta = (i / n) * Math.PI * 2;
            const jitter = 0.92 + Math.random() * 0.16;
            points.push({
                x: Math.cos(theta) * rx * jitter,
                y: Math.sin(theta) * ry * jitter
            });
        }
        return points;
    }

    /**
     * Block: rectangular shape with configurable aspect ratio.
     * Models angular rocks from orthogonal fracture networks (granite, gneiss).
     * Based on: Corominas (2000) — block approximation for jointed rock.
     */
    _generateBlock(aspectRatio) {
        const hw = this.radius;
        const hh = this.radius * aspectRatio;
        const chamfer = Math.min(hw, hh) * 0.15;
        return [
            { x: -hw + chamfer, y: -hh },
            { x: hw - chamfer, y: -hh },
            { x: hw, y: -hh + chamfer },
            { x: hw, y: hh - chamfer },
            { x: hw - chamfer, y: hh },
            { x: -hw + chamfer, y: hh },
            { x: -hw, y: hh - chamfer },
            { x: -hw, y: -hh + chamfer }
        ];
    }

    /**
     * Polygon: irregular convex shape with 5-9 vertices.
     * Default model — good general-purpose approximation.
     */
    _generatePolygon() {
        const vertices = 5 + Math.floor(Math.random() * 5);
        const points = [];
        const angles = [];

        for (let i = 0; i < vertices; i++) {
            angles.push((i / vertices) * Math.PI * 2 + (Math.random() - 0.5) * 0.4);
        }
        angles.sort((a, b) => a - b);

        for (let i = 0; i < vertices; i++) {
            const theta = angles[i];
            const r = this.radius * (0.45 + Math.random() * 0.55);
            points.push({ x: Math.cos(theta) * r, y: Math.sin(theta) * r });
        }

        return points;
    }

    /**
     * Computes polar moment of inertia using the polygonal shape.
     * Formula: I = (rho/24) * sum over edges of (r1^2 + r1.r2 + r2^2)(r1 x r2)
     * @returns {number} Moment of inertia (kg·m²)
     */
    computeMomentOfInertia() {
        const n = this.shape.length;
        let sum = 0;
        const rho = this.mass / this.computePolygonArea();

        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const p1 = this.shape[i];
            const p2 = this.shape[j];
            const cross = p1.x * p2.y - p2.x * p1.y;
            const r1sq = p1.x * p1.x + p1.y * p1.y;
            const r2sq = p2.x * p2.x + p2.y * p2.y;
            const dot = p1.x * p2.x + p1.y * p2.y;
            sum += cross * (r1sq + dot + r2sq);
        }

        return Math.abs(rho * sum / 24);
    }

    /**
     * Computes polygon area using the shoelace formula.
     * @returns {number} Area (m²)
     */
    computePolygonArea() {
        const n = this.shape.length;
        let area = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += this.shape[i].x * this.shape[j].y;
            area -= this.shape[j].x * this.shape[i].y;
        }
        return Math.abs(area) / 2;
    }

    generateColor() {
        const types = [
            { r: 150 + Math.random() * 40, g: 130 + Math.random() * 40, b: 110 + Math.random() * 30 },
            { r: 120 + Math.random() * 50, g: 120 + Math.random() * 50, b: 120 + Math.random() * 50 },
            { r: 140 + Math.random() * 30, g: 120 + Math.random() * 30, b: 100 + Math.random() * 20 },
            { r: 160 + Math.random() * 30, g: 140 + Math.random() * 30, b: 115 + Math.random() * 25 }
        ];
        return types[Math.floor(Math.random() * types.length)];
    }

    /**
     * Returns world-space vertices of the rock shape, rotated by current angle.
     * Results are cached and only recomputed when position/rotation changes.
     * @returns {{x:number,y:number}[]}
     */
    getShapeVertices() {
        if (!this._verticesDirty && this._cachedVertices) {
            return this._cachedVertices;
        }
        const cos = Math.cos(this.rotation);
        const sin = Math.sin(this.rotation);
        const shape = this.shape;
        const len = shape.length;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            const p = shape[i];
            result[i] = {
                x: this.x + p.x * cos - p.y * sin,
                y: this.y + p.x * sin + p.y * cos
            };
        }
        this._cachedVertices = result;
        this._verticesDirty = false;
        return result;
    }

    /**
     * Invalidates vertex cache — call after any position/rotation change.
     */
    invalidateVertexCache() {
        this._verticesDirty = true;
    }

    /**
     * Total kinetic energy (translational + rotational) in Joules.
     * @returns {number}
     */
    get kineticEnergy() {
        const v = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        const keTrans = 0.5 * this.mass * v * v;
        const keRot = 0.5 * this.momentOfInertia * this.angularVelocity * this.angularVelocity;
        return keTrans + keRot;
    }

    /**
     * Potential energy relative to terrain height.
     * @param {number} terrainY - Terrain elevation at rock position
     * @returns {number} Potential energy (J)
     */
    getPotentialEnergy(terrainY) {
        return this.mass * 9.81 * Math.max(0, this.y - terrainY);
    }

    /**
     * Current speed magnitude.
     * @returns {number} Speed (m/s)
     */
    get speed() {
        return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    }

    /**
     * Checks if the rock should be considered resting.
     * Uses slope-aware threshold: lower speeds allowed on flatter slopes.
     * Requires multiple consecutive checks to avoid false resting from single bounces.
     * @param {{nx: number, ny: number}} normal - Surface normal at impact
     * @returns {boolean} true if rock is resting
     */
    _checkResting(normal) {
        this._restCheckCount++;
        if (this._restCheckCount < 3) return false;

        const slope = Math.abs(normal.nx / (normal.ny + 0.001));
        // On flat ground (slope < 0.5), use tight threshold; on steep slopes, allow more
        const slopeFactor = Math.max(0.1, 1 - slope * 2);
        const adjustedThreshold = this.restThreshold * slopeFactor;

        if (this.speed < adjustedThreshold && this.angularVelocity < 0.5 && this.bounces > 2) {
            this.isResting = true;
            this.vx = 0;
            this.vy = 0;
            this.angularVelocity = 0;
            this.finalX = this.x;
            this.finalY = this.y;
            return true;
        }
        return false;
    }

    /**
     * Euler integration step: applies gravity, updates position and rotation.
     * @param {number} dt - Time step (s)
     * @param {number} gravity - Gravitational acceleration (m/s²)
     */
    update(dt, gravity) {
        if (this.isResting) return;

        this.vy -= gravity * dt;
        // Cap velocity to prevent tunneling on steep slopes
        const maxV = 100;
        const v = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (v > maxV) {
            const scale = maxV / v;
            this.vx *= scale;
            this.vy *= scale;
        }
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.rotation += this.angularVelocity * dt;
        this._verticesDirty = true;
        this.stepsTaken++;

        const ke = 0.5 * this.mass * (this.vx * this.vx + this.vy * this.vy)
                 + 0.5 * this.momentOfInertia * this.angularVelocity * this.angularVelocity;
        if (ke > this.maxKineticEnergy) {
            this.maxKineticEnergy = ke;
        }

        if (v > this.maxImpactVelocity) {
            this.maxImpactVelocity = v;
        }

        // Record trajectory using step counter (not modulo on length)
        this._trajStepCounter++;
        if (this._trajStepCounter % 5 === 0) {
            this.trajectory.push(this.x, this.y, v);  // Flat array: x,y,v triplets
        }

        // Downsample when limit reached (no temporary array)
        if (this.trajectory.length > this._maxTrajectoryPoints * 3) {
            let write = 0;
            for (let i = 0; i < this.trajectory.length; i += 6) {
                this.trajectory[write++] = this.trajectory[i];
                this.trajectory[write++] = this.trajectory[i + 1];
                this.trajectory[write++] = this.trajectory[i + 2];
            }
            this.trajectory.length = write;
        }
    }

    /**
     * Handles rock-terrain collision using one of three calculation methods:
     *   - 'rigid-body': polygonal collision with impulse or energy-ratio models
     *   - 'lumped-mass': point mass with Kn/Kt coefficients (GeoRock, CRSP)
     *   - 'nonsmooth': hard contact, Poisson impact law, Coulomb friction cone (NSD)
     *
     * @param {Terrain} terrain
     * @param {number} cn - Coefficient of restitution (normal) — rigid-body / NSD
     * @param {number} ct - Coefficient of friction (tangential) — rigid-body / NSD
     * @param {string} energyModel - 'impulse' or 'energy-ratio' — rigid-body only
     * @param {number} energyRatio - Energy retention ratio (0-1) — rigid-body only
     * @param {string} calcMethod - 'rigid-body', 'lumped-mass', or 'nonsmooth'
     * @param {number} kn - Normal restitution coefficient (Kn) — lumped-mass only
     * @param {number} kt - Tangential restitution coefficient (Kt) — lumped-mass only
     * @returns {boolean} true if rock is still active after collision
     */
    handleCollision(terrain, cn, ct, energyModel, energyRatio, calcMethod, kn, kt) {
        if (this.isResting) return false;

        // Determine impact X for segment lookup
        let impactX;
        if (calcMethod === 'lumped-mass') {
            impactX = this.x;
        } else {
            // For polygonal methods, find the lowest vertex X
            const vertices = this.getShapeVertices();
            let lowestY = Infinity;
            for (const v of vertices) {
                if (v.y < lowestY) {
                    lowestY = v.y;
                    impactX = v.x;
                }
            }
        }

        // Read segment properties at impact point
        const segProps = terrain.getSegmentPropertiesAt(impactX, cn, ct);
        const segCn = segProps.cn;
        const segCt = segProps.ct;

        if (calcMethod === 'lumped-mass') {
            return this._handleLumpedMass(terrain, kn, kt);
        }
        if (calcMethod === 'nonsmooth') {
            return this._handleNonsmooth(terrain, segCn, segCt);
        }

        return this._handleRigidBody(terrain, segCn, segCt, energyModel, energyRatio);
    }

    /**
     * Handles collision with barrier line segments.
     * Each barrier: { x1, y1, x2, y2, cn, ct, height }
     * Uses circle-line segment intersection with the rock radius.
     */
    handleBarrierCollisions(barriers) {
        for (const barrier of barriers) {
            this._checkBarrierCollision(barrier);
            if (this.isResting) break;
        }
    }

    _checkBarrierCollision(barrier) {
        const dx = barrier.x2 - barrier.x1;
        const dy = barrier.y2 - barrier.y1;
        const segLenSq = dx * dx + dy * dy;
        if (segLenSq < 0.0001) return;

        // Project rock center onto barrier segment
        const t = ((this.x - barrier.x1) * dx + (this.y - barrier.y1) * dy) / segLenSq;
        const tc = Math.max(0, Math.min(1, t));

        // Closest point on segment
        const closestX = barrier.x1 + tc * dx;
        const closestY = barrier.y1 + tc * dy;

        const distX = this.x - closestX;
        const distY = this.y - closestY;
        const distSq = distX * distX + distY * distY;
        const collisionDist = this.radius + (barrier.thickness || 0.15);

        if (distSq >= collisionDist * collisionDist) return;

        const dist = Math.sqrt(distSq);
        if (dist < 0.001) return;

        // Normal from barrier to rock
        const nx = distX / dist;
        const ny = distY / dist;

        // Velocity along normal
        const vn = this.vx * nx + this.vy * ny;
        if (vn >= 0) return; // Moving away

        const barrierCn = barrier.cn !== undefined ? barrier.cn : 0.3;
        const barrierCt = barrier.ct !== undefined ? barrier.ct : 0.5;

        // Decompose velocity
        const vtX = this.vx - vn * nx;
        const vtY = this.vy - vn * ny;

        // Apply restitution
        this.vx = -barrierCn * vn * nx + barrierCt * vtX;
        this.vy = -barrierCn * vn * ny + barrierCt * vtY;

        // Push rock out of barrier
        const penetration = collisionDist - dist;
        this.x += nx * (penetration + 0.01);
        this.y += ny * (penetration + 0.01);
        this._verticesDirty = true;

        this.bounces++;
        const keBefore = 0.5 * this.mass * (vn * vn);
        this.impactEnergies.push(keBefore / 1000);

        // Save for fragmentation check
        this._lastCollision = { normal: { nx: nx, ny: ny }, vn: vn };
    }

    /**
     * Lumped Mass (2DLM) collision — rock is a point mass.
     * No shape, no rotation, no moment of inertia effects.
     * Velocity decomposed into normal/tangential at impact;
     * normal reversed and scaled by Kn, tangential scaled by Kt.
     *
     * Used by: GeoRock 2D, CRSP, Pierre2 and similar tools.
     * Reference: Lenoir et al. (2009) "Verification of lumped mass models"
     */
    _handleLumpedMass(terrain, kn, kt) {
        const terrainY = terrain.getHeightAt(this.x);
        const penetration = terrainY - this.y;

        if (penetration <= 0) return false;

        this.bounces++;

        const normal = terrain.getSurfaceNormalAt(this.x);

        // Apply stochastically perturbed normal vector calculation (CRSP-Style)
        let rnx = normal.nx;
        let rny = normal.ny;
        const seg = terrain.getSegmentAt(this.x);
        if (seg && seg.properties && seg.properties.roughness > 0) {
            const roughness = seg.properties.roughness;
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

        if (vn >= 0) return false;

        // Save for fragmentation check
        this._lastCollision = { normal: { nx: rnx, ny: rny }, vn: vn };

        const vxBefore = this.vx;
        const vyBefore = this.vy;
        const keBefore = this.kineticEnergy;

        const vtX = this.vx - vn * rnx;
        const vtY = this.vy - vn * rny;

        this.vx = -kn * vn * rnx + kt * vtX;
        this.vy = -kn * vn * rny + kt * vtY;

        this.y = Math.max(terrainY + 0.01, this.y);
        this._verticesDirty = true;

        // Angular velocity update for lumped-mass:
        // Transfer some tangential velocity to rotation (rolling coupling).
        // The tangential velocity at the contact point drives spin.
        // Tangent direction (perpendicular to normal, in the surface direction)
        const tx = -rny;
        const ty = rnx;
        const vtAfter = this.vx * tx + this.vy * ty;
        // Rolling without slipping: v_tangential = omega * R
        // Blend between current spin and rolling equilibrium
        const rollingOmega = vtAfter / Math.max(this.radius, 0.1);
        // Transfer ratio: higher for rounded rocks, lower for blocky ones
        const transferRatio = 0.4;
        this.angularVelocity = this.angularVelocity * (1 - transferRatio) + rollingOmega * transferRatio;

        const keAfter = this.kineticEnergy;
        this.totalEnergyDissipated += Math.max(0, keBefore - keAfter);
        this.impactEnergies.push(keBefore / 1000);

        const bounceH = this.y - terrainY;
        if (bounceH > this.maxBounceHeight) {
            this.maxBounceHeight = bounceH;
        }

        this.bouncePoints.push({
            x: this.x,
            y: terrainY,
            energy: keBefore / 1000,
            velocity: Math.sqrt(vxBefore * vxBefore + vyBefore * vyBefore)
        });

        if (this.ignoreResting) return true;
        this._restCheckCount = 0;
        if (this._checkResting(normal)) return false;
        return true;
    }

    /**
     * Nonsmooth Dynamics (NSD) collision — hard contact with no compliance.
     * Uses Poisson impact law for normal impulse and Coulomb friction cone
     * for tangential response (stick/slip determination).
     *
     * Key difference from rigid-body impulse: friction impulse is limited
     * by mu * |jn| (Coulomb cone), not by a tangential restitution coefficient.
     * This produces more physically correct stick/slip transitions.
     *
     * Reference: Leine et al. (2013) "Simulation of rockfall trajectories with
     * consideration of rock shape"; Moreau (1988) "Numerical analysis of the
     * unilateral contact problem"
     */
    _handleNonsmooth(terrain, cn, mu) {
        const vertices = this.getShapeVertices();
        let deepestPenetration = 0;
        let contactIndex = -1;

        for (let i = 0; i < vertices.length; i++) {
            const vx = vertices[i].x;
            const vy = vertices[i].y;
            const terrainY = terrain.getHeightAt(vx);
            const penetration = terrainY - vy;

            if (penetration > deepestPenetration) {
                deepestPenetration = penetration;
                contactIndex = i;
            }
        }

        if (deepestPenetration <= 0 || contactIndex < 0) return false;

        this.bounces++;

        const contactVertex = vertices[contactIndex];
        const contactTerrainY = terrain.getHeightAt(contactVertex.x);
        const normal = terrain.getSurfaceNormalAt(contactVertex.x);

        // Apply stochastically perturbed normal vector calculation (CRSP-Style)
        let rnx = normal.nx;
        let rny = normal.ny;
        const seg = terrain.getSegmentAt(contactVertex.x);
        if (seg && seg.properties && seg.properties.roughness > 0) {
            const roughness = seg.properties.roughness;
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

        const rx = contactVertex.x - this.x;
        const ry = contactVertex.y - this.y;

        const vContactX = this.vx - this.angularVelocity * ry;
        const vContactY = this.vy + this.angularVelocity * rx;

        const vDotN = vContactX * rnx + vContactY * rny;
        if (vDotN >= 0) return false;

        // Save for fragmentation check
        this._lastCollision = { normal: { nx: rnx, ny: rny }, vn: vDotN };

        const vxBefore = this.vx;
        const vyBefore = this.vy;
        const keBefore = this.kineticEnergy;

        // Poisson impact law — normal impulse
        const rCrossN = rx * rny - ry * rnx;
        const denom = 1 / this.mass + (rCrossN * rCrossN) / this.momentOfInertia;
        const jn = -(1 + cn) * vDotN / denom;

        this.vx += jn * rnx / this.mass;
        this.vy += jn * rny / this.mass;
        this.angularVelocity += rCrossN * jn / this.momentOfInertia;

        // Coulomb friction cone — tangential impulse
        const tangentX = -rny;
        const tangentY = rnx;
        const newVContactX = this.vx - this.angularVelocity * ry;
        const newVContactY = this.vy + this.angularVelocity * rx;
        const vDotT = newVContactX * tangentX + newVContactY * tangentY;

        const rCrossT = rx * tangentY - ry * tangentX;
        const denomT = 1 / this.mass + (rCrossT * rCrossT) / this.momentOfInertia;
        const jtFree = -vDotT / denomT;

        const jtMax = mu * Math.abs(jn);
        const jt = Math.max(-jtMax, Math.min(jtMax, jtFree));

        this.vx -= jt * tangentX / this.mass;
        this.vy -= jt * tangentY / this.mass;
        this.angularVelocity -= rCrossT * jt / this.momentOfInertia;

        // Clamp position above terrain to prevent tunneling/jitter
        this.y = contactTerrainY + 0.01;
        this._verticesDirty = true;

        const keAfter = this.kineticEnergy;
        this.totalEnergyDissipated += Math.max(0, keBefore - keAfter);
        this.impactEnergies.push(keBefore / 1000);

        const bounceH = this.y - contactTerrainY;
        if (bounceH > this.maxBounceHeight) {
            this.maxBounceHeight = bounceH;
        }

        this.bouncePoints.push({
            x: contactVertex.x,
            y: contactTerrainY,
            energy: keBefore / 1000,
            velocity: Math.sqrt(vxBefore * vxBefore + vyBefore * vyBefore)
        });

        if (this.ignoreResting) return true;
        this._restCheckCount = 0;
        if (this._checkResting(normal)) return false;
        return true;
    }

    /**
     * Rigid Body collision — polygonal collision with two energy models.
     *   - 'impulse': classical impulse-based with restitution coefficients
     *   - 'energy-ratio': fixed energy ratio per bounce (Hungr & Evans 2004)
     */
    _handleRigidBody(terrain, cn, ct, energyModel, energyRatio) {
        const vertices = this.getShapeVertices();
        let deepestPenetration = 0;
        let contactIndex = -1;

        for (let i = 0; i < vertices.length; i++) {
            const vx = vertices[i].x;
            const vy = vertices[i].y;
            const terrainY = terrain.getHeightAt(vx);
            const penetration = terrainY - vy;

            if (penetration > deepestPenetration) {
                deepestPenetration = penetration;
                contactIndex = i;
            }
        }

        if (deepestPenetration <= 0 || contactIndex < 0) return false;

        this.bounces++;

        const contactVertex = vertices[contactIndex];
        const contactTerrainY = terrain.getHeightAt(contactVertex.x);
        const normal = terrain.getSurfaceNormalAt(contactVertex.x);

        // Apply stochastically perturbed normal vector calculation (CRSP-Style)
        let rnx = normal.nx;
        let rny = normal.ny;
        const seg = terrain.getSegmentAt(contactVertex.x);
        if (seg && seg.properties && seg.properties.roughness > 0) {
            const roughness = seg.properties.roughness;
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

        const rx = contactVertex.x - this.x;
        const ry = contactVertex.y - this.y;

        const vContactX = this.vx - this.angularVelocity * ry;
        const vContactY = this.vy + this.angularVelocity * rx;

        const vDotN = vContactX * rnx + vContactY * rny;
        if (vDotN >= 0) return false;

        // Save for fragmentation check
        this._lastCollision = { normal: { nx: rnx, ny: rny }, vn: vDotN };

        const vxBefore = this.vx;
        const vyBefore = this.vy;
        const keBefore = this.kineticEnergy;

        if (energyModel === 'energy-ratio') {
            const vn = this.vx * rnx + this.vy * rny;
            const vtX = this.vx - vn * rnx;
            const vtY = this.vy - vn * rny;

            this.vx = vtX + (-vn * Math.sqrt(energyRatio)) * rnx;
            this.vy = vtY + (-vn * Math.sqrt(energyRatio)) * rny;

            const speedFactor = Math.sqrt(energyRatio);
            this.vx = this.vx * speedFactor;
            this.vy = this.vy * speedFactor;
            this.angularVelocity *= speedFactor;
        }
        else {
            const rCrossN = rx * rny - ry * rnx;
            const denom = 1 / this.mass + (rCrossN * rCrossN) / this.momentOfInertia;
            const j = -(1 + cn) * vDotN / denom;

            this.vx += j * rnx / this.mass;
            this.vy += j * rny / this.mass;
            this.angularVelocity += rCrossN * j / this.momentOfInertia;

            const tangentX = -rny;
            const tangentY = rnx;
            const newVContactX = this.vx - this.angularVelocity * ry;
            const newVContactY = this.vy + this.angularVelocity * rx;
            const vDotT = newVContactX * tangentX + newVContactY * tangentY;

            const rCrossT = rx * tangentY - ry * tangentX;
            const denomT = 1 / this.mass + (rCrossT * rCrossT) / this.momentOfInertia;
            const jt = (1 - ct) * vDotT / denomT;

            this.vx -= jt * tangentX / this.mass;
            this.vy -= jt * tangentY / this.mass;
            this.angularVelocity -= rCrossT * jt / this.momentOfInertia;
        }

        // Clamp position above terrain to prevent tunneling/jitter
        this.y = contactTerrainY + 0.01;
        this._verticesDirty = true;

        const keAfter = this.kineticEnergy;
        this.totalEnergyDissipated += Math.max(0, keBefore - keAfter);
        this.impactEnergies.push(keBefore / 1000);

        const bounceH = this.y - contactTerrainY;
        if (bounceH > this.maxBounceHeight) {
            this.maxBounceHeight = bounceH;
        }

        this.bouncePoints.push({
            x: contactVertex.x,
            y: contactTerrainY,
            energy: keBefore / 1000,
            velocity: Math.sqrt(vxBefore * vxBefore + vyBefore * vyBefore)
        });

        if (this.ignoreResting) return true;
        this._restCheckCount = 0;
        if (this._checkResting(normal)) return false;
        return true;
    }

    /**
     * Applies rolling friction when rock is in contact with terrain.
     * Supports two models:
     *   - 'simple': constant deceleration proportional to friction coefficient
     *   - 'davis-mcinnnes': resistance from soil deformation (Davis & McInnes 1991)
     *
     * For lumped-mass method, angular velocity is not affected (point mass has no rotation).
     *
     * @param {Terrain} terrain
     * @param {number} rollingFriction - Friction coefficient (simple model)
     * @param {number} dt - Time step (s)
     * @param {string} rollingModel - 'simple' or 'davis-mcinnnes'
     * @param {number} deformationCoef - Soil deformation coefficient (Davis & McInnes)
     * @param {string} calcMethod - 'rigid-body', 'lumped-mass', or 'nonsmooth'
     */
    applyRollingFriction(terrain, rollingFriction, dt, rollingModel, deformationCoef, calcMethod) {
        if (this.isResting) return;

        let onGround = false;

        if (calcMethod === 'lumped-mass') {
            const terrainY = terrain.getHeightAt(this.x);
            onGround = this.y >= terrainY - 0.02;
        } else {
            const vertices = this.getShapeVertices();
            for (const v of vertices) {
                const terrainY = terrain.getHeightAt(v.x);
                if (v.y >= terrainY - 0.02) {
                    onGround = true;
                    break;
                }
            }
        }

        if (!onGround) return;

        const isLumped = calcMethod === 'lumped-mass';

        if (rollingModel === 'davis-mcinnnes') {
            const normalForce = this.mass * 9.81;
            const rollingMoment = deformationCoef * normalForce * this.radius;

            const angularDecel = rollingMoment / this.momentOfInertia;
            this.angularVelocity *= Math.max(0, 1 - angularDecel * dt);

            const translationalDecel = deformationCoef * 9.81;
            const spd = this.speed;
            if (spd > 0) {
                const factor = Math.max(0, 1 - (translationalDecel / spd) * dt);
                this.vx *= factor;
                this.vy *= factor;
            }
        } else {
            const decel = rollingFriction * 9.81;
            const spd = this.speed;
            if (spd > 0) {
                const factor = Math.max(0, 1 - (decel / spd) * dt);
                this.vx *= factor;
                this.vy *= factor;
            }
            // Rolling friction decelerates angular velocity for all methods
            this.angularVelocity *= (1 - rollingFriction * dt * 2);

            // For lumped-mass: couple tangential velocity to rolling angular velocity
            // This creates natural rolling behavior: rock spins at v_tangential / R
            if (isLumped) {
                const terrainNormal = terrain.getSurfaceNormalAt(this.x);
                const tx = -terrainNormal.ny;
                const ty = terrainNormal.nx;
                const vt = this.vx * tx + this.vy * ty;
                const rollingOmega = vt / Math.max(this.radius, 0.1);
                // Gentle coupling — blend toward rolling equilibrium
                const coupling = 0.1;
                this.angularVelocity = this.angularVelocity * (1 - coupling) + rollingOmega * coupling;
            }
        }
    }
}

class PhysicsEngine {
    constructor() {
        this.gravity = 9.81;
        this.dt = 0.005;
        this.cn = 0.6;
        this.ct = 0.4;
        this.rollingFriction = 0.15;
        this.cnVariability = 10;
        this.ctVariability = 10;
        // Calculation method
        this.calcMethod = 'rigid-body';
        // Lumped mass coefficients (typical values for soil/rock mix)
        this.kn = 0.35;
        this.kt = 0.75;
        // Energy dissipation model (rigid-body only)
        this.energyModel = 'impulse';
        this.energyRatio = 0.7;
        // Rolling resistance model
        this.rollingModel = 'simple';
        this.deformationCoef = 0.01;
        // Parameter correlation
        this.correlatedParams = false;

        // Fragmentation properties
        this.fragmentationEnabled = true;
        this.fractureEnergy = 25000;
        this.fractureDissipation = 0.4;
    }

    /**
     * Applies random variation to a base coefficient.
     * When correlatedParams is true, Cn and Ct are inversely correlated:
     * hard rock surfaces have high Cn (elastic) and low Ct (slippery).
     *
     * @param {number} base - Base coefficient value
     * @param {number} variability - Variability percentage (0-50)
     * @param {string} paramType - 'cn' or 'ct' for correlation
     * @returns {number} Varied coefficient
     */
    randomVariation(base, variability, paramType) {
        const variation = variability / 100;
        let factor;

        if (this.correlatedParams && paramType) {
            // Generate a shared random factor for correlation
            // Hard surface: high restitution, low friction
            const shared = (Math.random() * 2 - 1); // -1 to 1
            if (paramType === 'cn') {
                factor = 1 + shared * variation;
            } else {
                factor = 1 - shared * variation; // Inverse correlation
            }
        } else {
            factor = 1 + (Math.random() * 2 - 1) * variation;
        }

        return Math.max(0, Math.min(1, base * factor));
    }

    /**
     * Simulates one time step for a rock, with sub-stepping for stability.
     * @param {Rock} rock
     * @param {Terrain} terrain
     * @param {number} dt - Time step (s)
     */
    simulateStep(rock, terrain, dt, barriers) {
        const subSteps = 3;
        const subDt = dt / subSteps;
        let spawnedChildren = null;

        const cn = this.randomVariation(this.cn, this.cnVariability, 'cn');
        const ct = this.randomVariation(this.ct, this.ctVariability, 'ct');
        const kn = this.randomVariation(this.kn, this.cnVariability, 'cn');
        const kt = this.randomVariation(this.kt, this.ctVariability, 'ct');

        for (let i = 0; i < subSteps; i++) {
            // Reset collision tracking at each sub-step
            rock._lastCollision = null;

            rock.update(subDt, this.gravity);
            rock.handleCollision(terrain, cn, ct, this.energyModel, this.energyRatio, this.calcMethod, kn, kt);

            // Barrier collision (independent of terrain)
            if (!rock.isResting && barriers && barriers.length > 0) {
                rock.handleBarrierCollisions(barriers);
            }

            // Check for fragmentation after collision
            if (this.fragmentationEnabled && rock._lastCollision) {
                const { normal, vn } = rock._lastCollision;
                const impactEnergy = 0.5 * rock.mass * vn * vn;
                const minDiameter = 0.10;

                if (impactEnergy > this.fractureEnergy && rock.generation < 3 && rock.diameter > minDiameter) {
                    // Determine fragmentation mode based on energy ratio
                    const energyRatio = impactEnergy / this.fractureEnergy;
                    const result = this._fragmentRockProgressive(rock, normal, energyRatio);

                    if (result && result.children && result.children.length > 0) {
                        spawnedChildren = spawnedChildren || [];
                        spawnedChildren.push(...result.children);

                        if (result.core) {
                            // Core survives — replace rock properties in-place
                            spawnedChildren.push(result.core);
                            rock.isFragmented = true;
                            rock.isResting = true;
                        } else {
                            // Full breakup — rock is destroyed
                            rock.isFragmented = true;
                            rock.isResting = true;
                        }
                        break;
                    }
                }
            }

            rock.applyRollingFriction(terrain, this.rollingFriction, subDt, this.rollingModel, this.deformationCoef, this.calcMethod);

            if (rock.isResting) break;

            if (rock.x < -50 || rock.x > 500 || rock.y < -100) {
                rock.isResting = true;
                break;
            }
        }

        return spawnedChildren;
    }

    /**
     * Progressive abrasion fragmentation model:
     *
     * Low energy ratio (1-3x threshold): 1-2 small spalls detach from
     * the contact zone. The CORE survives, barely reduced, and continues
     * bouncing — realistic rockfall abrasion behavior.
     *
     * High energy ratio (>3x threshold): core splits in 2 + spalls.
     * The rock is destroyed; two main fragments continue.
     *
     * @param {Rock} rock - The parent rock
     * @param {{ nx: number, ny: number }} normal - Surface normal at impact
     * @param {number} energyRatio - impactEnergy / fractureEnergy (>= 1)
     * @returns {{ children: Rock[], core: Rock|null }}
     */
    _fragmentRockProgressive(rock, normal, energyRatio) {
        const tx = -normal.ny;
        const ty = normal.nx;
        const parentMass = rock.mass;
        const vxParent = rock.vx;
        const vyParent = rock.vy;
        const E_parent = 0.5 * parentMass * (vxParent * vxParent + vyParent * vyParent);

        const children = [];
        let core = null;

        if (energyRatio < 3.0) {
            // ========================================
            // ABRASION MODE: spalls fly off, core survives
            // ========================================
            const numSpalls = energyRatio < 1.5 ? 1 : (Math.random() < 0.6 ? 2 : 3);

            // Each spall takes 5-15% of parent mass
            let totalSpallMass = 0;
            const spallMasses = [];
            for (let i = 0; i < numSpalls; i++) {
                const frac = 0.05 + Math.random() * 0.10;
                const sm = frac * parentMass;
                spallMasses.push(sm);
                totalSpallMass += sm;
            }

            // Clamp: spalls can't exceed 40% total mass
            if (totalSpallMass > 0.40 * parentMass) {
                const scale = (0.40 * parentMass) / totalSpallMass;
                for (let i = 0; i < spallMasses.length; i++) {
                    spallMasses[i] *= scale;
                }
                totalSpallMass = 0.40 * parentMass;
            }

            const coreMass = parentMass - totalSpallMass;

            // Energy budget: spalls get 15-30% of the impact energy
            // (they fly off with moderate velocity)
            const spallEnergyFraction = 0.15 + Math.random() * 0.15;
            const E_spalls = E_parent * spallEnergyFraction * (1 - this.fractureDissipation);
            const E_core = E_parent * (1 - spallEnergyFraction) * (1 - this.fractureDissipation * 0.5);

            // Create spalls — ejected from the contact zone
            for (let i = 0; i < numSpalls; i++) {
                const sm = spallMasses[i];
                const childArea = sm / rock.density;
                const childRadius = Math.sqrt(childArea / Math.PI);
                const childDiameter = childRadius * 2;

                if (childDiameter < 0.05) continue; // skip dust-sized fragments

                // Spalls fly off at ±20-45° from the impact normal
                const ejectAngle = ((Math.random() * 2 - 1) * (20 + Math.random() * 25)) * Math.PI / 180;
                const cosE = Math.cos(ejectAngle);
                const sinE = Math.sin(ejectAngle);
                // Rotate normal by ejectAngle
                const ejNx = normal.nx * cosE - normal.ny * sinE;
                const ejNy = normal.nx * sinE + normal.ny * cosE;

                // Spall velocity: proportional to sqrt(E_spalls / totalSpallMass)
                const spallSpeed = Math.sqrt(2 * E_spalls / totalSpallMass);
                // Add tangential component from parent motion
                const parentVt = vxParent * tx + vyParent * ty;

                // Position: offset along surface tangent from impact point
                const offsetFactor = (i - (numSpalls - 1) / 2) * childDiameter * 1.2;

                const spall = this.createRock(
                    rock.x + tx * offsetFactor + ejNx * childRadius,
                    rock.y + ty * offsetFactor + ejNy * childRadius,
                    childDiameter, rock.density, 0, 0, rock.shapeType, rock.aspectRatio
                );

                spall.vx = ejNx * spallSpeed * (0.7 + Math.random() * 0.6) + tx * parentVt * 0.3;
                spall.vy = ejNy * spallSpeed * (0.7 + Math.random() * 0.6) + ty * parentVt * 0.3;
                spall.angularVelocity = (Math.random() - 0.5) * 10; // fast spin for debris
                spall.mass = sm;
                spall.momentOfInertia = spall.computeMomentOfInertia();
                spall.generation = rock.generation + 1;
                spall.parentId = rock.id;

                children.push(spall);
            }

            // Create surviving core — continues the trajectory
            const coreArea = coreMass / rock.density;
            const coreRadius = Math.sqrt(coreArea / Math.PI);
            const coreDiameter = coreRadius * 2;

            core = this.createRock(
                rock.x, rock.y,
                coreDiameter, rock.density, 0, 0, rock.shapeType, rock.aspectRatio
            );

            // Core keeps most of the parent's velocity (slightly reduced)
            const coreSpeedScale = coreMass > 0 ? Math.sqrt(2 * E_core / coreMass) /
                Math.sqrt(vxParent * vxParent + vyParent * vyParent + 0.001) : 0;
            core.vx = vxParent * Math.min(1.0, coreSpeedScale);
            core.vy = vyParent * Math.min(1.0, coreSpeedScale);
            core.angularVelocity = rock.angularVelocity * (0.9 + Math.random() * 0.2);
            core.mass = coreMass;
            core.momentOfInertia = core.computeMomentOfInertia();
            core.generation = rock.generation; // same generation — it's a surviving core
            core.parentId = rock.parentId;
            core.isCore = true;
            core.massLossRatio = rock.massLossRatio + totalSpallMass / rock.originalDiameter;
            core.originalDiameter = rock.originalDiameter;
            core.id = rock.id; // keep same ID for trajectory continuity

        } else {
            // ========================================
            // CORE SPLIT MODE: high-energy catastrophic failure
            // Core splits in 2 + small spalls
            // ========================================
            const numSpalls = Math.random() < 0.5 ? 1 : 2;
            let totalSpallMass = 0;
            const spallMasses = [];
            for (let i = 0; i < numSpalls; i++) {
                const sm = (0.03 + Math.random() * 0.07) * parentMass;
                spallMasses.push(sm);
                totalSpallMass += sm;
            }

            const remainingMass = parentMass - totalSpallMass;

            // Split remaining mass into two main fragments
            const splitFrac = 0.40 + Math.random() * 0.20;
            const m1 = splitFrac * remainingMass;
            const m2 = remainingMass - m1;

            const E_target = E_parent * (1 - this.fractureDissipation);

            // --- Create spalls ---
            for (let i = 0; i < spallMasses.length; i++) {
                const sm = spallMasses[i];
                const childArea = sm / rock.density;
                const childRadius = Math.sqrt(childArea / Math.PI);
                const childDiameter = childRadius * 2;
                if (childDiameter < 0.05) continue;

                const ejectAngle = ((Math.random() * 2 - 1) * 30) * Math.PI / 180;
                const cosE = Math.cos(ejectAngle);
                const sinE = Math.sin(ejectAngle);
                const ejNx = normal.nx * cosE - normal.ny * sinE;
                const ejNy = normal.nx * sinE + normal.ny * cosE;

                const spallSpeed = Math.sqrt(2 * E_target * 0.15 / (totalSpallMass + 0.001));

                const spall = this.createRock(
                    rock.x + ejNx * rock.radius * 0.5,
                    rock.y + ejNy * rock.radius * 0.5,
                    childDiameter, rock.density, 0, 0, rock.shapeType, rock.aspectRatio
                );

                spall.vx = ejNx * spallSpeed + vxParent * 0.2;
                spall.vy = ejNy * spallSpeed + vyParent * 0.2;
                spall.angularVelocity = (Math.random() - 0.5) * 12;
                spall.mass = sm;
                spall.momentOfInertia = spall.computeMomentOfInertia();
                spall.generation = rock.generation + 1;
                spall.parentId = rock.id;

                children.push(spall);
            }

            // --- Create two main fragments ---
            const mainMasses = [m1, m2];
            const E_main = E_target * 0.85; // 85% goes to main fragments
            let sumKeBase = 0;
            const mainVBase = [];

            for (let i = 0; i < 2; i++) {
                // Diverge ±10-25° from parent velocity direction
                const alpha = ((i === 0 ? -1 : 1) * (10 + Math.random() * 15)) * Math.PI / 180;
                const cosA = Math.cos(alpha);
                const sinA = Math.sin(alpha);
                const vbx = vxParent * cosA - vyParent * sinA;
                const vby = vxParent * sinA + vyParent * cosA;
                mainVBase.push({ vx: vbx, vy: vby });
                sumKeBase += 0.5 * mainMasses[i] * (vbx * vbx + vby * vby);
            }

            const S = (sumKeBase > 0 && E_main > 0) ? Math.sqrt(E_main / sumKeBase) : 1.0;

            for (let i = 0; i < 2; i++) {
                const cm = mainMasses[i];
                const childArea = cm / rock.density;
                const childRadius = Math.sqrt(childArea / Math.PI);
                const childDiameter = childRadius * 2;

                const offsetFactor = (i === 0 ? -1 : 1) * childDiameter * 0.5;

                const child = this.createRock(
                    rock.x + tx * offsetFactor,
                    rock.y + ty * offsetFactor,
                    childDiameter, rock.density, 0, 0, rock.shapeType, rock.aspectRatio
                );

                child.vx = mainVBase[i].vx * S;
                child.vy = mainVBase[i].vy * S;
                child.angularVelocity = rock.angularVelocity * (0.6 + Math.random() * 0.6);
                child.mass = cm;
                child.momentOfInertia = child.computeMomentOfInertia();
                child.generation = rock.generation + 1;
                child.parentId = rock.id;
                child.isCore = true;
                child.originalDiameter = rock.originalDiameter;
                child.massLossRatio = rock.massLossRatio + totalSpallMass / parentMass;

                children.push(child);
            }
        }

        return { children, core };
    }

    /**
     * Legacy fragmentRock method — kept for compatibility with worker.js
     * Delegates to the new progressive model.
     */
    fragmentRock(rock, normal) {
        const result = this._fragmentRockProgressive(rock, normal, 2.0);
        // Return flat array for backward compatibility
        const all = result.children || [];
        if (result.core) all.push(result.core);
        return all;
    }

    /**
     * Factory method to create a new Rock instance.
     * @param {number} releaseX
     * @param {number} releaseY
     * @param {number} diameter
     * @param {number} density
     * @param {number} initialVelocity
     * @param {number} angle
     * @param {string} shapeType
     * @param {number} aspectRatio
     * @returns {Rock}
     */
    createRock(releaseX, releaseY, diameter, density, initialVelocity, angle, shapeType, aspectRatio) {
        return new Rock(releaseX, releaseY, diameter, density, initialVelocity, angle, shapeType, aspectRatio);
    }
}

SimRocas.Rock = Rock;
SimRocas.PhysicsEngine = PhysicsEngine;
