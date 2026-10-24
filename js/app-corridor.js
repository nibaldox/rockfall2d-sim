'use strict';

/**
 * SimRocas — App: controles del corredor de trayectorias 3D (T4.7).
 * Mixin sobre SimRocas.App.prototype; se carga después de js/app.js.
 * Se conecta, si existen en el DOM, a:
 *   - #corridor-enabled   checkbox 'Mostrar trayectorias 3D en el perfil'
 *   - #corridor-halfwidth number, semiancho del corredor en m (defecto 10)
 *   - #corridor-info      estado para el usuario
 * Cuando hay perfil proveniente del 3D (this.profileSection) y resultados
 * 3D (this.sim3dResult?.rocks, o this.sim3dRocks como alternativa),
 * proyecta las trayectorias con SimRocas.ProfileCorridor.project() y las
 * dibuja en el perfil 2D via renderer.setCorridorOverlay(). Inocuo si no
 * hay datos (el checkbox queda sin efecto visible).
 */
(function () {
    const SimRocas = globalThis.SimRocas || (globalThis.SimRocas = {});

    Object.assign(SimRocas.App.prototype, {
        /**
         * Conecta los controles del corredor a updateCorridorOverlay().
         */
        setupCorridorControls() {
            this.corridorEnabled = this.corridorEnabled === true;
            this.corridorHalfWidth = 10;

            const checkbox = document.getElementById('corridor-enabled');
            const halfWidthInput = document.getElementById('corridor-halfwidth');
            if (!checkbox && !halfWidthInput) return;

            if (checkbox) {
                this.corridorEnabled = checkbox.checked === true;
                checkbox.addEventListener('change', () => {
                    this.corridorEnabled = checkbox.checked === true;
                    this.updateCorridorOverlay();
                });
            }
            if (halfWidthInput) {
                const readHalfWidth = () => {
                    const v = parseFloat(halfWidthInput.value);
                    this.corridorHalfWidth = (isFinite(v) && v > 0) ? v : 10;
                    return this.corridorHalfWidth;
                };
                readHalfWidth();
                halfWidthInput.addEventListener('input', () => {
                    readHalfWidth();
                    this.updateCorridorOverlay();
                });
                halfWidthInput.addEventListener('change', () => {
                    if (!(parseFloat(halfWidthInput.value) > 0)) {
                        halfWidthInput.value = String(this.corridorHalfWidth);
                    }
                    this.updateCorridorOverlay();
                });
            }
        },

        /**
         * Devuelve las rocas 3D disponibles para el overlay, o null.
         * @returns {Array|null}
         */
        _getCorridorRocks() {
            const fromResult = this.sim3dResult
                ? (this.sim3dResult.rocks || null)
                : null;
            if (Array.isArray(fromResult) && fromResult.length > 0) return fromResult;
            if (Array.isArray(this.sim3dRocks) && this.sim3dRocks.length > 0) return this.sim3dRocks;
            return null;
        },

        /**
         * Recalcula el overlay del corredor y lo dibuja en el perfil 2D.
         * Inocuo: sin perfil, sin rocas 3D, sin renderer o con el checkbox
         * desmarcado simplemente deja el overlay limpio.
         */
        updateCorridorOverlay() {
            const infoEl = document.getElementById('corridor-info');

            // Quitar el overlay si no hay nada que dibujar.
            if (!this.profileSection || !this.corridorEnabled) {
                if (this.renderer && typeof this.renderer.setCorridorOverlay === 'function') {
                    this.renderer.setCorridorOverlay(null);
                    if (typeof this.renderer.render === 'function') this.renderer.render();
                }
                if (infoEl) { infoEl.textContent = 'Mostrar trayectorias 3D en el perfil desactivado.'; }
                return;
            }

            const rocks = this._getCorridorRocks();
            if (!rocks || !this.renderer || typeof this.renderer.setCorridorOverlay !== 'function') {
                if (infoEl) { infoEl.textContent = 'Sin resultados 3D: ejecutá la simulación 3D para ver las trayectorias sobre el perfil.'; }
                return;
            }

            const result = SimRocas.ProfileCorridor.project(rocks, this.profileSection, {
                halfWidth: this.corridorHalfWidth
            });
            this.renderer.setCorridorOverlay(result, { colorBy: 'speed' });
            if (typeof this.renderer.render === 'function') this.renderer.render();

            if (infoEl) {
                const me = result.stats.maxEnergyKJ.toFixed(0);
                infoEl.textContent = result.count > 0
                    ? (result.count + ' de ' + result.total + ' rocas entran al corredor ±'
                        + result.halfWidth + ' m · ' + result.stops.length + ' detenciones · '
                        + 'P50 ' + result.stats.reachP50.toFixed(0) + ' m · '
                        + 'P95 ' + result.stats.reachP95.toFixed(0) + ' m · '
                        + 'Emáx ' + me + ' kJ')
                    : ('Ninguna de las ' + result.total + ' rocas pasa dentro del corredor ±'
                        + result.halfWidth + ' m.');
            }
        }
    });

    // Como js/app-modes.js: corre tras el listener de app.js, así window.app
    // ya está instanciado cuando llegan las conexiones del DOM.
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof window !== 'undefined' && window.app &&
            typeof window.app.setupCorridorControls === 'function') {
            window.app.setupCorridorControls();
        }
    });
})();
