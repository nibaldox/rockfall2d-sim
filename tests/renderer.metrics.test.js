'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function rock(overrides = {}) {
    return { releaseX: 10, releaseY: 40, finalX: 30, finalY: 20, sourceIndex: 0,
        downhillSign: 1, maxDownhillAdvance: 20, cullBoundary: null, stopReason: 'rest',
        isResting: true, isCore: false, generation: 0, maxKineticEnergy: 1000,
        maxBounceHeight: 2, maxImpactVelocity: 4, maxFlightHeight: 2.5,
        maxImpactNormalSpeed: 3.5, bounces: 3, impactEnergies: [], ...overrides };
}
function canvas() {
    const calls = [];
    const ctx = new Proxy({ calls, measureText: text => ({ width: String(text).length * 6 }) }, {
        get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); }
    });
    return { width: 600, height: 300, calls, getContext: () => ctx,
        parentElement: { clientWidth: 600, clientHeight: 330, querySelector: () => null } };
}
function setup() {
    const ids = ['chart-energy-hist', 'chart-energy-distance', 'chart-accumulation',
        'chart-bounce-distance', 'chart-velocity-distance', 'chart-runout-dist'];
    const charts = Object.fromEntries(ids.map(id => [id, canvas()]));
    const document = { documentElement: {}, getElementById: id => charts[id] };
    const vm = loadScripts(['js/renderer.js', 'js/stats.js'], { extra: {
        SimRocas: {}, document, getComputedStyle: () => ({ getPropertyValue: () => '' })
    } });
    const terrain = { scale: 2, offsetX: 10, offsetY: 0, points: [{ x: 0, y: 40 }, { x: 100, y: 0 }], getHeightAt: () => 0 };
    const main = canvas();
    return { renderer: new vm.SimRocas.Renderer(main, terrain), stats: new vm.SimRocas.Stats(), charts, terrain, main };
}
const texts = c => c.calls.filter(c => c[0] === 'fillText').map(c => String(c[1]));
function fixture(s) {
    const rocks = [rock({ finalX: 10, maxDownhillAdvance: 0, maxKineticEnergy: 0, isResting: false }),
        rock({ finalX: 5, maxDownhillAdvance: 0 }),
        rock({ finalX: 40, stopReason: 'culled', cullBoundary: 'maxX', isResting: true })];
    const r = s.compute(rocks);
    assert.equal(r.status, 'parcial');
    assert.deepEqual(Array.from(r.derived.finalRunout), [0, -5]);
    assert.equal(r.restRocks.length, 2);
    return r;
}
test('histograma de alcance conserva cero y negativo y presenta N', () => {
    const { renderer, stats } = setup(); const r = fixture(stats); const c = canvas();
    renderer.renderHistogram(c, r);
    assert.ok(texts(c).includes('Alcance final relativo (m)'));
    assert.ok(texts(c).some(t => /N\s*=\s*2/.test(t)));
    assert.ok(texts(c).some(t => /-5/.test(t)));
});
test('dashboard usa reposo central para puntos y ejes honestos', () => {
    const { renderer, stats, charts, terrain } = setup(); const r = fixture(stats);
    renderer.renderResultsDashboard(r, terrain);
    for (const id of ['chart-energy-distance', 'chart-bounce-distance', 'chart-velocity-distance']) {
        assert.equal(charts[id].calls.filter(c => c[0] === 'arc').length, r.restRocks.length);
        assert.ok(texts(charts[id]).includes('X final (m)'));
    }
    assert.ok(texts(charts['chart-accumulation']).includes('X final (m)'));
    assert.ok(texts(charts['chart-runout-dist']).includes('Alcance final relativo (m)'));
    assert.ok(texts(charts['chart-energy-hist']).includes('Energía cinética máx. por roca (kJ)'));
    assert.ok(texts(charts['chart-energy-hist']).some(t => /N\s*=\s*2/.test(t)));
    assert.ok(texts(charts['chart-bounce-distance']).includes('Altura de vuelo del centro (m)'));
    assert.ok(texts(charts['chart-velocity-distance']).includes('Velocidad normal de impacto, máx. (m/s)'));
});
test('curva relativa conserva valores negativos y porcentaje sobre N en reposo', () => {
    const { renderer, stats, charts, terrain } = setup();
    renderer.renderResultsDashboard(fixture(stats), terrain);
    const c = charts['chart-runout-dist'];
    assert.ok(texts(c).some(t => /-5/.test(t)));
    assert.ok(texts(c).some(t => /N\s*=\s*2/.test(t)));
});
test('mapa sin datos no dibuja y representa cotas sin sustituir P10 cero', () => {
    const { renderer, main } = setup(); renderer.showProbabilityMap = true;
    renderer.drawProbabilityMap(null); assert.equal(main.calls.length, 0);
    renderer.drawProbabilityMap({ originX: 10, sign: -1, title: 'Alcance máximo', bands: [
        { label: 'P10', value: 0, exact: true }, { label: 'P95', value: 20, exact: false }
    ] });
    assert.ok(texts(main).includes('Alcance máximo'));
    assert.ok(texts(main).some(t => /P10\s*=\s*0(?:\.0)?\s*m/.test(t)));
    assert.ok(texts(main).some(t => /P95\s*≥\s*20(?:\.0)?\s*m/.test(t)));
    const bars = main.calls.filter(c => c[0] === 'fillRect');
    assert.ok(bars.some(c => c[1] === 30 && c[3] === 0));
    assert.ok(bars.some(c => c[1] === 30 && c[3] === -40));
});
test('resultados bloqueados o nulos limpian y muestran Sin datos', () => {
    const { renderer, stats, charts, terrain } = setup();
    for (const result of [stats.compute([]), null]) {
        const c = canvas(); renderer.renderHistogram(c, result); assert.ok(texts(c).includes('Sin datos'));
        for (const chart of Object.values(charts)) chart.calls.length = 0;
        renderer.renderResultsDashboard(result, terrain);
        for (const chart of Object.values(charts)) assert.ok(texts(chart).includes('Sin datos'));
    }
});
test('línea de tiempo conserva posiciones en reposo y excluye censuradas', () => {
    const { renderer, main, stats } = setup();
    const rocks = [rock({ finalX: 20 }), rock({ finalX: 30 }),
        rock({ finalX: 80, stopReason: 'culled', cullBoundary: 'maxX' })];
    assert.equal(stats.compute(rocks).population.rest, 2);
    for (const r of rocks) Object.assign(r, { radius: 1, shape: [], color: { r: 1, g: 1, b: 1 } });
    for (const name of ['clear', 'drawGrid', 'drawAxes', 'drawTerrain', 'drawSegmentHighlight']) renderer[name] = () => {};
    renderer.showRiskZones = true; renderer.showTrajectories = false;
    const frame = rocks.map(r => ({ x: r.finalX, y: 20, rotation: 0, isResting: true }));
    renderer.renderTimelineFrame(0, [frame], rocks);
    const bars = main.calls.filter(c => c[0] === 'fillRect');
    assert.equal(bars.length, 5);
    assert.equal(bars[0][1], 50);
    assert.ok(bars.every(c => c[1] < 100));
});
test('posiciones finales excluyen culled con isResting verdadero', () => {
    const { renderer, main } = setup();
    renderer.drawRestingPositions([rock(), rock({ stopReason: 'culled', cullBoundary: 'maxX', isResting: true })]);
    assert.equal(main.calls.filter(c => c[0] === 'fillRect').length, 0);
});
