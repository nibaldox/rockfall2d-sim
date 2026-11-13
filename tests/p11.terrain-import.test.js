'use strict';

/**
 * P1.1 paquete C — validación estricta al importar perfiles (CONTRATO_P11 §4).
 *
 * Terrain.validateProfileData(data) → { ok, errors[] }, usada por fromJSON,
 * fromCSV y (solo geometría) setPoints. Una entrada inválida lanza un Error
 * en español y el perfil vigente no cambia (I-E). Los perfiles válidos dan
 * los mismos bytes que el terrain.js de 1fc23718 (I-A).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { ROOT, loadScripts, createContext } = require('./helpers/load');

const BASE = '1fc2371848e91011cac17cea19f9f110f5ad52c5';

function current() {
    return loadScripts(['js/terrain.js'], { env: 'node', seed: 1 }).SimRocas.Terrain;
}

let baseCode = null;
function base() {
    if (baseCode === null) {
        baseCode = execFileSync('git', ['show', `${BASE}:js/terrain.js`], {
            cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
        });
    }
    const ctx = createContext({ env: 'node', seed: 1 });
    vm.runInContext(baseCode, ctx, { filename: 'base/terrain.js' });
    return ctx.SimRocas.Terrain;
}

const GOOD_JSON = JSON.stringify({
    points: [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }],
    segments: [
        { type: 'roca-dura', cn: 0.8, ct: 0.2, color: '#8B7355', roughness: 2 },
        { type: 'suelo', cn: 0.4, ct: 0.4, color: '#6B8E23', roughness: 5 }
    ],
    scale: 3
});

const GOOD_CSV = [
    'X,Y,Type,Cn,Ct,Roughness',
    '0,10,roca-suave,0.6,0.4,8',
    '20,12,asfalto,0.5,0.35,1',
    '40,10,roca-suave,0.6,0.4,8',
    '60,8,asfalto,0.5,0.35,1'
].join('\n');

function jsonWith(mutate) {
    const data = JSON.parse(GOOD_JSON);
    mutate(data);
    return JSON.stringify(data);
}

// Carga un perfil vigente, intenta la importación inválida y exige: Error en
// español que cumpla `pattern` y perfil vigente idéntico byte a byte.
function assertRejected(action, pattern, label) {
    const Terrain = current();
    const t = new Terrain();
    t.fromJSON(GOOD_JSON);
    const before = t.toJSON();
    const pointsRef = t.points;
    let error = null;
    try {
        action(t);
    } catch (err) {
        error = err;
    }
    assert.ok(error, `${label}: debía lanzar`);
    assert.equal(error.name, 'Error', `${label}: debe ser un Error propio, no ${error.name}`);
    assert.match(error.message, pattern, `${label}: mensaje «${error.message}»`);
    assert.match(error.message, /^Perfil inválido/, `${label}: mensaje en español`);
    assert.equal(t.toJSON(), before, `${label}: el perfil vigente cambió`);
    assert.equal(t.points, pointsRef, `${label}: se reemplazó el arreglo de puntos`);
}

test('validateProfileData: perfil válido → ok y sin errores', () => {
    const Terrain = current();
    assert.equal(typeof Terrain.validateProfileData, 'function');
    const res = Terrain.validateProfileData(JSON.parse(GOOD_JSON));
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    // Solo geometría (vía setPoints): sin segments también es válido.
    assert.equal(Terrain.validateProfileData({ points: [{ x: 0, y: 1 }, { x: 2, y: 0 }] }).ok, true);
});

test('validateProfileData: acumula errores en español sin lanzar', () => {
    const Terrain = current();
    const res = Terrain.validateProfileData({
        points: [{ x: 0, y: NaN }, { x: 5, y: 0 }],
        segments: [{ cn: 1.5, ct: -0.1, roughness: 31 }]
    });
    assert.equal(res.ok, false);
    assert.ok(res.errors.length >= 4, JSON.stringify(res.errors));
    for (const e of res.errors) assert.equal(typeof e, 'string');
    assert.equal(Terrain.validateProfileData(null).ok, false);
    assert.equal(Terrain.validateProfileData({}).ok, false);
});

test('JSON: X o Y no finitas se rechazan', () => {
    // JSON.stringify(NaN) es null: así llega un NaN exportado.
    assertRejected(t => t.fromJSON(jsonWith(d => { d.points[1].y = NaN; })), /fila 2.*Y/, 'Y NaN');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.points[0].x = '0'; })), /fila 1.*X/, 'X texto');
    assertRejected(t => t.fromJSON(jsonWith(d => { delete d.points[2].x; })), /fila 3.*X/, 'X ausente');
    assertRejected(t => t.fromJSON('{"points":[{"x":0,"y":1},{"x":1e999,"y":0}]}'), /fila 2.*X/, 'X infinita');
});

test('JSON: menos de 2 puntos se rechaza', () => {
    assertRejected(t => t.fromJSON('{"points":[{"x":0,"y":1}]}'), /al menos 2 puntos/, 'un punto');
    assertRejected(t => t.fromJSON('{"points":[]}'), /al menos 2 puntos/, 'sin puntos');
    assertRejected(t => t.fromJSON('{}'), /al menos 2 puntos/, 'sin points');
    assertRejected(t => t.fromJSON('null'), /Perfil inválido/, 'null');
});

test('JSON: X duplicada o no creciente se rechaza con el número de fila', () => {
    assertRejected(t => t.fromJSON(jsonWith(d => { d.points[2].x = 60; })),
        /X duplicada.*filas 2 y 3/, 'duplicada');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.points[1].x = 200; })),
        /creciente.*fila 3/, 'desordenada');
});

test('JSON: Cn y Ct fuera de [0, 1] o no numéricos se rechazan', () => {
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[0].cn = 1.2; })), /tramo 1.*Cn/, 'cn > 1');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[1].ct = -0.01; })), /tramo 2.*Ct/, 'ct < 0');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[0].cn = '0.5'; })), /tramo 1.*Cn/, 'cn texto');
    assertRejected(t => t.fromJSON(jsonWith(d => { delete d.segments[1].ct; })), /tramo 2.*Ct/, 'ct ausente');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[0].ct = NaN; })), /tramo 1.*Ct/, 'ct NaN');
});

test('JSON: roughness fuera de [0, 30] o no numérica se rechaza', () => {
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[0].roughness = 30.5; })), /tramo 1.*[Rr]ugosidad/, '> 30');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[1].roughness = -1; })), /tramo 2.*[Rr]ugosidad/, '< 0');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments[0].roughness = 'alta'; })), /tramo 1.*[Rr]ugosidad/, 'texto');
});

test('JSON: segments.length distinto de points.length − 1 se rechaza', () => {
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments.pop(); })), /2 tramos.*1/, 'falta un tramo');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments.push({ ...d.segments[0] }); })), /2 tramos.*3/, 'sobra un tramo');
    assertRejected(t => t.fromJSON(jsonWith(d => { d.segments = { 0: 1 }; })), /segments/, 'segments no es lista');
});

test('JSON: la sintaxis inválida también deja el perfil intacto y avisa en español', () => {
    assertRejected(t => t.fromJSON('{"points": ['), /JSON/, 'sintaxis');
});

test('JSON: límites inclusivos y roughness ausente siguen aceptándose', () => {
    const Terrain = current();
    const t = new Terrain();
    t.fromJSON(jsonWith(d => {
        d.segments[0].cn = 0; d.segments[0].ct = 1; d.segments[0].roughness = 30;
        delete d.segments[1].roughness;
    }));
    assert.equal(t.segments[0].cn, 0);
    assert.equal(t.segments[0].ct, 1);
    assert.equal(t.segments[0].roughness, 30);
    assert.equal(t.segments[1].roughness, 5, 'roughness ausente → la del preset (suelo)');
});

test('CSV: X o Y no numéricas se rechazan con la fila (ya no se descartan)', () => {
    assertRejected(t => t.fromCSV('X,Y\n0,10\n20,abc\n40,8'), /fila 3.*Y/, 'Y texto');
    assertRejected(t => t.fromCSV('X,Y\n0,10\nNaN,5\n40,8'), /fila 3.*X/, 'X NaN');
    assertRejected(t => t.fromCSV('X,Y\n0,10\n20\n40,8'), /fila 3/, 'fila incompleta');
    assertRejected(t => t.fromCSV('X,Y\n0,10\n20,12m\n40,8'), /fila 3.*Y/, 'número con sufijo');
});

test('CSV: menos de 2 puntos se rechaza', () => {
    assertRejected(t => t.fromCSV('X,Y\n0,10'), /al menos 2 puntos/, 'un punto');
    assertRejected(t => t.fromCSV(''), /al menos 2 puntos/, 'vacío');
    assertRejected(t => t.fromCSV('X,Y\n'), /al menos 2 puntos/, 'solo cabecera');
});

test('CSV: X duplicada se rechaza con los números de fila del archivo', () => {
    // Filas de archivo (1 = cabecera): 40 aparece en las filas 3 y 5.
    assertRejected(t => t.fromCSV('X,Y\n60,8\n40,10\n20,12\n40,11\n0,10'),
        /X duplicada.*filas 3 y 5/, 'duplicada desordenada');
});

test('CSV: Cn o Ct no numéricos o fuera de [0, 1] se rechazan (sin 0.6 / 0.4 silenciosos)', () => {
    const csv = (cn, ct) => `X,Y,Type,Cn,Ct,Roughness\n0,10,roca-suave,${cn},${ct},8\n20,12,asfalto,0.5,0.35,1`;
    assertRejected(t => t.fromCSV(csv('abc', '0.4')), /fila 2.*Cn/, 'cn texto');
    assertRejected(t => t.fromCSV(csv('0.6', 'x')), /fila 2.*Ct/, 'ct texto');
    assertRejected(t => t.fromCSV(csv('1.5', '0.4')), /fila 2.*Cn/, 'cn > 1');
    assertRejected(t => t.fromCSV(csv('0.6', '-0.2')), /fila 2.*Ct/, 'ct < 0');
});

test('CSV: Cn = 0 y Ct = 0 se conservan, no se sustituyen', () => {
    const Terrain = current();
    const t = new Terrain();
    t.fromCSV('X,Y,Type,Cn,Ct,Roughness\n0,10,roca-suave,0,0,0\n20,12,asfalto,0.5,0.35,1');
    assert.equal(t.segments[0].cn, 0);
    assert.equal(t.segments[0].ct, 0);
    assert.equal(t.segments[0].roughness, 0);
});

test('CSV: roughness fuera de [0, 30] o no numérica se rechaza', () => {
    const csv = r => `X,Y,Type,Cn,Ct,Roughness\n0,10,roca-suave,0.6,0.4,${r}\n20,12,asfalto,0.5,0.35,1`;
    assertRejected(t => t.fromCSV(csv('31')), /fila 2.*[Rr]ugosidad/, '> 30');
    assertRejected(t => t.fromCSV(csv('-1')), /fila 2.*[Rr]ugosidad/, '< 0');
    assertRejected(t => t.fromCSV(csv('alta')), /fila 2.*[Rr]ugosidad/, 'texto');
});

test('setPoints: valida solo la geometría y deja el perfil intacto si falla', () => {
    assertRejected(t => t.setPoints([{ x: 0, y: 1 }, { x: 5, y: NaN }]), /fila 2.*Y/, 'NaN');
    assertRejected(t => t.setPoints([{ x: 0, y: 1 }]), /al menos 2 puntos/, 'un punto');
    assertRejected(t => t.setPoints([]), /al menos 2 puntos/, 'vacío');
    assertRejected(t => t.setPoints(null), /al menos 2 puntos/, 'null');
    assertRejected(t => t.setPoints([{ x: 0, y: 1 }, { x: 5, y: 0 }, { x: 5, y: 2 }]),
        /X duplicada.*filas 2 y 3/, 'duplicada');
});

test('setPoints: puntos desordenados válidos se siguen ordenando por X', () => {
    const pts = [{ x: 50, y: 0 }, { x: 0, y: 30 }, { x: 20, y: 10 }];
    const a = new (current())();
    a.setPoints(pts.map(p => ({ ...p })), 'suelo');
    const b = new (base())();
    b.setPoints(pts.map(p => ({ ...p })), 'suelo');
    assert.equal(a.toJSON(), b.toJSON());
});

test('I-A: perfiles válidos dan los mismos bytes que terrain.js de 1fc23718', () => {
    const Cur = current();
    const Base = base();
    const profiles = [
        [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }],
        [{ x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 }],
        [{ x: -10.5, y: 10 }, { x: 10.25, y: 10 }],
        [{ x: 0, y: 45.123456789 }, { x: 12.5, y: 30 }, { x: 13, y: 30 }, { x: 40, y: 1e-3 }, { x: 400, y: 0 }]
    ];
    for (const pts of profiles) {
        // Camino del Worker: setPoints → toJSON (terrainJSON) → fromJSON → toJSON.
        const c1 = new Cur(); c1.setPoints(pts.map(p => ({ ...p })));
        const b1 = new Base(); b1.setPoints(pts.map(p => ({ ...p })));
        const terrainJSON = b1.toJSON();
        assert.equal(c1.toJSON(), terrainJSON, 'terrainJSON');
        const c2 = new Cur(); c2.fromJSON(terrainJSON);
        const b2 = new Base(); b2.fromJSON(terrainJSON);
        assert.equal(c2.toJSON(), b2.toJSON(), 'fromJSON(terrainJSON)');
        assert.equal(c2.toJSON(), terrainJSON, 'ida y vuelta estable');
        assert.equal(c2.toCSV(), b2.toCSV(), 'toCSV');
        const c3 = new Cur(); c3.fromCSV(b2.toCSV());
        const b3 = new Base(); b3.fromCSV(b2.toCSV());
        assert.equal(c3.toJSON(), b3.toJSON(), 'fromCSV(toCSV)');
    }
    const jsons = [
        GOOD_JSON,
        // Sin segments: se crean por defecto. Sin scale: se conserva la vigente.
        '{"points":[{"x":0,"y":5},{"x":10,"y":0},{"x":20,"y":0}]}',
        // Tramo sin type ni roughness, y claves extra que deben sobrevivir.
        '{"points":[{"x":0,"y":0,"tag":"a"},{"x":400,"y":0}],"segments":[{"cn":0.5,"ct":0.5,"extra":1}],"scale":1}'
    ];
    for (const json of jsons) {
        const c = new Cur(); c.fromJSON(json);
        const b = new Base(); b.fromJSON(json);
        assert.equal(c.toJSON(), b.toJSON(), json);
    }
    const csvs = [
        GOOD_CSV,
        // Filas de datos en orden descendente, sin cabecera.
        GOOD_CSV.split('\n').slice(1).reverse().join('\n'),
        'X,Y\n10,10\n20,12\n30,8\n40,10',
        '0;10\r\n20;12\r\n40;8\r\n',
        'x\ty\ttype\tcn\tct\n0\t10\tsuelo\t0.4\t0.4\n20\t12\tconcreto\t0.85\t0.15\n40\t9\tsuelo\t0.4\t0.4',
        // CSV mixto: la fila intermedia sin material recibe el tramo por defecto.
        'X,Y,Type,Cn,Ct,Roughness\n0,10,asfalto,0.5,0.35,1\n20,12\n40,10,asfalto,0.5,0.35,1'
    ];
    for (const csv of csvs) {
        const c = new Cur(); c.fromCSV(csv);
        const b = new Base(); b.fromCSV(csv);
        assert.equal(c.toJSON(), b.toJSON(), csv);
        assert.equal(c.toCSV(), b.toCSV(), csv);
    }
});
