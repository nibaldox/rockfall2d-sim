'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');

const ROOT = path.join(__dirname, '..');
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0];
const { fixture, rock } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture, rock };')(createRequire(lifecycle), __dirname);

// Fixtures según CONTRATO_P04 §2 (no dependen del motor de WP1).
function primary(id, overrides = {}) {
    return { ...rock('rest'), id, parentId: null, rootId: id, fragmentKind: 'primary',
        bornAt: 0, discardedMass: 0, ...overrides };
}
function child(id, parentId, rootId, fragmentKind, overrides = {}) {
    return { ...rock('rest'), id, parentId, rootId, fragmentKind, bornAt: 1.5, discardedMass: 0,
        isCore: fragmentKind !== 'spall', generation: 1, ...overrides };
}
const fragmented = { stopReason: 'fragmented' };
// Árbol válido de 3 generaciones de descendientes bajo la primaria 1, más la primaria 6.
// E1.3: bornAt = elapsedTime final del padre; core conserva la generación, major y spall suman 1.
function tree() {
    return [
        primary(1, { ...fragmented, discardedMass: 0.25, elapsedTime: 1.5, isCore: false, generation: 0 }),
        child(2, 1, 1, 'core', { ...fragmented, generation: 0, elapsedTime: 2.5 }),
        child(3, 2, 1, 'major', { ...fragmented, bornAt: 2.5, generation: 1, elapsedTime: 3.5 }),
        child(4, 3, 1, 'spall', { bornAt: 3.5, generation: 2, elapsedTime: 4 }),
        child(5, 1, 1, 'spall', { generation: 1, elapsedTime: 4 }),
        primary(6)
    ];
}

function publish(worker, rocks) {
    const f = fixture(worker);
    f.app.runSimulation();
    if (worker) f.workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks } });
    else { f.app.simulation.rocks = rocks; f.app.simulation.onComplete(rocks); }
    return { rocks: f.app.simulation.rocks, valid: f.app._resultsValid,
        status: f.element('simulation-status').textContent, frames: f.app.simulation.frameCount };
}
function assertRejected(rocks, label) {
    for (const worker of [true, false]) {
        const result = publish(worker, rocks());
        const where = `${label} (${worker ? 'worker' : 'normal'})`;
        assert.match(result.status, /incompatible/i, where);
        assert.equal(result.valid, false, where);
    }
}
function assertAccepted(rocks, label) {
    for (const worker of [true, false]) {
        const list = rocks();
        const result = publish(worker, list);
        const where = `${label} (${worker ? 'worker' : 'normal'})`;
        assert.doesNotMatch(result.status, /incompatible/i, where);
        assert.equal(result.valid, true, where);
        assert.equal(result.rocks.length, list.length, where);
    }
}

test('por roca: una primaria válida y un árbol válido de 3 generaciones pasan en ambos caminos', () => {
    assertAccepted(() => [primary(1)], 'primaria');
    assertAccepted(() => [primary(7), primary(9)], 'primarias con id no consecutivos');
    assertAccepted(tree, 'árbol de 3 generaciones');
});

test('por roca: cada campo de linaje inválido se rechaza en ambos caminos', () => {
    const bad = [undefined, null, NaN, Infinity, -1, '0'];
    const cases = {
        id: [undefined, null, 0, -1, 1.5, '1', NaN],
        rootId: [undefined, null, 1.5, '1', NaN],
        fragmentKind: [undefined, null, 'nucleo', '', 1],
        bornAt: bad,
        discardedMass: bad
    };
    for (const [field, values] of Object.entries(cases)) for (const value of values) {
        assertRejected(() => [primary(1, { [field]: value })], `${field}: ${String(value)}`);
    }
    // parentId inválido en una hoja de un árbol por lo demás válido.
    for (const value of [undefined, '3', 3.5, NaN]) {
        assertRejected(() => { const list = tree(); list[3].parentId = value; return list; }, `parentId: ${String(value)}`);
    }
});

test('por roca: coherencia de las primarias entre parentId, rootId y fragmentKind', () => {
    assertRejected(() => [primary(1, { fragmentKind: 'core' })], 'sin padre y no primaria');
    assertRejected(() => { const list = tree(); list[4].fragmentKind = 'primary'; return list; }, 'primaria con padre');
    assertRejected(() => [primary(1), primary(2, { rootId: 1 })], 'primaria con rootId ajeno');
});

test('conjunto: id duplicado, referencias rotas, padre no fragmentado, ciclo y rootId no heredado', () => {
    assertRejected(() => [primary(1), primary(1)], 'id duplicado');
    assertRejected(() => { const list = tree(); list[4].id = 4; return list; }, 'id duplicado en hijos');
    assertRejected(() => { const list = tree(); list[4].parentId = 99; return list; }, 'parentId inexistente');
    assertRejected(() => { const list = tree(); list[2].stopReason = 'rest'; return list; }, 'padre no fragmentado');
    assertRejected(() => [primary(1), child(2, 3, 1, 'core', fragmented), child(3, 2, 1, 'core', fragmented)], 'ciclo');
    assertRejected(() => [primary(1), child(2, 2, 1, 'core', fragmented)], 'ciclo de una roca');
    assertRejected(() => { const list = tree(); list[4].rootId = 6; return list; }, 'rootId distinto del padre');
    assertRejected(() => { const list = tree(); list[3].rootId = 99; return list; }, 'rootId inexistente');
});

test('E1.3 conjunto: fragmented sin hijos se rechaza en ambos caminos', () => {
    assertRejected(() => [primary(1, fragmented)], 'primaria fragmentada sin hijos');
    assertRejected(() => { const list = tree(); list.splice(3, 1); return list; }, 'hijo fragmentado sin hijos');
    assertRejected(() => { const list = tree(); list[5].stopReason = 'fragmented'; return list; }, 'segunda primaria fragmentada sin hijos');
});

test('E1.3 conjunto: bornAt distinto del elapsedTime final del padre (tolerancia 1e-9)', () => {
    assertRejected(() => { const list = tree(); list[4].bornAt = 1.5 + 1e-6; return list; }, 'bornAt posterior');
    assertRejected(() => { const list = tree(); list[4].bornAt = 1.5 - 1e-6; return list; }, 'bornAt anterior');
    assertRejected(() => { const list = tree(); list[3].bornAt = 1e6; return list; }, 'bornAt 1e6');
    assertRejected(() => { const list = tree(); list[0].elapsedTime = 9; return list; }, 'el padre siguió después de nacer el hijo');
    for (const worker of [true, false]) {
        const list = tree(); list[4].bornAt = 1.5 + 5e-10;
        assert.equal(publish(worker, list).rocks.length, list.length, 'dentro de la tolerancia se acepta');
    }
});

test('E1.3 conjunto: fragmentKind incoherente con isCore y generation', () => {
    const mutate = (index, fields) => () => { const list = tree(); Object.assign(list[index], fields); return list; };
    assertRejected(mutate(4, { fragmentKind: 'core' }), 'spall→core sin tocar isCore');
    assertRejected(mutate(4, { fragmentKind: 'major' }), 'spall→major sin tocar isCore');
    assertRejected(mutate(4, { isCore: true }), 'spall con isCore');
    assertRejected(mutate(4, { generation: 0 }), 'spall con la generación del padre');
    assertRejected(mutate(1, { isCore: false }), 'core sin isCore');
    assertRejected(mutate(1, { generation: 1 }), 'core con generación + 1');
    assertRejected(mutate(1, { fragmentKind: 'major' }), 'core→major con la generación del padre');
    assertRejected(mutate(2, { fragmentKind: 'core' }), 'major→core con generación + 1');
    assertRejected(mutate(2, { isCore: false }), 'major sin isCore');
    assertRejected(mutate(2, { generation: 3 }), 'major con salto de generación');
    assertRejected(mutate(3, { generation: undefined }), 'hijo sin generation');
    assertRejected(mutate(3, { isCore: undefined }), 'hijo sin isCore');
    assertRejected(mutate(0, { isCore: true }), 'primaria con isCore');
    assertRejected(mutate(0, { generation: 1 }), 'primaria con generación 1');
});

test('conjunto inválido: la corrida entera se rechaza y no deja rocas ni frames en el modelo', () => {
    for (const worker of [true, false]) {
        const list = tree(); list[4].parentId = 99;
        const result = publish(worker, list);
        assert.equal(result.rocks.length, 0);
        assert.equal(result.frames, 0);
    }
});

// --- Renderer (§4) ---
function canvas() {
    const calls = [];
    const ctx = new Proxy({ calls, measureText: text => ({ width: String(text).length * 6 }) }, {
        get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); }
    });
    return { width: 600, height: 300, calls, getContext: () => ctx,
        parentElement: { clientWidth: 600, clientHeight: 330, querySelector: () => null } };
}
function rendererSetup() {
    const document = { documentElement: {}, getElementById: () => null };
    const vm = loadScripts(['js/renderer.js'], { extra: {
        SimRocas: {}, document, getComputedStyle: () => ({ getPropertyValue: () => '' })
    } });
    const terrain = { scale: 2, offsetX: 10, offsetY: 0, points: [{ x: 0, y: 40 }, { x: 100, y: 0 }], getHeightAt: () => 0,
        worldToCanvas: (x, y) => ({ cx: x * 2 + 10, cy: 300 - y * 2 }) };
    const c = canvas();
    return { renderer: new vm.SimRocas.Renderer(c, terrain), c };
}
const toCanvas = (x, y) => [x * 2 + 10, 300 - y * 2];
// Primaria 1 y tres núcleos sucesivos (2, 3 y 4); cada tramo empieza separado del final del padre.
const segments = {
    1: [[0, 40], [10, 30]],
    2: [[12, 28], [20, 20]],
    3: [[23, 18], [30, 10]],
    4: [[34, 7], [40, 0]]
};
function chain() {
    const flat = id => segments[id].flatMap(([x, y]) => [x, y, 1]);
    const byId = {
        1: primary(1, { ...fragmented, trajectory: flat(1) }),
        2: child(2, 1, 1, 'core', { ...fragmented, trajectory: flat(2) }),
        3: child(3, 2, 1, 'core', { ...fragmented, trajectory: flat(3) }),
        4: child(4, 3, 1, 'core', { trajectory: flat(4) })
    };
    // Orden de lista distinto del orden de id: la unión no puede depender de la posición.
    return [byId[4], byId[1], byId[3], byId[2]];
}
function assertJoins(calls, label) {
    for (const id of [2, 3, 4]) {
        const parentEnd = toCanvas(...segments[id - 1][1]);
        const first = toCanvas(...segments[id][0]);
        const at = calls.findIndex(c => c[0] === 'lineTo' && c[1] === first[0] && c[2] === first[1]);
        assert.ok(at > 0, `${label}: la roca ${id} dibuja su primer punto`);
        assert.deepEqual(calls[at - 1], ['moveTo', ...parentEnd], `${label}: la roca ${id} se une al final de su padre ${id - 1}`);
    }
    const marks = calls.filter(c => c[0] === 'arc' && c[3] === 4).map(c => [c[1], c[2]]);
    const expected = [1, 2, 3].map(id => toCanvas(...segments[id][1]));
    const key = p => p.join(',');
    assert.deepEqual(marks.map(key).sort(), expected.map(key).sort(), `${label}: un marcador de rotura por padre, en su posición`);
}

test('renderer: tres núcleos sucesivos se unen cada uno a su padre y el marcador queda en el padre', () => {
    const { renderer, c } = rendererSetup();
    renderer.drawTrajectories(chain());
    assertJoins(c.calls, 'trayectorias');
});

test('renderer (línea de tiempo): tres núcleos sucesivos se unen a su padre por parentId', () => {
    const { renderer, c } = rendererSetup();
    const rocks = chain();
    // Cada entidad vive 2 frames consecutivos: id 1 en 0-1, id 2 en 2-3, id 3 en 4-5 e id 4 en 6-7.
    const frames = [];
    for (let fi = 0; fi < 8; fi++) {
        frames.push(rocks.map(r => {
            const local = fi - (r.id - 1) * 2;
            if (local < 0 || local > 1) return null;
            const [x, y] = segments[r.id][local];
            return { x, y };
        }));
    }
    renderer.drawTimelineTrajectories(7, frames, rocks);
    assertJoins(c.calls, 'línea de tiempo');
});

// --- Versionado (§5, E1.1) ---
const head = file => execFileSync('git', ['show', `18e4a1c3:${file}`], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 });
const versions = html => Object.fromEntries([...html.matchAll(/(?:src|href)="([^"?]+)\?v=(\d+)"/g)].map(m => [m[1], Number(m[2])]));

test('versionado E1.1: suben solo los ?v= del §5 y WORKER_VERSION pasa de 9 a 10', () => {
    const before = versions(head('index.html'));
    const htmlNow = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const now = versions(htmlNow);
    const rendererChanged = head('js/renderer.js') !== fs.readFileSync(path.join(ROOT, 'js/renderer.js'), 'utf8');
    // P1.1: app 19, app-worker 11, terrain 9, app-stl 3, app-profile3d 3 y el script nuevo bench-profile 1.
    const expected = { ...before, 'js/physics.js': 14, 'js/simulation.js': 13, 'js/app-worker.js': 11, 'js/app.js': 20, 'js/stats.js': 12,
        'js/terrain.js': 9, 'js/app-stl.js': 3, 'js/app-profile3d.js': 3, 'js/bench-profile.js': 2, 'js/bench-retention.js': 1, // P1.2: app 20, stats 12, bench-profile 2 y el script nuevo bench-retention 1
        'js/renderer.js': rendererChanged ? 8 : 7 };
    assert.deepEqual(before['js/physics.js'], 12);
    assert.deepEqual(now, expected);
    // index.html solo cambia en los ?v= y en el bloque nuevo «Piezas finales» (P0.4 parte B).
    const strip = html => html.replace(/\?v=\d+/g, '?v=N');
    const block = /^ {12}<div id="lineage-block" style="display:none;">\n[\s\S]*?\n {12}<\/div>\n/m;
    assert.match(htmlNow, block);
    assert.match(block.exec(htmlNow)[0], /Piezas finales/);
    // P0.5: además se admiten SOLO el bloque del campo «Semilla» y el rótulo corregido de la correlación.
    const seedBlock = /^ {28}<div class="control-group">\n {32}<label [^\n]*>Semilla:<\/label>\n[^\n]*id="sim-seed"[^\n]*\n[^\n]*id="seed-used"[^\n]*\n {28}<\/div>\n/m;
    assert.match(htmlNow, seedBlock);
    const labelNow = 'Correlacionar Cn/Ct (superficie dura: Cn y Ct altos)', labelBase = 'Correlacionar Cn/Ct (roca dura = alto Cn, bajo Ct)';
    assert.equal(htmlNow.split(labelNow).length, 2);
    // P1.1: además se admiten SOLO el grupo «Generar banco–berma» y el <script> de bench-profile.js.
    const benchBlock = /^ {24}<div class="control-group" id="bench-generator">\n[\s\S]*?id="bench-meta-table"[^\n]*\n {24}<\/div>\n/m;
    assert.match(htmlNow, benchBlock);
    const benchScript = '    <script src="js/bench-profile.js?v=2"></script>\n'; // P1.2: 1→2
    assert.equal(htmlNow.split(benchScript).length, 2);
    // P1.2: además se admiten SOLO el grupo «Medir bancos», el bloque «Retención por banco», el botón de destinos y el <script> de bench-retention.js.
    const measureBlock = /^ {24}<div class="control-group" id="bench-measure">\n[\s\S]*?id="btn-bench-measure"[^\n]*\n {24}<\/div>\n/m;
    const retentionBlock = /^ {12}<div id="bench-retention-block" style="display:none;">\n[^\n]*id="bench-retention-title"[^\n]*\n[^\n]*id="bench-retention-table"[^\n]*\n {12}<\/div>\n/m;
    const destinationsButton = /^ {32}<button id="btn-export-destinations"[^\n]*>Exportar destinos \(CSV\)<\/button>\n/m;
    const retentionScript = '    <script src="js/bench-retention.js?v=1"></script>\n';
    for (const admitted of [measureBlock, retentionBlock, destinationsButton]) assert.match(htmlNow, admitted);
    assert.equal(htmlNow.split(retentionScript).length, 2);
    assert.equal(strip(htmlNow.replace(block, '').replace(seedBlock, '').replace(benchBlock, '').replace(benchScript, '').replace(measureBlock, '').replace(retentionBlock, '').replace(destinationsButton, '').replace(retentionScript, '').replace(labelNow, labelBase)), strip(head('index.html')));
    const workerVersion = source => Number(/const WORKER_VERSION = (\d+);/.exec(source)[1]);
    assert.equal(workerVersion(head('js/app-worker.js')), 9);
    assert.equal(workerVersion(fs.readFileSync(path.join(ROOT, 'js/app-worker.js'), 'utf8')), 12); // P1.1
});
