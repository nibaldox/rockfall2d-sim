'use strict';

/**
 * CP11 — correctivo de P1.1: compatibilidad de la importación y de los
 * perfiles STL/DEM con la base 1fc23718.
 *
 * - STL y DEM: la App normaliza las X duplicadas como lo hacía addPoint.
 * - CSV: la primera fila sin X e Y numéricas es cabecera; las columnas
 *   opcionales ausentes o vacías toman los valores por defecto de la base;
 *   un valor presente pero inválido se rechaza.
 * - Generador: anchos en (0, 1e-6) se rechazan con un mensaje claro.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const copy = pts => pts.map(p => ({ ...p }));

const GOOD_JSON = '{"points":[{"x":0,"y":60},{"x":60,"y":0}],"segments":[{"type":"suelo","cn":0.4,"ct":0.4,"color":"#6B8E23","roughness":5}],"scale":3}';

function rejected(csv, pattern, label) {
    const t = new (current())();
    t.fromJSON(GOOD_JSON);
    const before = t.toJSON() + t.toCSV();
    assert.throws(() => t.fromCSV(csv), err => {
        assert.match(err.message, /^Perfil inválido/, label);
        assert.match(err.message, pattern, `${label}: «${err.message}»`);
        return true;
    }, label);
    assert.equal(t.toJSON() + t.toCSV(), before, `${label}: el perfil vigente cambió`);
}

// ---- 1. STL y DEM (vías 13 y 14) ----

const AUTO_PROFILES = [
    // X duplicadas exactas y desordenadas: se conserva el primero que llegó.
    [{ x: 50, y: 0 }, { x: 0, y: 30 }, { x: 20, y: 10 }, { x: 20, y: 11 }, { x: 0, y: 31 }, { x: 50, y: 1 }],
    // Dentro de la tolerancia de 1e-9.
    [{ x: 0, y: 5 }, { x: 10, y: 4 }, { x: 10 + 5e-10, y: 3 }, { x: 30, y: 0 }, { x: 30 - 5e-10, y: 9 }],
    // La cadena de casi duplicados depende del orden de llegada, como en la base.
    [{ x: 8e-10, y: 1 }, { x: 0, y: 2 }, { x: 1.6e-9, y: 3 }, { x: 40, y: 0 }],
    // Pared vertical de un STL: muchos puntos con la misma X.
    [{ x: 0, y: 100 }, { x: 25, y: 80 }, { x: 25, y: 60 }, { x: 25, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 0 }, { x: 90, y: 0 }],
    // Sin duplicados: no cambia nada.
    [{ x: 0, y: 3 }, { x: 5, y: 2 }, { x: 9, y: 0 }]
];

test('STL/DEM: normalizeAutoPoints + setPoints da el mismo perfil que setPoints de la base', () => {
    const Cur = current();
    const Base = base();
    assert.equal(typeof Cur.normalizeAutoPoints, 'function');
    for (const pts of AUTO_PROFILES) {
        const input = copy(pts);
        const snapshot = JSON.stringify(input);
        const c = new Cur();
        c.setPoints(Cur.normalizeAutoPoints(input));
        assert.equal(JSON.stringify(input), snapshot, 'no muta la entrada');
        const b = new Base();
        b.setPoints(copy(pts));
        assert.equal(c.toJSON(), b.toJSON(), snapshot);
        assert.equal(c.toCSV(), b.toCSV(), snapshot);
    }
});

test('STL/DEM: la normalización no esconde datos inválidos ni perfiles de menos de 2 puntos', () => {
    const Cur = current();
    const t = new Cur();
    t.fromJSON(GOOD_JSON);
    const before = t.toJSON();
    for (const bad of [
        [{ x: 0, y: 1 }, { x: 5, y: NaN }],
        [{ x: 0, y: 1 }, { x: Infinity, y: 2 }, { x: 5, y: 0 }],
        [{ x: 7, y: 1 }, { x: 7, y: 2 }],
        []
    ]) {
        assert.throws(() => t.setPoints(Cur.normalizeAutoPoints(bad)), /^Error: Perfil inválido/, JSON.stringify(bad));
        assert.equal(t.toJSON(), before);
    }
    // Una importación manual con X duplicada se sigue rechazando.
    assert.throws(() => t.setPoints([{ x: 0, y: 1 }, { x: 5, y: 0 }, { x: 5, y: 2 }]), /X duplicada/);
});

test('STL/DEM: las dos vías normalizan antes de setPoints y cualquier rechazo llega como alert', () => {
    for (const file of ['js/app-stl.js', 'js/app-profile3d.js']) {
        const source = read(file);
        assert.match(source,
            /this\.terrain\.setPoints\(SimRocas\.Terrain\.normalizeAutoPoints\(\w+\)\);/, file);
        const at = source.indexOf('this.terrain.setPoints(');
        const tryAt = source.lastIndexOf('try {', at);
        const catchAt = source.indexOf('catch (err)', at);
        assert.ok(tryAt > 0 && catchAt > at, `${file}: dentro de try/catch`);
        assert.match(source.slice(catchAt, catchAt + 200), /alert\(/, `${file}: alert`);
    }
});

// ---- 2 y 3. CSV ----

const COMPAT_CSVS = [
    ['solo X,Y sin cabecera', '0,10\n20,12\n40,8'],
    ['solo X,Y con cabecera', 'X,Y\n0,10\n20,12\n40,8'],
    ['cabecera en castellano', 'Distancia,Cota\n0,10\n20,12\n40,8'],
    ['cabecera con comentario', '# perfil norte\n0,10\n20,12'],
    ['cabecera de una sola palabra', 'perfil\n0 10\n20 12'],
    ['cabecera castellana con material', 'Distancia;Cota;Material;Rn;Rt;Rugosidad\n0;10;suelo;0.4;0.4;5\n20;12;concreto;0.85;0.15;0\n40;9;suelo;0.4;0.4;5'],
    ['coma final en X,Y', 'X,Y,\n0,10,\n20,12,\n40,8,'],
    ['coma final con 6 columnas (rugosidad vacía)', 'X,Y,Type,Cn,Ct,Roughness\n0,50,suelo,0.5,0.5,\n30,20,suelo,0.5,0.5,\n60,0,suelo,0.5,0.5,'],
    ['Ct vacío al final', 'X,Y,Type,Cn,Ct\n0,50,suelo,0.5,\n30,20,suelo,0.5,\n60,0,,,'],
    ['columnas opcionales todas vacías', 'X,Y,Type,Cn,Ct,Roughness\n0,50,,,,\n30,20,,,,\n60,0,,,,'],
    ['CRLF, BOM aparte y columnas vacías', 'Dist,Cota,Tipo,Cn,Ct,Rug\r\n60,0,asfalto,0.5,0.35,\r\n0,50,roca-dura,0.8,0.2,2\r\n30,20\r\n'],
    ['tipo desconocido y rugosidad vacía', 'x,y,t,cn,ct,r\n0,5,arcilla,0.3,0.7,\n9,0,arcilla,0.3,0.7,']
];

test('CSV: cabecera libre, solo X,Y, coma final y columnas vacías dan los bytes de 1fc23718', () => {
    const Cur = current();
    const Base = base();
    for (const [label, csv] of COMPAT_CSVS) {
        const b = new Base();
        b.fromCSV(csv);
        assert.ok(b.points.length >= 2, `${label}: la base debía aceptarlo`);
        const c = new Cur();
        c.fromCSV(csv);
        assert.equal(c.toJSON(), b.toJSON(), `${label}: toJSON`);
        assert.equal(c.toCSV(), b.toCSV(), `${label}: toCSV`);
    }
});

test('CSV: los valores por defecto de las columnas vacías son 0.6, 0.4 y 0', () => {
    const t = new (current())();
    t.fromCSV('X,Y,Type,Cn,Ct,Roughness\n0,50,suelo,0.5,0.5,\n30,20,suelo,0.5,\n60,0');
    assert.equal(t.segments[0].roughness, 0);
    assert.equal(t.segments[0].cn, 0.5);
    assert.equal(t.segments[1].ct, 0.4);
    assert.equal(t.segments[1].type, 'suelo');
});

test('CSV: solo la primera fila puede ser cabecera; las demás no numéricas se rechazan con su fila', () => {
    rejected('Distancia,Cota\n0,10\nDistancia,Cota\n40,8', /fila 3.*X/, 'cabecera repetida');
    rejected('0,10\n20,12\nfin,del archivo', /fila 3.*X/, 'texto al final');
    rejected('Distancia,Cota\n0,10\n20,abc\n40,8', /fila 3.*Y/, 'Y texto');
    rejected('Distancia,Cota\n0,10\n\n20\n40,8', /fila 4.*Y/, 'fila incompleta tras línea vacía');
    rejected('Distancia,Cota\n0,10', /al menos 2 puntos/, 'cabecera y un punto');
    // Una primera fila con números ilegibles no es cabecera: se rechaza.
    rejected('0,12m\n20,12\n40,8', /fila 1.*Y/, 'sufijo en la fila 1');
    rejected('Infinity,5\n20,12\n40,8', /fila 1.*X/, 'infinito en la fila 1');
});

test('CSV: un valor opcional presente pero inválido se rechaza', () => {
    const csv = (cn, ct, r) => `Dist,Cota,Tipo,Cn,Ct,Rug\n0,10,suelo,${cn},${ct},${r}\n20,12,asfalto,0.5,0.35,1`;
    rejected(csv('abc', '0.4', '5'), /fila 2.*Cn/, 'Cn texto');
    rejected(csv('0.6', '0,4x', '5'), /fila 2/, 'Ct ilegible');
    rejected(csv('1.01', '0.4', '5'), /fila 2.*Cn/, 'Cn > 1');
    rejected(csv('0.6', '-0.01', '5'), /fila 2.*Ct/, 'Ct < 0');
    rejected(csv('0.6', '0.4', '31'), /fila 2.*rugosidad/, 'rugosidad > 30');
    rejected(csv('0.6', '0.4', 'alta'), /fila 2.*rugosidad/, 'rugosidad texto');
    rejected(csv('0.6', '0.4x', ''), /fila 2.*Ct/, 'Ct inválido con rugosidad vacía');
});

test('JSON sin segments se sigue aceptando con los valores por defecto de la base (B4)', () => {
    const json = '{"points":[{"x":0,"y":5},{"x":10,"y":0},{"x":20,"y":0}]}';
    const c = new (current())();
    c.fromJSON(json);
    const b = new (base())();
    b.fromJSON(json);
    assert.equal(c.toJSON(), b.toJSON());
    assert.equal(c.toCSV(), b.toCSV());
});

// ---- 5. Generador (B1) ----

test('generador: anchos en (0, 1e-6) se rechazan con un mensaje claro; 0 y 1e-6 se aceptan', () => {
    const BP = loadScripts(['js/bench-profile.js'], { env: 'node' }).SimRocas.BenchProfile;
    const Cur = current();
    const ok = { benches: 2, benchHeight: 10, faceAngleDeg: 70, bermWidth: 8, baseElevation: 0 };
    const cases = [
        ['bermWidth', /ancho de berma debe ser 0 o al menos 0,000001 m/],
        ['topPlatform', /plataforma superior debe ser 0 o al menos 0,000001 m/],
        ['floorLength', /piso debe ser 0 o al menos 0,000001 m/]
    ];
    for (const [key, pattern] of cases) {
        for (const value of [1e-10, 9.99e-7, Number.MIN_VALUE]) {
            const r = BP.generate({ ...ok, [key]: value });
            assert.equal(r.ok, false, `${key} = ${value}`);
            assert.match(r.error, pattern, `${key} = ${value}`);
            assert.equal(r.points, undefined);
        }
        for (const value of [0, 1e-6, 5]) {
            const r = BP.generate({ ...ok, [key]: value });
            assert.equal(r.ok, true, `${key} = ${value}: ${r.error}`);
            // Lo que el generador acepta, Terrain también lo acepta (B1).
            new Cur().setPoints(JSON.parse(JSON.stringify(r.points)));
        }
    }
    const thin = BP.generate({ ...ok, benchHeight: 1e-4, faceAngleDeg: 89.9 });
    assert.equal(thin.ok, false);
    assert.match(thin.error, /proyección horizontal/);
    assert.match(thin.error, /0,000001 m/);
});
