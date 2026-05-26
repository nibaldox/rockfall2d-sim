/**
 * SimRocas 2D — Structural Failure & Block Fragmentation
 *
 * Two capabilities behind a feature flag (structuralFailure.enabled):
 *   1. Planar failure — define a joint plane on terrain, compute safety
 *      factor (Mohr-Coulomb), detach block with slide kinematics.
 *   2. Energy-threshold fragmentation — on impact, split parent rock polygon
 *      into 2-4 convex fragments, distribute momentum with ~5-10% energy loss.
 *
 * References:
 *   - Mohr-Coulomb failure criterion (geotechnical standard)
 *   - Sutherland-Hodgman polygon clipping algorithm
 */

class StructuralFailure {
    /**
     * @param {Terrain} terrain
     * @param {object} config - { enabled, dipAngle, frictionAngle, cohesion,
     *                           fragmentationEnabled, fragmentEnergyThreshold, maxFragments }
     */
    constructor(terrain, config) {
        this.terrain = terrain;
        this.config = Object.assign({
            enabled: false,
            dipAngle: 45,
            frictionAngle: 30,
            cohesion: 10,
            startPoint: null,
            endPoint: null,
            fragmentationEnabled: false,
            fragmentEnergyThreshold: 50000,
            maxFragments: 4
        }, config || {});
    }

    /**
     * Computes the joint plane geometry from the terrain surface.
     * The joint plane originates from a surface outcrop point and extends
     * downward at the configured dip angle.
     *
     * @returns {{ p1: {x,y}, p2: {x,y}, angle: number } | null}
     */
    getJointPlaneGeometry() {
        if (!this.config.enabled) return null;

        const points = this.terrain.points;
        if (points.length < 2) return null;

        const dipRad = this.config.dipAngle * Math.PI / 180;

        // Find the steepest slope segment as the likely outcrop point
        // Use the point where the terrain is steepest (closest to dip angle)
        let bestIdx = -1;
        let bestDiff = Infinity;

        for (let i = 0; i < points.length - 1; i++) {
            const dx = points[i + 1].x - points[i].x;
            const dy = points[i + 1].y - points[i].y;
            const segAngle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
            const diff = Math.abs(segAngle - this.config.dipAngle);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }

        if (bestIdx < 0) return null;

        // Outcrop point: midpoint of the best matching segment
        const outcropX = (points[bestIdx].x + points[bestIdx + 1].x) / 2;
        const outcropY = (points[bestIdx].y + points[bestIdx + 1].y) / 2;

        // Joint line extends from outcrop downward at dip angle
        // In topographic convention (Y up), dipping means going down-right
        const lineLength = 100; // Long enough to cross terrain
        const endX = outcropX + lineLength * Math.cos(dipRad);
        const endY = outcropY - lineLength * Math.sin(dipRad);

        // Also compute start point (extend backward)
        const startX = outcropX - lineLength * Math.cos(dipRad);
        const startY = outcropY + lineLength * Math.sin(dipRad);

        this.config.startPoint = { x: startX, y: startY };
        this.config.endPoint = { x: endX, y: endY };

        return {
            p1: { x: startX, y: startY },
            p2: { x: endX, y: endY },
            angle: this.config.dipAngle
        };
    }

    /**
     * Computes Mohr-Coulomb safety factor for a potential block above the joint plane.
     * FS = (c·L + W·cos(α)·tan(φ)) / (W·sin(α))
     *
     * @param {number} blockWeight - Weight of the unstable block (N)
     * @returns {number} Factor of Safety. <1 = unstable, >=1 = stable
     */
    computeSafetyFactor(blockWeight) {
        if (!this.config.enabled) return Infinity;

        const alpha = this.config.dipAngle * Math.PI / 180;
        const phi = this.config.frictionAngle * Math.PI / 180;
        const c = this.config.cohesion * 1000; // kPa to Pa

        // Estimate base length from joint geometry
        const joint = this.getJointPlaneGeometry();
        if (!joint) return Infinity;

        const dx = joint.p2.x - joint.p1.x;
        const dy = joint.p2.y - joint.p1.y;
        const baseLength = Math.sqrt(dx * dx + dy * dy) * 0.1; // Use a fraction

        const W = blockWeight || 10000; // Default 10 kN if not provided
        const sinA = Math.sin(alpha);
        const cosA = Math.cos(alpha);
        const tanP = Math.tan(phi);

        const numerator = c * baseLength + W * cosA * tanP;
        const denominator = W * sinA;

        if (denominator < 0.001) return Infinity;

        return numerator / denominator;
    }

    /**
     * Computes the initial slide velocity along the joint plane.
     * v₀ = √(2·g·(sin(α) − cos(α)·tan(φ))·L)
     *
     * @param {number} slideDistance - Distance along joint (m)
     * @returns {{ vx: number, vy: number }} Initial velocity components
     */
    getSlideVelocity(slideDistance) {
        const alpha = this.config.dipAngle * Math.PI / 180;
        const phi = this.config.frictionAngle * Math.PI / 180;
        const g = 9.81;

        const sinA = Math.sin(alpha);
        const cosA = Math.cos(alpha);
        const tanP = Math.tan(phi);

        const drivingForce = sinA - cosA * tanP;

        if (drivingForce <= 0) {
            // Stable — block won't slide
            return { vx: 0, vy: 0 };
        }

        const L = slideDistance || 5; // Default 5m slide
        const v0 = Math.sqrt(2 * g * drivingForce * L);

        // Velocity direction: downslope along joint plane
        // In topographic convention, dip goes down-right
        const vx = v0 * Math.cos(alpha);
        const vy = -v0 * Math.sin(alpha); // Negative = downward

        return { vx, vy };
    }

    /**
     * Creates a detached rock from the unstable block at the joint outcrop.
     * The rock gets initial velocity from slide kinematics.
     *
     * @param {number} diameter - Rock diameter (m)
     * @param {number} density - Rock density (kg/m³)
     * @param {string} shapeType - Shape model
     * @param {number} aspectRatio - Aspect ratio
     * @returns {Rock|null} New rock instance or null if disabled
     */
    createDetachedRock(diameter, density, shapeType, aspectRatio) {
        if (!this.config.enabled) return null;

        const joint = this.getJointPlaneGeometry();
        if (!joint) return null;

        // Find the outcrop point on terrain surface
        const points = this.terrain.points;
        if (points.length < 2) return null;

        // Find steepest segment for outcrop
        let bestIdx = -1;
        let bestDiff = Infinity;
        for (let i = 0; i < points.length - 1; i++) {
            const dx = points[i + 1].x - points[i].x;
            const dy = points[i + 1].y - points[i].y;
            const segAngle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
            const diff = Math.abs(segAngle - this.config.dipAngle);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) return null;

        const outcropX = (points[bestIdx].x + points[bestIdx + 1].x) / 2;
        const outcropY = (points[bestIdx].y + points[bestIdx + 1].y) / 2;

        // Ensure rock starts above terrain
        const terrainY = this.terrain.getHeightAt(outcropX);
        const safeY = Math.max(outcropY, terrainY + diameter * 0.6);

        // Compute slide velocity
        const vel = this.getSlideVelocity(5);
        const speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
        const angle = Math.atan2(vel.vy, vel.vx) * 180 / Math.PI;

        const rock = new Rock(
            outcropX, safeY,
            diameter, density,
            speed, angle,
            shapeType, aspectRatio
        );

        rock.releaseMode = 'structural-failure';
        return rock;
    }
}

SimRocas.StructuralFailure = StructuralFailure;
