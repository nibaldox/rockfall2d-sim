'use strict';

/**
 * Test de lógica pura del conmutador de modo (T3.4): arranque en 2D,
 * persistencia de 'simrocas.mode' y tolerancia a valores inválidos.
 * Carga js/app-modes.js en un sandbox con un stub mínimo de SimRocas.App
 * (en la app real el mixin se instala sobre la App de js/app.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

// Stub mínimo del prototipo de App: el mixin sólo añade métodos (no toca
// controladores de la app real).
class AppStub { }

function loadWithStubs() {
    const store = new Map();
    const ctx = loadScripts(['js/app-modes.js'], {
        env: 'browser',
        extra: {
            document: { addEventListener() {} },
            localStorage: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: (k) => store.delete(k),
            },
            SimRocas: { App: AppStub },
        },
    });
    return { ctx, store, proto: ctx.SimRocas.App.prototype };
}

test('T3.4: los métodos del mixin de modo existen en SimRocas.App.prototype', () => {
    const { proto } = loadWithStubs();
    for (const m of ['setupModeControls', '_coerceDisplayMode', 'setDisplayMode', '_enterMode3d']) {
        assert.equal(typeof proto[m], 'function', 'falta ' + m);
    }
});

test('T3.4: setupModeControls arranca en 2D y guarda la elección en localStorage', () => {
    const { ctx, store, proto } = loadWithStubs();
    const app = Object.create(proto);
    app.renderer = { resize() {} };
    app.render = () => {};

    const buttons = {
        'mode-2d': {
            listeners: {},
            addEventListener(ev, fn) { this.listeners[ev] = fn; },
            classList: { toggle() {} },
            setAttribute() {},
        },
        'mode-3d': {
            listeners: {},
            addEventListener(ev, fn) { this.listeners[ev] = fn; },
            classList: { toggle() {} },
            setAttribute() {},
        },
    };
    ctx.document = {
        addEventListener() {},
        getElementById: (id) => buttons[id] || null,
        body: { classList: { toggle() {} } },
    };

    proto.setupModeControls.call(app);
    assert.equal(app.displayMode, '2d');
    buttons['mode-3d'].listeners.click();
    assert.equal(app.displayMode, '3d');
    assert.equal(store.get('simrocas.mode'), '3d');
});

test('T3.4: un valor de localStorage inválido no rompe el arranque (queda en 2D)', () => {
    const { ctx, store, proto } = loadWithStubs();
    const app = Object.create(proto);
    ctx.document = {
        addEventListener() {},
        getElementById: () => null,
        body: { classList: { toggle() {} } },
    };
    store.set('simrocas.mode', 'zzz');
    proto.setupModeControls.call(app);
    assert.equal(app.displayMode, '2d');
});

test('T3.4: con simrocas.mode = "3d" guardado, setupModeControls restaura el modo 3D', () => {
    const { ctx, proto } = loadWithStubs();
    const app = Object.create(proto);
    let bodyMode3d = null;
    ctx.document = {
        addEventListener() {},
        getElementById: () => null,
        body: { classList: { toggle(_cls, on) { bodyMode3d = !!on; } } },
    };
    ctx.localStorage.setItem('simrocas.mode', '3d');
    proto.setupModeControls.call(app);
    assert.equal(app.displayMode, '3d');
    assert.equal(bodyMode3d, true);
});
