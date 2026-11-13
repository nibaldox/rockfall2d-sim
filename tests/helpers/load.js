'use strict';

/**
 * Headless loader for SimRocas classic scripts.
 *
 * loadScripts(files, { env, seed, extra })
 *   files: paths relative to the repository root, loaded in order
 *   env:   'browser' (window = self = sandbox), 'worker' (self only), 'node' (neither)
 *   seed:  integer -> Math.random replaced by a deterministic mulberry32 PRNG
 *   extra: additional globals for the sandbox
 * Returns the vm context (its globals, e.g. ctx.SimRocas).
 *
 * createContext(options) + runScript(context, file) are the two halves of
 * loadScripts, for tests that must define globals depending on the context
 * itself (e.g. an importScripts shim that loads files into the same context).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

const MULBERRY32 = `(function (seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
})`;

function createContext({ env = 'browser', seed = null, extra = {} } = {}) {
    const sandbox = { console, performance, ...extra };
    if (env === 'browser') {
        sandbox.window = sandbox;
        sandbox.self = sandbox;
    } else if (env === 'worker') {
        sandbox.self = sandbox;
    }
    const context = vm.createContext(sandbox);
    if (seed !== null) {
        vm.runInContext(`Math.random = ${MULBERRY32}(${seed});`, context);
    }
    return context;
}

function runScript(context, file) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
}

function loadScripts(files, options = {}) {
    const context = createContext(options);
    for (const file of files) {
        runScript(context, file);
    }
    return context;
}

module.exports = { ROOT, loadScripts, createContext, runScript };
