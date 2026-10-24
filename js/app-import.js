/**
 * SimRocas — App: panel de importación de terreno 3D (DEM) (T3.6).
 * Mixin sobre SimRocas.App.prototype; se carga después de js/app.js.
 * Usa js/workers/import-worker.js (protocolo C5); no comparte globales
 * con el importador STL 2.5D (app-stl.js).
 */
(function (SimRocas) {
    'use strict';

    // Versión de cache-busting del worker de importación (obligatoria al
    // construir el Worker; expuesta vía SimRocas para verificación).
    const IMPORT_WORKER_VERSION = 3;

    // Etiquetas en español de las fases del worker.
    const PHASE_LABELS = {
        read: 'Leyendo',
        parse: 'Interpretando',
        raster: 'Generando DEM',
        mesh: 'Generando malla'
    };

    Object.assign(SimRocas.App.prototype, {
        /** Registra los controles del panel 'Topografía 3D (DEM)'. */
        setup3dImportControls() {
            this.dem3d = null;
            this.dem3dInfo = null;
            this.demColorMode = 'elevation';
            this.demExaggeration = 1;
            this._import3dWorker = null;
            this._import3dActive = false;

            const fileInput = document.getElementById('dem-file-input');
            const cancelBtn = document.getElementById('btn-dem-cancel');
            const colorElev = document.getElementById('btn-dem-color-elevation');
            const colorSlope = document.getElementById('btn-dem-color-slope');
            const exag1 = document.getElementById('btn-dem-exag1');
            const exag2 = document.getElementById('btn-dem-exag2');
            const exag3 = document.getElementById('btn-dem-exag3');
            if (!fileInput) { return; }

            // Importar al elegir archivo (cancela una importación en curso).
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                fileInput.value = ''; // permite reimportar el mismo archivo.
                if (!file) { return; }
                this._start3dImport(file);
            });

            if (cancelBtn) { cancelBtn.addEventListener('click', () => this._cancel3dImport(false)); }
            if (colorElev) { colorElev.addEventListener('click', () => this._apply3dColorMode('elevation')); }
            if (colorSlope) { colorSlope.addEventListener('click', () => this._apply3dColorMode('slope')); }

            const setExag = (k) => {
                this.demExaggeration = k;
                [exag1, exag2, exag3].forEach((b) => {
                    if (b) { b.classList.toggle('active', b === (k === 1 ? exag1 : k === 2 ? exag2 : exag3)); }
                });
                if (this.viewer3d) { this.viewer3d.setVerticalExaggeration(k); }
            };
            if (exag1) { exag1.addEventListener('click', () => setExag(1)); }
            if (exag2) { exag2.addEventListener('click', () => setExag(2)); }
            if (exag3) { exag3.addEventListener('click', () => setExag(3)); }
        },

        /**
         * Arranca una importación en el worker (una a la vez; otra
         * selección cancela la anterior vía terminate()).
         * @param {File} file
         */
        _start3dImport(file) {
            if (!file) { return; }
            // Supersesión: si hay una importación en curso, terminar.
            if (this._import3dWorker) {
                try { this._import3dWorker.terminate(); } catch (e) { /* noop */ }
                this._import3dWorker = null;
            }
            this._import3dActive = true;

            const options = {
                cellSize: this._parse3dCellSize(),
                upAxis: this._value3d('dem-up-axis', 'Z'),
                pointMode: this._value3d('dem-point-mode', 'mean'),
                maxDisplayTriangles: 2000000,
                maxCells: 25000000
            };

            let worker;
            try {
                worker = new Worker('js/workers/import-worker.js?v=' + IMPORT_WORKER_VERSION);
            } catch (err) {
                this._import3dActive = false;
                this._show3dError('No se pudo iniciar el importador: ' + err.message);
                return;
            }
            this._import3dWorker = worker;

            worker.onmessage = (ev) => {
                const msg = ev.data;
                if (!msg || !msg.type) { return; }
                if (msg.type === 'progress') {
                    this._update3dProgress(msg.phase, msg.progress);
                } else if (msg.type === 'done') {
                    this._import3dActive = false;
                    worker.terminate();
                    this._import3dWorker = null;
                    this._finish3dImport(msg);
                } else if (msg.type === 'error') {
                    this._import3dActive = false;
                    worker.terminate();
                    this._import3dWorker = null;
                    this._show3dProgress(false);
                    this._show3dError(msg.message || 'Error desconocido en la importación.');
                }
            };
            worker.onerror = (event) => {
                this._import3dActive = false;
                try { worker.terminate(); } catch (e) { /* noop */ }
                this._import3dWorker = null;
                this._show3dProgress(false);
                this._show3dError(event.message || 'Error en el worker de importación.');
            };

            this._clear3dError();
            this._hide3dImportPanels();
            this._show3dProgress(true);
            this._update3dProgress('read', 0);
            worker.postMessage({ type: 'import', file: file, options: options });
        },

        /**
         * Cancela la importación en curso (terminate del worker).
         * @param {boolean} quiet true si es supersesión por otra importación.
         */
        _cancel3dImport(quiet) {
            if (this._import3dWorker) {
                try { this._import3dWorker.terminate(); } catch (e) { /* noop */ }
                this._import3dWorker = null;
            }
            this._import3dActive = false;
            this._show3dProgress(false);
            if (!quiet) {
                this._clear3dError();
                this._show3dError('Importación cancelada.');
            }
        },

        /** Termina una importación exitosa: construye Dem, malla e info. */
        _finish3dImport(msg) {
            try {
                this.dem3d = SimRocas.Dem.fromTransferable(msg.dem);
                this.dem3dInfo = msg.info || null;
                this.demDisplayMesh = msg.displayMesh || null;
                if (!this.demDisplayMesh) {
                    throw new Error('el worker no devolvió una malla de visualización');
                }
                this.demMesh3d = SimRocas.TerrainMesh3D.build(this.demDisplayMesh, {
                    colorMode: this.demColorMode
                });
                // El displayMesh del worker viaja sin bounds (contracto: sólo
                // positions/indices/stride); para fitToBounds se calculan los
                // bounds LOCALES de los vértices (mismo sistema de la escena
                // 3D), con fallback a los bounds del Dem (ignorando NaN).
                if (!this.demMesh3d.userData.bounds) {
                    const b = this._localBoundsFromDisplay(this.demDisplayMesh) || this.dem3d.bounds();
                    this.demMesh3d.userData.bounds = b;
                }
                this._show3dProgress(false);
                this._render3dInfo();
                this._render3dWarnings((msg.info && msg.info.warnings) || []);
                // T3.5/T3.7: con DEM cargado se habilita el trazado de perfil
                // (y, por defecto, se ofrece el intervalo 'bonito' de curvas).
                if (typeof this._updateProfile3dPanel === 'function') {
                    this._updateProfile3dPanel();
                    const input = document.getElementById('dem-contour-interval');
                    if (input && this.dem3d) {
                        try {
                            input.value = String(SimRocas.PlanView.autoInterval(this.dem3d));
                        } catch (e2) { /* PlanView no disponible: dejar como está */ }
                    }
                }
                if (this.viewer3d) {
                    this.viewer3d.setTerrain(this.demMesh3d, {
                        colorMode: this.demColorMode,
                        exaggeration: this.demExaggeration,
                        fit: true
                    });
                }
                this._show3dErrorState(null);
            } catch (err) {
                this._show3dError('Error al construir el terreno 3D: ' + err.message);
            }
        },

        /* ------------------------------------------------------- helpers UI */

        /**
         * Bounds locales {minX..maxZ} de la malla de visualización (una
         * pasada por los vértices); null si no hay vértices finitos.
         * @param {{positions: Float32Array}} displayMesh
         * @returns {object|null}
         */
        _localBoundsFromDisplay(displayMesh) {
            if (!displayMesh || !(displayMesh.positions instanceof Float32Array)) {
                return null;
            }
            const p = displayMesh.positions;
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;
            for (let v = 0; v < p.length; v += 3) {
                const x = p[v];
                const y = p[v + 1];
                const z = p[v + 2];
                if (x < minX) { minX = x; }
                if (x > maxX) { maxX = x; }
                if (y < minY) { minY = y; }
                if (y > maxY) { maxY = y; }
                if (z < minZ) { minZ = z; }
                if (z > maxZ) { maxZ = z; }
            }
            if (!Number.isFinite(minX + maxX + minY + maxY + minZ + maxZ)) {
                return null;
            }
            return { minX, maxX, minY, maxY, minZ, maxZ };
        },

        _value3d(id, fallback) {
            const el = document.getElementById(id);
            return (el && el.value) ? el.value : fallback;
        },

        _parse3dCellSize() {
            const raw = this._value3d('dem-cell-size', '');
            const n = parseFloat(raw);
            return (Number.isFinite(n) && n > 0) ? n : null;
        },

        _show3dProgress(show) {
            const p = document.getElementById('dem-progress');
            if (p) { p.style.display = show ? 'block' : 'none'; }
        },

        _update3dProgress(phase, progress) {
            const f = Math.min(1, Math.max(0, Number(progress) || 0));
            const label = document.getElementById('dem-progress-label');
            const fill = document.getElementById('dem-progress-fill');
            if (label) {
                const name = PHASE_LABELS[phase] || 'Procesando';
                label.textContent = name + '… ' + Math.round(f * 100) + '%';
            }
            if (fill) { fill.style.width = Math.round(f * 100) + '%'; }
        },

        _hide3dImportPanels() {
            const info = document.getElementById('dem-info');
            const warn = document.getElementById('dem-warnings');
            const view = document.getElementById('dem-view-controls');
            if (info) { info.style.display = 'none'; }
            if (warn) { warn.style.display = 'none'; }
            if (view) { view.style.display = 'none'; }
        },

        /** Muestra info (formato, archivo, tamaño, celdas, resolución, ...). */
        _render3dInfo() {
            const wrap = document.getElementById('dem-info');
            if (!wrap || !this.dem3dInfo) { return; }
            const inf = this.dem3dInfo;
            const put = (id, text) => {
                const el = document.getElementById(id);
                if (el) { el.textContent = text; }
            };
            put('dem-fmt', inf.format || '-');
            put('dem-file', inf.fileName || '-');
            put('dem-size', inf.fileBytes ? (inf.fileBytes / (1024 * 1024)).toFixed(2) + ' MB' : '-');
            put('dem-cells', String(inf.cols) + ' × ' + String(inf.rows));
            put('dem-res', inf.cellSize ? Number(inf.cellSize).toLocaleString('es') + ' m' : '-');
            put('dem-valid', Number.isFinite(inf.validFraction)
                ? Math.round(100 * inf.validFraction) + ' %' : '-');
            if (inf.bounds) {
                put('dem-extent',
                    (inf.bounds.maxX - inf.bounds.minX).toFixed(0) + ' × ' +
                    (inf.bounds.maxY - inf.bounds.minY).toFixed(0) + ' m');
            } else {
                put('dem-extent', '-');
            }
            put('dem-crs', inf.crs || '-');
            wrap.style.display = 'block';
            const view = document.getElementById('dem-view-controls');
            if (view) { view.style.display = 'flex'; }
            this._apply3dColorMode(this.demColorMode);
        },

        /** Lista de advertencias del worker (estilo --warning/--danger). */
        _render3dWarnings(warnings) {
            const wrap = document.getElementById('dem-warning-list');
            const box = document.getElementById('dem-warnings');
            if (!box) { return; }
            if (!wrap) { return; }
            wrap.innerHTML = '';
            if (!warnings || warnings.length === 0) {
                box.style.display = 'none';
                return;
            }
            for (const w of warnings) {
                const li = document.createElement('li');
                li.textContent = typeof w === 'string' ? w : String(w.message || JSON.stringify(w));
                wrap.appendChild(li);
            }
            box.style.display = 'block';
        },

        /** Cambia el modo de color de la malla (in place) y los botones. */
        _apply3dColorMode(mode) {
            if (!this.demMesh3d || (mode !== 'elevation' && mode !== 'slope')) { return; }
            this.demColorMode = mode;
            try {
                SimRocas.TerrainMesh3D.setColorMode(this.demMesh3d, mode);
            } catch (err) { console.error(err); }
            const e = document.getElementById('btn-dem-color-elevation');
            const s = document.getElementById('btn-dem-color-slope');
            if (e) { e.classList.toggle('active', mode === 'elevation'); }
            if (s) { s.classList.toggle('active', mode === 'slope'); }
            if (this.viewer3d) { this.viewer3d.requestRender(); }
        },

        /** Mensaje de error en el panel (no bloqueante, sin alert). */
        _show3dErrorState(msg) {
            const el = document.getElementById('dem-error');
            if (!el) { return; }
            if (!msg) {
                el.style.display = 'none';
                el.textContent = '';
                return;
            }
            el.textContent = msg;
            el.style.display = 'block';
        },

        _clear3dError() { this._show3dErrorState(null); },

        _show3dError(msg) {
            this._show3dProgress(false);
            this._show3dErrorState(msg);
        }
    });

    // Público (namespace, no window) para verificación en tests/smoke.
    SimRocas.IMPORT_WORKER_VERSION = IMPORT_WORKER_VERSION;
})(globalThis.SimRocas);

// Los mixins se cargan tras app.js: su listener DOMContentLoaded corre
// después del de app.js, cuando `window.app` ya está instanciado.
document.addEventListener('DOMContentLoaded', () => {
    if (typeof window !== 'undefined' && window.app && typeof window.app.setup3dImportControls === 'function') {
        window.app.setup3dImportControls();
    }
});
