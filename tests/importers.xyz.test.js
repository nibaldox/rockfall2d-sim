'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { loadScripts } = require('./helpers/load.js');

const ctx = loadScripts(['js/importers/xyz.js'], { env: 'node', extra: { TextDecoder } });
const importer = ctx.SimRocas.importers.xyz;

const tmpDir = path.join(os.tmpdir(), `simrocas-xyz-test-legacy-${process.pid}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function parseText(text, options = {}, onProgress = null) {
    const bytes = Buffer.from(text, 'utf8');
    return importer.parse(new Uint8Array(bytes).buffer, options, onProgress);
}

test('detect: acepta por extension y por contenido numerico', () => {
    assert.equal(importer.id, 'xyz');
    assert.deepEqual([...importer.extensions], ['.xyz', '.csv', '.txt', '.pts']);
    assert.equal(importer.detect('nube.xyz'), true);
    assert.equal(importer.detect('nube.csv'), true);
    assert.equal(importer.detect('nube.txt'), true);
    assert.equal(importer.detect('nube.pts'), true);
    assert.equal(importer.detect('nube.dat', new TextEncoder().encode('1 2 3\n')), true);
    assert.equal(importer.detect('nube.dat', new TextEncoder().encode('BINARIORAWDATA')), false);
});

test('parse: separador espacio, origen floor del primer punto UTM', async () => {
    const text = '5101234.5 6301234.5 812.3\n5101235.5 6301236.5 814.7\n';
    const result = await parseText(text);
    assert.equal(result.kind, 'points');
    assert.equal(result.stats.points, 2);
    assert.equal(result.stats.skippedLines, 0);
    assert.equal(result.stats.headerSkipped, 0);
    assert.equal(result.stats.separator, ' ');
    assert.equal(result.stats.decimalComma, false);
    assert.equal(result.origin.x, 5101234);
    assert.equal(result.origin.y, 6301234);
    assert.equal(result.origin.z, 812);
    assert.ok(Math.abs(result.positions[0] - 0.5) < 1e-3);
    assert.ok(Math.abs(result.positions[1] - 0.5) < 1e-3);
    assert.ok(Math.abs(result.positions[2] - 0.3) < 1e-3);
    assert.ok(Math.abs(result.positions[3] - 1.5) < 1e-3);
    assert.ok(Math.abs(result.positions[5] - 2.7) < 1e-3);
});

test('parse: separador tab y CRLF', async () => {
    const text = '5101234.5\t6301234.5\t812.3\r\n5101235.5\t6301236.5\t814.7\r\n';
    const result = await parseText(text);
    assert.equal(result.stats.separator, '\t');
    assert.equal(result.stats.points, 2);
    assert.ok(Math.abs(result.positions[2] - 0.3) < 1e-3);
    assert.ok(Math.abs(result.positions[3] - 1.5) < 1e-3);
});

test('parse: separador coma simple sin coma decimal', async () => {
    const text = '5101234.5,6301234.5,812.3\n5101235.5,6301236.5,814.7\n';
    const result = await parseText(text);
    assert.equal(result.stats.separator, ',');
    assert.equal(result.stats.decimalComma, false);
    assert.equal(result.stats.points, 2);
    assert.ok(Math.abs(result.positions[2] - 0.3) < 1e-3);
});

test('parse: punto y coma con coma decimal y cabecera Este;Norte;Cota', async () => {
    const text = 'Este;Norte;Cota\n5101234,5;6301234,5;812,3\n5101235,5;6301236,5;814,7\n';
    const result = await parseText(text);
    assert.equal(result.stats.separator, ';');
    assert.equal(result.stats.decimalComma, true);
    assert.equal(result.stats.headerSkipped, 1);
    assert.equal(result.stats.points, 2);
    assert.equal(result.origin.x, 5101234);
    assert.equal(result.origin.y, 6301234);
    assert.equal(result.origin.z, 812);
    assert.ok(Math.abs(result.positions[0] - 0.5) < 1e-3);
    assert.ok(Math.abs(result.positions[2] - 0.3) < 1e-3);
    assert.ok(Math.abs(result.positions[3] - 1.5) < 1e-3);
});

test('parse: cabecera X,Y,Z con coma separadora', async () => {
    const text = 'X,Y,Z\n5101234.5,6301234.5,812.3\n5101235.5,6301236.5,814.7\n';
    const result = await parseText(text);
    assert.equal(result.stats.separator, ',');
    assert.equal(result.stats.decimalComma, false);
    assert.equal(result.stats.headerSkipped, 1);
    assert.equal(result.stats.points, 2);
    assert.ok(Math.abs(result.positions[4] - 2.5) < 1e-3);
});

test('parse: columnas extra (intensidad, RGB) y multiples espacios', async () => {
    const text = '5101234.5  6301234.5  812.3  42   255 0 128\n5101235.5  6301236.5  814.7  17   200 3 90\n';
    const result = await parseText(text);
    assert.equal(result.stats.points, 2);
    assert.equal(result.stats.separator, ' ');
    assert.ok(Math.abs(result.positions[0] - 0.5) < 1e-3);
    assert.ok(Math.abs(result.positions[5] - 2.7) < 1e-3);
});

test('parse: options.columns personalizado', async () => {
    const result = await parseText('7 5101234.5 812.3 6301234.5 6', { columns: [1, 3, 2] });
    assert.equal(result.stats.points, 1);
    assert.equal(result.origin.x, 5101234);
    assert.equal(result.origin.y, 6301234);
    assert.equal(result.origin.z, 812);
    assert.ok(Math.abs(result.positions[2] - 0.3) < 1e-3);
});

test('parse: precision UTM — error < 1e-3 m vs (mundo - origen) en Float64', async () => {
    const worlds = [
        [6301234.75, 4600123.25, 310.4],
        [6301235.75, 4600125.25, 314.8],
        [6301236.95, 4600126.4, 312.1]
    ];
    const text = worlds.map((p) => p.join(' ')).join('\n') + '\n';
    const result = await parseText(text);
    const origin = [result.origin.x, result.origin.y, result.origin.z];
    for (let i = 0; i < worlds.length; i += 1) {
        for (let c = 0; c < 3; c += 1) {
            const expected = worlds[i][c] - origin[c];
            const got = result.positions[i * 3 + c];
            assert.ok(Math.abs(got - expected) < 1e-3, `punto ${i} col ${c}: ${got} vs ${expected}`);
        }
    }
});

test('parse: comentarios #, lineas vacias e invalidas contadas', async () => {
    const text = [
        '# comentario',
        '',
        '5101234.5 6301234.5 812.3',
        'esto no es un punto',
        '5101235.5 6301236.5 814.7',
        '   ',
        '1 2',
        'a b c'
    ].join('\n');
    const result = await parseText(text);
    assert.equal(result.stats.points, 2);
    assert.equal(result.stats.skippedLines, 3);
    assert.equal(result.stats.headerSkipped, 0);
});

test('parse: sin puntos -> error en español', async () => {
    await assert.rejects(() => parseText('hola mundo\nadios mundo\n'), (e) => {
        assert.equal(e.message, 'El archivo no contiene puntos XYZ válidos.');
        return true;
    });
});

test('parse: archivo vacio -> error en español', async () => {
    await assert.rejects(() => parseText(''), (e) => {
        assert.equal(e.message, 'El archivo no contiene puntos XYZ válidos.');
        return true;
    });
});

async function* chunker(bytes, size) {
    for (let i = 0; i < bytes.length; i += size) {
        yield bytes.subarray(i, Math.min(i + size, bytes.length));
    }
}

test('parse: streaming chunks 1, 7 y 4096 bytes -> resultados idénticos', async () => {
    const rows = [];
    for (let i = 0; i < 500; i += 1) {
        rows.push(`${(6301000 + i * 0.12345).toFixed(6)} ${(4601000 + i * 2.75).toFixed(3)} ${(300 + i * 0.7).toFixed(4)}`);
    }
    const text = rows.join('\n') + '\n';
    const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
    const expected = await parseText(text);

    for (const size of [1, 7, 4096]) {
        const result = await importer.parse(chunker(bytes, size), { totalBytes: bytes.length }, null);
        assert.equal(result.stats.points, expected.stats.points, `chunkSize=${size}`);
        assert.equal(result.stats.skippedLines, expected.stats.skippedLines, `chunkSize=${size}`);
        assert.equal(result.stats.headerSkipped, expected.stats.headerSkipped, `chunkSize=${size}`);
        assert.equal(result.stats.separator, expected.stats.separator, `chunkSize=${size}`);
        assert.equal(result.stats.decimalComma, expected.stats.decimalComma, `chunkSize=${size}`);
        assert.equal(result.origin.x, expected.origin.x, `chunkSize=${size}`);
        assert.equal(result.origin.y, expected.origin.y, `chunkSize=${size}`);
        assert.equal(result.origin.z, expected.origin.z, `chunkSize=${size}`);
        assert.equal(result.positions.length, expected.positions.length, `chunkSize=${size}`);
        let mismatch = -1;
        for (let i = 0; i < expected.positions.length; i += 1) {
            if (result.positions[i] !== expected.positions[i]) { mismatch = i; break; }
        }
        assert.equal(mismatch, -1, `chunkSize=${size} primer mismatch en ${mismatch}`);
    }
});

test('parse: streaming byte a byte con header y coma decimal partidas', async () => {
    const text = 'X;Y;Z\n10,25;20,25;30,75\n';
    const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
    const result = await importer.parse(chunker(bytes, 1), {}, null);
    assert.equal(result.stats.headerSkipped, 1);
    assert.equal(result.stats.points, 1);
    assert.equal(result.stats.decimalComma, true);
    assert.equal(result.origin.x, 10);
    assert.equal(result.origin.y, 20);
    assert.equal(result.origin.z, 30);
});

test('parse: onProgress con totalBytes avanza 0..1 y termina exacto', async () => {
    const text = '5101234.5,6301234.5,812.3\n5101235.5,6301236.5,814.7\n';
    const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
    const prog = [];
    await importer.parse(chunker(bytes, 20), { totalBytes: bytes.length }, (p) => prog.push(p));
    assert.ok(prog[0] > 0 && prog[0] < 1, `primera fraccion ${prog[0]}`);
    assert.equal(prog[prog.length - 1], 1);
});

test('parse: sub-milimetro preservado (Float64 antes de restar origen)', async () => {
    const result = await parseText('6301237.123456 4600123.654321 310.876543\n');
    assert.equal(result.origin.x, 6301237);
    assert.ok(Math.abs(result.positions[0] - 0.123456) < 1e-3, `x local ${result.positions[0]}`);
    assert.ok(Math.abs(result.positions[1] - 0.654321) < 1e-3);
    assert.ok(Math.abs(result.positions[2] - 0.876543) < 1e-3);
});

test('parse: positions es vista tipada de longitud 3 * points', async () => {
    const result = await parseText('1 2 3\n4 5 6\n');
    assert.ok(ArrayBuffer.isView(result.positions));
    assert.equal(result.positions.constructor.name, 'Float32Array');
    assert.equal(result.positions.length, 3 * result.stats.points);
});

test('RB: rendimiento 1.000.000 de puntos < 10 s', async () => {
    const lines = new Array(1000000);
    for (let i = 0; i < lines.length; i += 1) {
        const x = 5100000.25 + (i % 1000) * 0.5;
        const y = 6300000.75 + Math.floor(i / 1000) * 0.5;
        const z = 300 + (i % 50) * 1.25;
        lines[i] = `${x} ${y} ${z}`;
    }
    const buffer = Buffer.from(lines.join('\n'), 'utf8');
    const sizeMb = buffer.length / (1024 * 1024);
    const bytes = new Uint8Array(buffer);
    const t0 = performance.now();
    const result = await importer.parse(chunker(bytes, 1 << 16), { totalBytes: bytes.length }, null);
    const dtMs = performance.now() - t0;
    const mbps = sizeMb / (dtMs / 1000);
    console.log(`rendimiento: ${sizeMb.toFixed(1)} MB en ${(dtMs / 1000).toFixed(2)} s => ${mbps.toFixed(0)} MB/s`);
    assert.equal(result.stats.points, 1000000);
    assert.ok(dtMs / 1000 < 10, `demasiado lento: ${dtMs} ms para ${sizeMb.toFixed(1)} MB`);
});
