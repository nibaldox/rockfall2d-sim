'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// Terrain.getBounds() must report the extrema of the profile, cheaply,
// and must stay consistent when the points change through any mutation path.

// Bounds objects are created inside the vm context (different realm), so
// compare field by field instead of deepStrictEqual against realm-local literals.
function assertBounds(terrain, minX, maxX, minY, maxY, label) {
    const b = terrain.getBounds();
    assert.ok(b, `${label}: expected bounds`);
    assert.strictEqual(b.minX, minX, `${label}: minX`);
    assert.strictEqual(b.maxX, maxX, `${label}: maxX`);
    assert.strictEqual(b.minY, minY, `${label}: minY`);
    assert.strictEqual(b.maxY, maxY, `${label}: maxY`);
}

test('getBounds returns extrema and updates after mutators and direct reassignment', () => {
    const ctx = loadScripts(['js/terrain.js'], { env: 'node' });
    const terrain = new ctx.SimRocas.Terrain();

    assert.strictEqual(terrain.getBounds(), null, 'empty terrain has no bounds');
    terrain.addPoint(0, 200);
    assert.strictEqual(terrain.getBounds(), null, 'a single point has no bounds');

    terrain.addPoint(1000, 100);
    terrain.addPoint(2000, 0);
    assertBounds(terrain, 0, 2000, 0, 200, 'initial profile');

    terrain.addPoint(-100, 300);
    assertBounds(terrain, -100, 2000, 0, 300, 'after addPoint');

    terrain.removePoint(1);
    assertBounds(terrain, -100, 2000, 0, 300, 'after removePoint');

    terrain.clear();
    terrain.addPoint(5, 50);
    terrain.addPoint(6, 60);
    assertBounds(terrain, 5, 6, 50, 60, 'after clear + addPoint');

    // Real callers (js/app.js) reassign terrain.points directly
    terrain.points = [{ x: 10, y: 70 }, { x: 20, y: 80 }];
    assertBounds(terrain, 10, 20, 70, 80, 'after direct points reassignment');
});

test('rock released beyond legacy x=500 keeps moving over a wider terrain', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { env: 'browser', seed: 3 });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.addPoint(0, 200);
    terrain.addPoint(1000, 100);
    terrain.addPoint(2000, 0);

    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = false;
    const rock = engine.createRock(800, 150, 0.5, 2700, 0, 0, 'sphere', 0.6);
    engine.simulateStep(rock, terrain, 0.005, []);
    assert.strictEqual(rock.isResting, false, 'x=800 is inside maxX=2000+50, must not be culled');
});

test('terrain without getBounds keeps the legacy culling bounds', () => {
    const ctx = loadScripts(['js/physics.js'], { env: 'browser', seed: 4 });
    const terrain = {
        getHeightAt: () => 0,
        getSurfaceNormalAt: () => ({ nx: 0, ny: 1 }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness: 0 }),
        getSegmentAt: () => ({ properties: { roughness: 0 } })
    };
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = false;
    const rock = engine.createRock(600, 10, 0.5, 2700, 0, 0, 'sphere', 0.6);
    engine.simulateStep(rock, terrain, 0.005, []);
    assert.strictEqual(rock.isResting, true, 'x=600 is beyond legacy maxX=500, must be culled');
});
