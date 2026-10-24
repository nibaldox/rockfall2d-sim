'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// The namespace must be created on globalThis so the classic scripts
// attach to whatever global object each runtime provides.

test('terrain + physics attach to SimRocas in a Web Worker environment', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { env: 'worker' });
    assert.strictEqual(typeof ctx.SimRocas.Terrain, 'function');
    assert.strictEqual(typeof ctx.SimRocas.Rock, 'function');
    assert.strictEqual(typeof ctx.SimRocas.PhysicsEngine, 'function');
});

test('terrain + physics attach to SimRocas in a browser environment', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { env: 'browser' });
    assert.strictEqual(typeof ctx.SimRocas.Terrain, 'function');
    assert.strictEqual(typeof ctx.SimRocas.Rock, 'function');
    assert.strictEqual(typeof ctx.SimRocas.PhysicsEngine, 'function');
});

test('terrain + physics attach to SimRocas in a plain Node environment', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { env: 'node' });
    assert.strictEqual(typeof ctx.SimRocas.Terrain, 'function');
    assert.strictEqual(typeof ctx.SimRocas.Rock, 'function');
    assert.strictEqual(typeof ctx.SimRocas.PhysicsEngine, 'function');
});

test('terrain + stl share the same namespace in a Web Worker environment', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/stl.js'], { env: 'worker' });
    assert.strictEqual(typeof ctx.SimRocas.Terrain, 'function');
    assert.strictEqual(typeof ctx.SimRocas.StlParser, 'function');
});
