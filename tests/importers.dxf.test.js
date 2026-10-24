'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TextDecoder } = require('node:util');
const { loadScripts } = require('./helpers/load.js');

function loadDxf() {
    // env 'worker' con importScripts en orden + TextDecoder especial (ver nota de helpers)
    const ctx = loadScripts(
        ['vendor/delaunator/delaunator.js', 'js/importers/dxf.js'],
        { env: 'worker', extra: { TextDecoder } }
    );
    return ctx.SimRocas.importers.dxf;
}

const ENC = new TextEncoder();

function strToBytes(s) {
    return ENC.encode(s);
}

function chunkArray(bytes, size) {
    if (size <= 0) throw new Error('size');
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
    if (out.length === 0) out.push(new Uint8Array(0));
    return out;
}

function asyncFromChunks(chunks) {
    return (async function* () {
        for (const c of chunks) yield c;
    })();
}

function mkEntities(entitiesText) {
    return [
        '0', 'SECTION',
        '2', 'ENTITIES',
        entitiesText,
        '0', 'ENDSEC',
        '0', 'EOF',
        ''
    ].join('\n');
}

// entidad 3DFACE con vértices p0..p3 (p3 opcional/omitido con null)
function face3(p0, p1, p2, p3) {
    const lines = ['0', '3DFACE'];
    const pts = [p0, p1, p2, p3];
    for (let i = 0; i < 4; i++) {
        if (!pts[i]) continue;
        lines.push(String(10 + i), String(pts[i].x));
        lines.push(String(20 + i), String(pts[i].y));
        lines.push(String(30 + i), String(pts[i].z));
    }
    lines.push('');
    return lines.join('\n');
}

function assertOrigin(origin, x, y, z) {
    // cross-realm: comparar campos, no prototipos
    assert.strictEqual(origin.x, x, 'origin.x');
    assert.strictEqual(origin.y, y, 'origin.y');
    assert.strictEqual(origin.z, z, 'origin.z');
}

function assertKindUint32(arr) {
    assert.strictEqual(Object.prototype.toString.call(arr), '[object Uint32Array]');
}

function assertPositions(arr, expected, tol = 0) {
    assert.strictEqual(arr.length, expected.length);
    for (let i = 0; i < arr.length; i++) {
        if (tol === 0) assert.strictEqual(arr[i], expected[i], `pos ${i}`);
        else assert.ok(Math.abs(arr[i] - expected[i]) <= tol, `pos ${i}: ${arr[i]} vs ${expected[i]}`);
    }
}

test('detect: por extensión o texto; DXF binario no detectado como válido', () => {
    const dxf = loadDxf();
    assert.strictEqual(dxf.detect('plano.DXF', new Uint8Array(0)), true);
    assert.strictEqual(dxf.detect('foo.txt', strToBytes('0\nSECTION\n2\nENTITIES\n')), true);
    const binario = ENC.encode('AutoCAD Binary DXF\r\n\u001A\u0000');
    assert.strictEqual(dxf.detect('plano.dxf', binario), true); // extensión gana: parse rechazará
    assert.strictEqual(dxf.detect('x.txt', binario), false);
    assert.strictEqual(dxf.extensions.includes('.dxf'), true);
});

test('DXF mínimo con 2 3DFACE (cuadrado) → 2 triángulos correctos', async () => {
    const dxf = loadDxf();
    // cuadrado XY en z = 10, dividido en 2 3DFACE
    const e = [
        face3({ x: 1000.5, y: 2000.5, z: 10 }, { x: 1010.5, y: 2000.5, z: 10 },
            { x: 1010.5, y: 2010.5, z: 10 }),
        face3({ x: 1000.5, y: 2000.5, z: 10 }, { x: 1010.5, y: 2010.5, z: 10 },
            { x: 1000.5, y: 2010.5, z: 10 })
    ].join('');
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assert.strictEqual(res.kind, 'mesh');
    assert.strictEqual(res.upAxis, 'Z');
    assertKindUint32(res.indices);
    assert.strictEqual(res.stats.faces, 2);
    assert.strictEqual(res.stats.triangles, 2);
    assert.strictEqual(res.stats.triangulated, false);
    assert.strictEqual(res.stats.skippedEntities, 0);
    // origin = floor del primer vértice
    assertOrigin(res.origin, 1000, 2000, 10);
    // posiciones locales: 4 vértices útiles deduplicados (comparte 2 esquinas)
    assert.strictEqual(res.stats.vertices, 4);
    assertPositions(res.positions, new Float32Array([0.5, 0.5, 0, 10.5, 0.5, 0, 10.5, 10.5, 0, 0.5, 10.5, 0]));
});

test('curvas de nivel concéntricas (LWPOLYLINE con código 38) → malla triangulada, Z interpolada en un punto entre 20 y 30', async () => {
    const dxf = loadDxf();
    const N = 24;
    const cx = 300000.5, cy = 6300000.5;
    let e = '';
    const ringZ = [[75, 20], [150, 30]]; // anillos entre los que se interpola el punto de prueba
    for (const [r, z] of ringZ) {
        e += ['0', 'LWPOLYLINE', '70', '1', '38', String(z), ''].join('\n');
        for (let i = 0; i < N; i++) {
            const a = (i / N) * 2 * Math.PI;
            e += ['10', (cx + r * Math.cos(a)).toFixed(4),
                '20', (cy + r * Math.sin(a)).toFixed(4), ''].join('\n');
        }
    }
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assert.strictEqual(res.stats.polylines, 2);
    assert.strictEqual(res.stats.triangulated, true);
    assert.ok(res.stats.triangles > 0, 'triángulos producidos');
    assert.strictEqual(res.stats.flatWarning, undefined);
    // punto de prueba: centro entre ambos anillos (r ~112 en ángulo 0)
    const px = cx + 112.5 - res.origin.x, py = cy - res.origin.y;
    // interpolar baricéntricamente el triángulo que contiene (px, py)
    const z = interpZ(res, px, py);
    assert.ok(z !== null, 'algún triángulo contiene el punto');
    // interpZ da z LOCAL; en mundo (sumando origin.z) debe estar entre 20 y 30
    const zw = z + res.origin.z;
    assert.ok(zw > 20 && zw < 30, `z interpolado (mundo) ${zw} debe estar entre 20 y 30`);
});

function interpZ(res, x, y) {
    for (let t = 0; t < res.indices.length; t += 3) {
        const i0 = res.indices[t], i1 = res.indices[t + 1], i2 = res.indices[t + 2];
        const ax = res.positions[i0 * 3], ay = res.positions[i0 * 3 + 1];
        const bx = res.positions[i1 * 3], by = res.positions[i1 * 3 + 1];
        const cx2 = res.positions[i2 * 3], cy2 = res.positions[i2 * 3 + 1];
        // contención por signo de productos cruzados de aristas
        const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const d2 = (cx2 - bx) * (y - by) - (cy2 - by) * (x - bx);
        const d3 = (ax - cx2) * (y - cy2) - (ay - cy2) * (x - cx2);
        const neg = d1 < 0 || d2 < 0 || d3 < 0;
        const pos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(neg && pos)) {
            // ecuación baricéntrica por áreas
            const det = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2);
            const l0 = ((by - cy2) * (x - cx2) + (cx2 - bx) * (y - cy2)) / det;
            const l1 = ((cy2 - ay) * (x - cx2) + (ax - cx2) * (y - cy2)) / det;
            const l2 = 1 - l0 - l1;
            const z0 = res.positions[i0 * 3 + 2], z1 = res.positions[i1 * 3 + 2],
                z2 = res.positions[i2 * 3 + 2];
            return l0 * z0 + l1 * z1 + l2 * z2;
        }
    }
    return null;
}

test('POLYLINE 3D con VERTEX (flag 70 bit 8) y polyface (flag 64 con refs 71-74) producen triángulos', async () => {
    const dxf = loadDxf();
    // polibanda: v(0,0,5), v(10,0,5), v(10,10,25), v(0,10,25)
    let e = ['0', 'POLYLINE', '70', '8', '30', '0', ''].join('\n');
    const verts3d = [[0, 0, 5], [10, 0, 5], [10, 10, 25], [0, 10, 25]];
    for (const [x, y, z] of verts3d) {
        e += ['0', 'VERTEX', '10', String(x), '20', String(y), '30', String(z), ''].join('\n');
    }
    e += ['0', 'SEQEND', ''].join('\n');
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer, { densify: 100 });
    assert.strictEqual(res.stats.polylines, 1);
    assert.strictEqual(res.stats.triangulated, true, '3D vértices también se triangulan');
    assert.strictEqual(res.stats.triangles, 2);
    // polyface mesh: 4 vértices + 1 cara (refs 71-74, con 4.º ref = 1.ª para triángulo)
    let p = ['0', 'POLYLINE', '70', '64', ''].join('\n');
    const pv = [[1000.25, 2000.25, 50], [1010.25, 2000.25, 50], [1010.25, 2010.25, 60], [1000.25, 2010.25, 60]];
    for (const [x, y, z] of pv) {
        p += ['0', 'VERTEX', '70', '192', '10', String(x), '20', String(y), '30', String(z), ''].join('\n');
    }
    p += ['0', 'VERTEX', '70', '128', '71', '1', '72', '2', '73', '3', '74', '4', ''].join('\n');
    p += ['0', 'SEQEND', ''].join('\n');
    const res2 = await dxf.parse(strToBytes(mkEntities(p)).buffer);
    assert.strictEqual(res2.stats.faces, 1); // 1 registro de cara (quad)
    assert.strictEqual(res2.stats.triangulated, false, 'polyface sin curvas: caras directas');
    assert.strictEqual(res2.stats.triangles, 2);
    // primera posición = primer vértice del mesh menos origin floor
    assertOrigin(res2.origin, 1000, 2000, 50);
    assertPositions(res2.positions.slice(0, 6), new Float32Array([0.25, 0.25, 0, 10.25, 0.25, 0]));
});

test('coordenadas UTM sin pérdida (< 1e-3 m)', async () => {
    const dxf = loadDxf();
    const x0 = 350123.456, y0 = 6301234.789, z0 = 2504.001;
    const e = face3({ x: x0, y: y0, z: z0 }, { x: x0 + 12.5, y: y0 + 3.25, z: z0 + 0.125 },
        { x: x0 + 0.5, y: y0 + 8.75, z: z0 + 1.5 });
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assertOrigin(res.origin, Math.floor(x0), Math.floor(y0), Math.floor(z0));
    const world = [[x0, y0, z0], [x0 + 12.5, y0 + 3.25, z0 + 0.125], [x0 + 0.5, y0 + 8.75, z0 + 1.5]];
    for (let i = 0; i < 3; i++) {
        for (let k = 0; k < 3; k++) {
            const localF64 = world[i][k] - res.origin[['x', 'y', 'z'][k]];
            const f32 = res.positions[i * 3 + k];
            assert.ok(Math.abs(f32 - localF64) < 1e-3, `v${i} c${k}: ${f32} vs ${localF64}`);
        }
    }
});

test('streaming: bloques de 1, 7 y 4096 bytes dan resultados idénticos', async () => {
    const dxf = loadDxf();
    let src = '999\ncomentario largo que parte líneas por la mitad sin miedo\n';
    for (let i = 0; i < 20; i++) {
        src += ['0', '3DFACE',
            '10', (i * 1.25).toFixed(3), '20', (i * 2.5).toFixed(3), '30', (i * 0.01).toFixed(2),
            '11', (i * 1.5 + 1).toFixed(3), '21', (i * 2.75).toFixed(3), '31', '1.5',
            '12', (i * 2 + 2).toFixed(3), '22', (i * 3).toFixed(3), '32', '0.25',
            '13', (i * 2.25 + 3).toFixed(3), '23', (i * 3.25).toFixed(3), '33', '0.25', ''].join('\n');
    }
    const full = await dxf.parse(strToBytes(mkEntities(src)).buffer);
    for (const size of [1, 7, 4096]) {
        const res = await dxf.parse(asyncFromChunks(chunkArray(strToBytes(mkEntities(src)), size)));
        assertPositions(full.positions, res.positions, 0);
        assertOrigin(res.origin, full.origin.x, full.origin.y, full.origin.z);
        assert.strictEqual(res.stats.vertices, full.stats.vertices);
        assert.strictEqual(res.stats.triangles, full.stats.triangles);
        assert.strictEqual(res.stats.faces, full.stats.faces);
    }
});

test('DXF sin cotas (todas Z = 0, elevación 0) → stats.flatWarning', async () => {
    const dxf = loadDxf();
    const e = [
        '0', 'LWPOLYLINE', '38', '0', '10', '0', '20', '0', '10', '10', '20', '0',
        '10', '10', '20', '10', '10', '0', '20', '10', ''
    ].join('\n');
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assert.strictEqual(res.stats.flatWarning, true);
});

test('DXF binario → error en español', async () => {
    const dxf = loadDxf();
    const bin = ENC.encode('AutoCAD Binary DXF\r\n\u001A\u0000xFFFFFFFF');
    await assert.rejects(dxf.parse(bin.slice().buffer),
        /DXF binario no soportado; exporte como DXF ASCII/);
    const asyncBin = asyncFromChunks([bin.slice(0, 5), bin.slice(5)]);
    await assert.rejects(dxf.parse(asyncBin),
        /DXF binario no soportado; exporte como DXF ASCII/);
});

test('maxEdge evita triángulos gigantes en una L cóncava de curvas', async () => {
    const dxf = loadDxf();
    // L de brazos largos: (0,0)-(0,300)-(30,30)-(300,0)-cierre. El «hueco»
    // cóncavo entre brazos mide ~424 m de diagonal; con densify 2 m la mediana
    // de aristas queda a pocos metros y el umbral (20× mediana) descarta los
    // triángulos que lo rellenarían.
    const polyline = (pts) => {
        let s = ['0', 'LWPOLYLINE', ''].join('\n');
        for (const [x, y] of pts) {
            s += ['10', String(x), '20', String(y), ''].join('\n');
        }
        return s;
    };
    const e = polyline([[0, 0], [0, 300], [30, 30], [300, 0], [0, 0]]);
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assert.strictEqual(res.stats.triangulated, true);
    assert.ok(res.stats.triangles > 0, 'triángulos en los brazos');
    // el centro del hueco cóncavo NO es cubierto por ningún triángulo
    const zNotch = interpZ(res, 150 - res.origin.x, 150 - res.origin.y);
    assert.strictEqual(zNotch, null, 'el hueco cóncavo no se rellena (maxEdge)');
    // cerca de los brazos sí hay malla
    const zArm = interpZ(res, 0 - res.origin.x, 149 - res.origin.y);
    assert.ok(zArm === 0, `punto del brazo cubierto (z=${zArm})`);
});

test('LINE y POINT con cota aportan vértices con cota', async () => {
    const dxf = loadDxf();
    const e = [
        '0', 'LINE', '10', '0', '20', '0', '30', '500',
        '11', '10', '21', '0', '31', '520', '',
        '0', 'LINE', '10', '10', '20', '0', '30', '520',
        '11', '10', '21', '10', '31', '540', '',
        '0', 'LINE', '10', '10', '20', '10', '30', '540',
        '11', '0', '21', '10', '31', '560', '',
        '0', 'POINT', '10', '5', '20', '5', '30', '530', ''
    ].join('\n');
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assert.strictEqual(res.stats.triangulated, true);
    assert.strictEqual(res.stats.faces, 0);
    assert.strictEqual(res.stats.flatWarning, undefined);
    assert.ok(res.stats.triangles > 0);
});

test('entidades no soportadas → skippedEntities (sin ruido)', async () => {
    const dxf = loadDxf();
    const e = [
        '0', 'SPLINE', '',
        '0', 'ARC', '10', '0', '20', '0', '30', '0', '40', '5', '',
        '0', 'INSERT', '2', 'BLOQUE1', '',
        face3({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 })
    ].join('\n');
    const res = await dxf.parse(strToBytes(mkEntities(e)).buffer);
    assert.strictEqual(res.stats.skippedEntities, 3);
    assert.strictEqual(res.stats.faces, 1);
    assert.strictEqual(res.stats.triangles, 1);
});

test('BLOCKS se ignora (solo ENTITIES aporta)', async () => {
    const dxf = loadDxf();
    const e = [
        '0', '3DFACE', '10', '700.5', '20', '800.5', '30', '90',
        '11', '705.5', '21', '800.5', '31', '90',
        '12', '705.5', '22', '805.5', '32', '90',
        '13', '700.5', '23', '805.5', '33', '90', ''
    ].join('\n');
    const src = [
        '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC', '',
        '0', 'SECTION', '2', 'BLOCKS', e + e.replace('700', '2000'), '0', 'ENDSEC', '',
        '0', 'SECTION', '2', 'ENTITIES', e, '0', 'ENDSEC', '',
        '0', 'EOF', ''
    ].join('\n');
    const res = await dxf.parse(strToBytes(src).buffer);
    // la cara de 4 vértices (quad) → 2 triángulos; SOLO los de ENTITIES cuentan
    assert.strictEqual(res.stats.faces, 1);
    assert.strictEqual(res.stats.triangles, 2);
    assert.strictEqual(res.stats.triangles, res.indices.length / 3);
    assert.strictEqual(res.positions.length / 3, res.stats.vertices);
    assert.strictEqual(res.stats.vertices, 4);
});

test('progreso: onProgress creciente y llega a ~1 con totalBytes', async () => {
    const dxf = loadDxf();
    const bytes = strToBytes(mkEntities(face3({ x: 0, y: 0, z: 5 }, { x: 2, y: 0, z: 5 },
        { x: 2, y: 2, z: 6 })));
    let last = -1, calls = 0;
    const res = await dxf.parse(bytes.buffer, { totalBytes: bytes.length }, (f) => {
        assert.ok(f >= last, 'monótono');
        assert.ok(f >= 0 && f <= 1, 'rango');
        last = f; calls++;
    });
    assert.ok(calls > 0, 'callbacks');
    assert.ok(last >= 0.99, `última ${last}`);
    assert.strictEqual(res.stats.triangles, 1);
});

test('CRLF, líneas vacías y pares partidos entre bloques', async () => {
    const dxf = loadDxf();
    const res = await dxf.parse(strToBytes(
        '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\n3DFACE\r\n10\r\n' +
        '0.25\r\n20\r\n0\r\n30\r\n1\r\n\r\n11\r\n1.25\r\n21\r\n0\r\n31\r\n1\r\n' +
        '12\r\n1.25\r\n22\r\n1\r\n32\r\n2\r\n13\r\n0.25\r\n23\r\n1\r\n33\r\n2\r\n' +
        '0\r\nENDSEC\r\n0\r\nEOF\r\n').buffer);
    // quad con 4.º vértice distinto del 3.º → 2 triángulos
    assert.strictEqual(res.stats.triangles, 2);
    assertOrigin(res.origin, 0, 0, 1);
});

test('input no soportado → error en español', async () => {
    const dxf = loadDxf();
    await assert.rejects(dxf.parse('cadena de texto'),
        /Formato de entrada no soportado para el importador DXF/);
});

test('DXF de curvas con ~200k vértices generados en memoria: < 30 s', async () => {
    const dxf = loadDxf();
    const N = 200000; // vértices objetivo (pares 10/20 en el archivo)
    const rings = [];
    let total = 0;
    let r = 200, z = 5;
    while (total < N) {
        // separación en planta ≥ 10 m: densify (2 m) no multiplica puntos
        const per = Math.max(8, Math.round((2 * Math.PI * r) / 10));
        rings.push({ r, z, per });
        total += per;
        r += 15; // separación radial de curvas
        z += 0.75;
    }
    let src = '0\nSECTION\n2\nENTITIES\n';
    for (const { r: rad, z: zv, per } of rings) {
        src += '0\nLWPOLYLINE\n38\n' + zv.toFixed(1) + '\n';
        for (let i = 0; i < per; i++) {
            const a = (i / per) * 2 * Math.PI;
            src += '10\n' + (rad * Math.cos(a)).toFixed(3) + '\n20\n' + (rad * Math.sin(a)).toFixed(3) + '\n';
        }
    }
    src += '0\nENDSEC\n0\nEOF\n';
    const bytes = strToBytes(src);
    const totalMB = bytes.length / (1024 * 1024);
    const t0 = process.hrtime.bigint();
    const res = await dxf.parse(bytes.buffer);
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.ok(res.stats.vertices >= N * 0.9, `vértices ${res.stats.vertices}`);
    assert.strictEqual(res.stats.triangulated, true);
    assert.ok(res.stats.triangles > 0);
    console.log(`[perf DXF] ${totalMB.toFixed(1)} MB, ${res.stats.vertices} vértices, ` +
        `${res.stats.triangles} triángulos en ${dt.toFixed(2)} s`);
    assert.ok(dt < 30, `tardó ${dt.toFixed(2)} s`);
});
