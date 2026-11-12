'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// Fixtures según CONTRATO_P02B §2: maxFlightHeight y maxImpactNormalSpeed son
// número >= 0 o null. El renderer debe omitir los null y contar solo los finitos.
function rock(overrides = {}) {
    return { releaseX: 10, releaseY: 40, finalX: 30, finalY: 20, sourceIndex: 0,
        downhillSign: 1, maxDownhillAdvance: 20, cullBoundary: null, stopReason: 'rest',
        isResting: true, isCore: false, generation: 0, maxKineticEnergy: 1000,
        maxFlightHeight: 2.5, maxImpactNormalSpeed: 3.5, bounces: 3,
        impactCount: 2, impactEvents: [], droppedImpactEvents: 0, ...overrides };
}
function canvas() {
    const calls = [];
    const ctx = new Proxy({ calls, measureText: text => ({ width: String(text).length * 6 }) }, {
        get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); }
    });
    return { width: 600, height: 300, calls, getContext: () => ctx,
        parentElement: { clientWidth: 600, clientHeight: 330, querySelector: () => null } };
}
const texts = c => c.calls.filter(c => c[0] === 'fillText').map(c => String(c[1]));
const arcs = c => c.calls.filter(c => c[0] === 'arc');
function setup() {
    const document = { documentElement: {}, getElementById: () => null };
    const vm = loadScripts(['js/renderer.js'], { extra: {
        SimRocas: {}, document, getComputedStyle: () => ({ getPropertyValue: () => '' })
    } });
    const terrain = { scale: 2, offsetX: 10, offsetY: 0, points: [{ x: 0, y: 40 }, { x: 100, y: 0 }], getHeightAt: () => 0 };
    return { renderer: new vm.SimRocas.Renderer(canvas(), terrain), terrain };
}

test('altura de vuelo: omite null, dibuja solo finitos y muestra N', () => {
    const { renderer, terrain } = setup(); const c = canvas();
    const rocks = [rock({ finalX: 20, maxFlightHeight: 1.5 }),
        rock({ finalX: 40, maxFlightHeight: null, impactCount: 0 }),
        rock({ finalX: 60, maxFlightHeight: 4 }),
        rock({ finalX: 80, maxFlightHeight: null, impactCount: 0 })];
    renderer.renderBounceHeightVsDistance(c, rocks, terrain);
    assert.equal(arcs(c).length, 2);
    assert.ok(texts(c).some(t => /N\s*=\s*2/.test(t)), texts(c).join('|'));
    assert.ok(!texts(c).some(t => /NaN/.test(t)));
});

test('altura de vuelo: etiqueta exacta del eje', () => {
    const { renderer, terrain } = setup(); const c = canvas();
    renderer.renderBounceHeightVsDistance(c, [rock()], terrain);
    assert.ok(texts(c).includes('Altura de vuelo del centro (m)'));
    assert.ok(!texts(c).includes('Altura del centro al contacto (m)'));
});

test('velocidad normal de impacto: omite null, dibuja solo finitos y muestra N', () => {
    const { renderer, terrain } = setup(); const c = canvas();
    const rocks = [rock({ finalX: 20, maxImpactNormalSpeed: 2 }),
        rock({ finalX: 40, maxImpactNormalSpeed: null, impactCount: 0 }),
        rock({ finalX: 60, maxImpactNormalSpeed: 7.25 })];
    renderer.renderImpactVelocityVsDistance(c, rocks, terrain);
    assert.equal(arcs(c).length, 2);
    assert.ok(texts(c).some(t => /N\s*=\s*2/.test(t)), texts(c).join('|'));
    assert.ok(texts(c).includes('Velocidad normal de impacto, máx. (m/s)'));
    assert.ok(!texts(c).includes('Velocidad máx. de trayectoria (m/s)'));
});

test('cero es un valor válido y se dibuja en ambos gráficos', () => {
    const { renderer, terrain } = setup();
    for (const [fn, field] of [['renderBounceHeightVsDistance', 'maxFlightHeight'],
        ['renderImpactVelocityVsDistance', 'maxImpactNormalSpeed']]) {
        const c = canvas();
        const rocks = [rock({ finalX: 20, [field]: 0 }), rock({ finalX: 40, [field]: 3 })];
        renderer[fn](c, rocks, terrain);
        assert.equal(arcs(c).length, 2, `${fn}: el cero debe dibujarse`);
        assert.ok(texts(c).some(t => /N\s*=\s*2/.test(t)));
    }
});

test('todos null: mensaje de sin datos y sin NaN', () => {
    const { renderer, terrain } = setup();
    const rocks = [rock({ maxFlightHeight: null, maxImpactNormalSpeed: null }),
        rock({ maxFlightHeight: null, maxImpactNormalSpeed: null })];
    for (const fn of ['renderBounceHeightVsDistance', 'renderImpactVelocityVsDistance']) {
        const c = canvas();
        renderer[fn](c, rocks, terrain);
        assert.equal(arcs(c).length, 0, `${fn}: no debe dibujar puntos`);
        assert.ok(texts(c).includes('Sin datos'), `${fn}: falta Sin datos`);
        assert.ok(!texts(c).some(t => /NaN/.test(t)));
    }
});

test('sin rocas: mensaje de sin datos', () => {
    const { renderer, terrain } = setup();
    for (const fn of ['renderBounceHeightVsDistance', 'renderImpactVelocityVsDistance']) {
        const c = canvas();
        renderer[fn](c, [], terrain);
        assert.ok(texts(c).includes('Sin datos'));
    }
});
