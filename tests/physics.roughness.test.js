'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// Flat ground at y = 0 whose single segment carries the given roughness (degrees).
function flatTerrain(roughness) {
    return {
        getHeightAt: () => 0,
        getSurfaceNormalAt: () => ({ nx: 0, ny: 1 }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness }),
        getSegmentAt: () => ({ properties: { roughness } })
    };
}

// One lumped-mass impact of a rock falling vertically at 10 m/s, slightly below the ground.
function reboundAngleDeg(ctx, roughness) {
    const rock = new ctx.SimRocas.Rock(0, -0.05, 0.5, 2700, 10, 270, 'sphere');
    rock.ignoreResting = true;
    rock.handleCollision(flatTerrain(roughness), 0.6, 0.4, 'impulse', 0.7, 'lumped-mass', 0.8, 0.8);
    return Math.atan2(rock.vy, rock.vx) * 180 / Math.PI;
}

test('roughness 0: every rebound is identical and vertical', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 1 });
    const angles = Array.from({ length: 100 }, () => reboundAngleDeg(ctx, 0));
    for (const a of angles) {
        assert.ok(Math.abs(a - 90) < 1e-6, `expected 90 deg rebound, got ${a}`);
    }
});

test('roughness 15: rebounds disperse but stay bounded by about twice the roughness', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 2 });
    const devs = Array.from({ length: 1000 }, () => reboundAngleDeg(ctx, 15) - 90);
    const mean = devs.reduce((s, d) => s + d, 0) / devs.length;
    const std = Math.sqrt(devs.reduce((s, d) => s + (d - mean) ** 2, 0) / devs.length);
    assert.ok(std > 2, `expected dispersion, std = ${std}`);
    assert.ok(Math.max(...devs) <= 35 && Math.min(...devs) >= -35, 'deviation must stay within +/-35 deg');
});
