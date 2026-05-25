const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log("=== SIMROCAS 2D FRAGMENTATION VERIFICATION SUITE ===");

// 1. Load the production physics engine code in a mock browser environment
const sandbox = {
    console,
    Math,
    global: {},
    self: {},
    SimRocas: {}
};

const physicsPath = path.join(__dirname, '../js/physics.js');
const physicsCode = fs.readFileSync(physicsPath, 'utf8');
vm.runInNewContext(physicsCode, sandbox);

const Rock = sandbox.SimRocas.Rock;
const PhysicsEngine = sandbox.SimRocas.PhysicsEngine;

if (!Rock || !PhysicsEngine) {
    console.error("❌ Failed to load Rock or PhysicsEngine classes!");
    process.exit(1);
}
console.log("✅ Successfully loaded Rock and PhysicsEngine in Node.js sandbox");

// Test Cases
const engine = new PhysicsEngine();
engine.fragmentationEnabled = true;
engine.fractureEnergy = 1000; // Low threshold for testing
engine.fractureDissipation = 0.4; // 40% energy dissipated

// Mock terrain for simple physics. Just returns constant values.
const mockTerrain = {
    getHeightAt: (x) => 0,
    getSurfaceNormalAt: (x) => ({ nx: 0, ny: 1 }),
    getSegmentPropertiesAt: (x, cn, ct) => ({ cn: cn, ct: ct, roughness: 0 }),
    getSegmentAt: (x) => null
};

// Assertion helper
function assert(condition, message) {
    if (!condition) {
        console.error("❌ Assertion Failed: " + message);
        process.exit(1);
    }
    console.log("✅ " + message);
}

// === TEST 1: Rock properties initialization ===
console.log("\n--- Running Test 1: Rock properties initialization ---");
const parentRock = new Rock(0, 10, 0.5, 2700, 0, 0, 'sphere');
assert(parentRock.id !== undefined, "Rock should have a unique ID assigned: " + parentRock.id);
assert(parentRock.generation === 0, "Rock initial generation should be 0");
assert(parentRock.parentId === null, "Rock initial parentId should be null");
assert(parentRock.isFragmented === false, "Rock initial isFragmented should be false");

// === TEST 2: Fragmentation triggers on high energy normal impact ===
console.log("\n--- Running Test 2: Mass and Energy Conservation during fragmentation ---");
// Setup a rock falling down at high speed
const testRock = new Rock(10, 0.05, 0.5, 2700, 50, 270, 'sphere'); // falling down at 50 m/s
// Velocity is vx=0, vy=-50
// Impact vn will be -50 m/s against horizontal terrain normal (0, 1)

// Let's manually trigger collision
const subDt = 0.005 / 3;
// Record pre-collision normal velocity (vn = -50)
const normal = { nx: 0, ny: 1 };
const vn = testRock.vx * normal.nx + testRock.vy * normal.ny;
const impactEnergy = 0.5 * testRock.mass * vn * vn;
console.log(`Pre-impact mass: ${testRock.mass.toFixed(2)} kg, velocity: (${testRock.vx}, ${testRock.vy})`);
console.log(`Impact energy normal: ${impactEnergy.toFixed(2)} J (Umbral: ${engine.fractureEnergy} J)`);

// Apply collision reflection
testRock.handleCollision(mockTerrain, 0.6, 0.4, 'impulse', 0.7, 'lumped-mass', 0.6, 0.4);
console.log(`Post-impact reflected velocity: (${testRock.vx.toFixed(2)}, ${testRock.vy.toFixed(2)})`);

// Verify fragmentation check
const children = engine.fragmentRock(testRock, normal);
assert(children.length === 2 || children.length === 3, "Should spawn 2 or 3 children");

// Verify Mass Conservation
let totalChildMass = 0;
for (const child of children) {
    totalChildMass += child.mass;
    assert(child.parentId === testRock.id, "Child parentId should match parent's ID");
    assert(child.generation === 1, "Child generation should be parent's generation + 1");
}
assert(Math.abs(totalChildMass - testRock.mass) < 0.0001, `Strict mass conservation: Parent mass (${testRock.mass.toFixed(4)}) equals sum of child masses (${totalChildMass.toFixed(4)})`);

// Verify Energy Conservation
const E_reflected = 0.5 * testRock.mass * (testRock.vx * testRock.vx + testRock.vy * testRock.vy);
const E_expected = E_reflected * (1 - engine.fractureDissipation);

let totalChildKe = 0;
for (const child of children) {
    totalChildKe += 0.5 * child.mass * (child.vx * child.vx + child.vy * child.vy);
}
console.log(`Parent reflected Ke: ${E_reflected.toFixed(2)} J`);
console.log(`Target Ke (60% remaining): ${E_expected.toFixed(2)} J`);
console.log(`Actual children sum Ke: ${totalChildKe.toFixed(2)} J`);
assert(Math.abs(totalChildKe - E_expected) < 0.001, "Strict energy conservation: child kinetic energies match target energy");

// === TEST 3: Límite de Generación (Generation Limit) ===
console.log("\n--- Running Test 3: Generation Limit (generation < 2) ---");
const gen2Rock = children[0];
gen2Rock.generation = 2; // NIETO rock
const gen2Collision = { normal: { nx: 0, ny: 1 }, vn: -50 };
// Set collision on gen2Rock
gen2Rock._lastCollision = gen2Collision;

// Try simulating step
const spawnedFromGen2 = engine.simulateStep(gen2Rock, mockTerrain, 0.005, []);
assert(spawnedFromGen2 === null, "Nieto rock (generation 2) should NOT fragment further");

console.log("\n✅ ALL FRACTAL BLOCK FRAGMENTATION TESTS PASSED SUCCESSFULLY! 🚀");
