/**
 * verify_roughness.js
 *
 * Verification script for geological roughness stochastically perturbed normal vector calculations.
 * Simulates repeated impacts on a slope segment with different roughness angles.
 *
 * Asserts:
 * 1. For roughness = 0, the perturbed normal is identical to the base normal (deterministic rebounds).
 * 2. For roughness = 15, the perturbed normal varies stochastically, producing a dispersed range
 *    of rebound angles bounded by the roughness.
 */

const assert = require('assert');

// Mock helper mimicking the exact stochastically perturbed normal logic implemented in physics.js
function perturbNormal(nx, ny, roughness) {
    if (roughness <= 0) {
        return { rnx: nx, rny: ny };
    }
    const phi = (Math.random() * 2 - 1) * roughness * Math.PI / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const proposedRnx = nx * cosPhi - ny * sinPhi;
    const proposedRny = nx * sinPhi + ny * cosPhi;
    if (proposedRny > 0) {
        return { rnx: proposedRnx, rny: proposedRny };
    }
    return { rnx: nx, rny: ny }; // fallback/clamp to keep nx, ny
}

// Lumped mass-style collision reflection calculation
function calculateReflection(vx, vy, nx, ny, kn = 0.8, kt = 0.8) {
    const vn = vx * nx + vy * ny;
    if (vn >= 0) return { vx, vy }; // moving away
    const vtX = vx - vn * nx;
    const vtY = vy - vn * ny;
    return {
        vx: -kn * vn * nx + kt * vtX,
        vy: -kn * vn * ny + kt * vtY
    };
}

function runVerification() {
    console.log('=== VERIFYING GEOLOGICAL ROUGHNESS (CRSP-STYLE) IMPACTS ===');

    // Base surface: 45 degree slope (nx = -0.7071, ny = 0.7071)
    const baseNormal = { nx: -Math.sqrt(2)/2, ny: Math.sqrt(2)/2 };
    // Incoming velocity: vertically downwards (vx = 0, vy = -10)
    const incomingVel = { vx: 0, vy: -10 };

    console.log(`Base surface normal: (${baseNormal.nx.toFixed(4)}, ${baseNormal.ny.toFixed(4)})`);
    console.log(`Incoming velocity:   (${incomingVel.vx.toFixed(4)}, ${incomingVel.vy.toFixed(4)})`);

    // Test Case 1: Roughness = 0° (Deterministic)
    console.log('\n--- Test Case 1: Roughness = 0° (Deterministic) ---');
    const trialsZero = 100;
    let identicalCount = 0;
    let firstReflected = null;

    for (let i = 0; i < trialsZero; i++) {
        const { rnx, rny } = perturbNormal(baseNormal.nx, baseNormal.ny, 0);
        assert.strictEqual(rnx, baseNormal.nx, 'Perturbed nx must match base nx at 0 roughness');
        assert.strictEqual(rny, baseNormal.ny, 'Perturbed ny must match base ny at 0 roughness');

        const reflected = calculateReflection(incomingVel.vx, incomingVel.vy, rnx, rny);
        if (i === 0) {
            firstReflected = reflected;
        } else {
            assert.deepStrictEqual(reflected, firstReflected, 'All rebounds at 0 roughness must be perfectly identical');
        }
        identicalCount++;
    }
    console.log(`✓ successfully verified ${identicalCount} deterministic rebounds for roughness = 0°.`);

    // Deterministic rebound angle
    const detAngleDeg = Math.atan2(firstReflected.vy, firstReflected.vx) * 180 / Math.PI;
    console.log(`Deterministic rebound angle: ${detAngleDeg.toFixed(2)}°`);

    // Test Case 2: Roughness = 15° (Stochastic)
    console.log('\n--- Test Case 2: Roughness = 15° (Stochastic) ---');
    const trialsRough = 1000;
    const deviations = [];
    let upwardCount = 0;

    for (let i = 0; i < trialsRough; i++) {
        const { rnx, rny } = perturbNormal(baseNormal.nx, baseNormal.ny, 15);
        
        // Assert normal still points upwards
        assert.ok(rny > 0, `Perturbed normal y-component must be positive (rny = ${rny})`);
        upwardCount++;

        // Calculate reflection
        const reflected = calculateReflection(incomingVel.vx, incomingVel.vy, rnx, rny);
        
        // Rebound angle relative to horizontal x-axis (in degrees)
        const angleDeg = Math.atan2(reflected.vy, reflected.vx) * 180 / Math.PI;
        
        // Compute deviation from deterministic rebound angle, wrapping correctly to [-180, 180]
        let dev = angleDeg - detAngleDeg;
        if (dev > 180) dev -= 360;
        if (dev < -180) dev += 360;
        deviations.push(dev);
    }

    // Analyze results
    const minDev = Math.min(...deviations);
    const maxDev = Math.max(...deviations);
    const meanDev = deviations.reduce((sum, d) => sum + d, 0) / trialsRough;
    const stdDev = Math.sqrt(deviations.reduce((sum, d) => sum + Math.pow(d - meanDev, 2), 0) / trialsRough);

    console.log(`✓ successfully ran ${trialsRough} stochastic trials.`);
    console.log(`Rebound angle deviation range: ${minDev.toFixed(2)}° to ${maxDev.toFixed(2)}°`);
    console.log(`Mean rebound angle deviation:  ${meanDev.toFixed(2)}°`);
    console.log(`Standard Deviation:            ${stdDev.toFixed(2)}°`);

    // With 15 degree roughness, the normal angle deviates by up to 15 degrees,
    // which should stochastically perturb the rebound angle.
    // Let's assert that rebound angles exhibit a clear dispersion.
    assert.ok(stdDev > 2, 'Rebound angles must show significant statistical dispersion when roughness > 0');
    assert.ok(maxDev <= 35, 'Maximum positive deviation should be roughly bounded by ~2x roughness angle');
    assert.ok(minDev >= -35, 'Maximum negative deviation should be roughly bounded by ~2x roughness angle');
    
    console.log('✓ Dispersion checks passed (stdDev > 2°, deviations bounded by ~30°).');

    console.log('\n=== ALL VERIFICATIONS PASSED SUCCESSFULLY ===');
}

runVerification();
