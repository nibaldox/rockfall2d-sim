'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function fixture(points, x, expected) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 123 });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(points);
    const bounds = terrain.getBounds();
    assert.ok(bounds.minX <= x - 10 && bounds.maxX >= x + 10, 'fuente y ventana dentro del perfil');
    const delta = terrain.getHeightAt(x - 10) - terrain.getHeightAt(x + 10);
    assert.equal(delta >= 0.5 ? 1 : delta <= -0.5 ? -1 : null, expected, 'pendiente local del fixture');
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    return { terrain, physics, sim };
}
const down = [{ x: 0, y: 100 }, { x: 100, y: 0 }];
const up = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
const flat = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
function start(sim, mode = 'auto', points = null, count = 1) {
    sim.configure({ numRocks: count, animationSpeed: 1, fragmentationEnabled: false, downhillMode: mode });
    sim.start(50, 0, 1, 2700, 0, 0, 30, true, 'sphere', 1, 'freefall', points);
    return sim.rocks;
}

test('origen efectivo posterior al jitter y ajuste de altura', () => {
    const { sim, terrain } = fixture(down, 50, 1);
    const r = start(sim)[0];
    assert.notEqual(r.x, 50, 'jitter efectivo');
    assert.equal(r.y, terrain.getHeightAt(r.x) + 1 * 0.55 + 0.05, 'ajuste efectivo de altura');
    assert.equal(r.releaseX, r.x);
    assert.equal(r.releaseY, r.y);
    assert.equal(r.sourceIndex, 0);
    assert.equal(r.maxDownhillAdvance, 0);
    assert.equal(r.cullBoundary, null);
});

test('dirección automática, reflejada, plana, forzada y desconocida', () => {
    for (const [profile, expected] of [[down, 1], [up, -1], [flat, null]]) {
        for (const [mode, result] of [['auto', expected], ['+x', 1], ['-x', -1], ['desconocido', expected]]) {
            const { sim } = fixture(profile, 50, expected);
            const r = start(sim, mode)[0];
            assert.equal(r.downhillSign, result, `${expected}/${mode}`);
            assert.equal(r.maxDownhillAdvance, result === null ? null : 0);
        }
    }
});

test('auto recorta ventana y reconoce el umbral inclusivo', () => {
    for (const [rise, expected] of [[0.5, 1], [-0.5, -1], [0.49, null]]) {
        const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 123 });
        const terrain = new ctx.SimRocas.Terrain();
        terrain.setPoints([{ x: 0, y: rise }, { x: 10, y: 0 }]);
        assert.deepEqual([terrain.getBounds().minX, terrain.getBounds().maxX], [0, 10]);
        assert.equal(terrain.getHeightAt(0) - terrain.getHeightAt(10), rise);
        const sim = new ctx.SimRocas.Simulation(terrain, new ctx.SimRocas.PhysicsEngine());
        sim.configure({ numRocks: 1, downhillMode: 'auto' });
        sim.start(5, 20, 1, 2700, 0, 0, 30, true, 'sphere', 1, 'freefall', null);
        assert.equal(sim.rocks[0].downhillSign, expected);
    }
});

test('fuentes múltiples resuelven sentidos opuestos', () => {
    const profile = [{ x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 }];
    const f = fixture(profile, 25, 1);
    assert.ok(f.terrain.getHeightAt(65) - f.terrain.getHeightAt(85) <= -0.5);
    const rocks = start(f.sim, 'auto', [{ x: 25, y: 80 }, { x: 75, y: 80 }], 2);
    assert.deepEqual(Array.from(rocks, r => [r.sourceIndex, r.downhillSign]), [[0, 1], [1, -1]]);
});

test('máximo retiene avance después de retroceder en subpasos reales', () => {
    const { sim, physics, terrain } = fixture(down, 50, 1);
    sim.configure({ numRocks: 1, downhillMode: '+x', fragmentationEnabled: false });
    sim.start(50, 200, 1, 2700, 10, 0, 30, true, 'sphere', 1, 'freefall', null);
    const r = sim.rocks[0];
    assert.ok(r.y - r.radius > terrain.getHeightAt(r.x) + 100, 'vuelo libre');
    physics.simulateStep(r, terrain, 0.1, []);
    const peak = r.x;
    r.vx = -10;
    physics.simulateStep(r, terrain, 0.05, []);
    assert.ok(r.x < peak, 'retroceso comprobado');
    r.finish('maxTime');
    assert.ok(r.maxDownhillAdvance > r.finalX - r.releaseX);
    assert.ok(Math.abs(r.maxDownhillAdvance - (peak - r.releaseX)) < 1e-9);
});

test('culling por ambos extremos en perfiles reflejados y precedencia', () => {
    for (const [profile, sign, boundary] of [[down, 1, 'maxX'], [up, -1, 'minX']]) {
        const { sim, physics, terrain } = fixture(profile, 50, sign);
        const r = start(sim)[0];
        const bounds = terrain.getBounds();
        r.x = sign === 1 ? bounds.maxX + 51 : bounds.minX - 51;
        r.y = bounds.minY - 101;
        physics.simulateStep(r, terrain, 0.005, []);
        assert.equal(r.stopReason, 'culled');
        assert.equal(r.cullBoundary, boundary);
    }
});

test('fragmentos y núcleo heredan origen raíz, fuente y signo', () => {
    const { sim, physics } = fixture(down, 50, 1);
    const parent = start(sim)[0];
    Object.assign(parent, { releaseX: parent.x, releaseY: parent.y, sourceIndex: 0, downhillSign: 1, maxDownhillAdvance: 0 });
    parent.x += 7;
    assert.equal(parent.downhillSign, 1, 'fixture: fuente y signo raíz');
    assert.equal(parent.sourceIndex, 0);
    for (const ratio of [2, 5]) {
        const result = physics._fragmentRockProgressive(parent, { nx: 0, ny: 1 }, ratio);
        const all = [...result.children, ...(result.core ? [result.core] : [])];
        assert.ok(all.length > 0, 'fixture genera fragmentos');
        for (const child of all) {
            for (const k of ['releaseX', 'releaseY', 'sourceIndex', 'downhillSign']) assert.equal(child[k], parent[k], k);
            assert.equal(child.maxDownhillAdvance, child.downhillSign * (child.x - child.releaseX));
            assert.equal(child.cullBoundary, null);
        }
    }
});

test('reset y reutilización no heredan sentido ni origen', () => {
    const { sim } = fixture(down, 50, 1);
    const old = start(sim, '-x')[0];
    assert.equal(old.downhillSign, -1);
    sim.reset();
    const current = start(sim, '+x')[0];
    assert.notEqual(current, old);
    assert.equal(current.downhillSign, 1);
    assert.equal(current.releaseX, current.x);
    assert.equal(current.sourceIndex, 0);
    assert.equal(current.maxDownhillAdvance, 0);
    assert.equal(current.cullBoundary, null);
});
