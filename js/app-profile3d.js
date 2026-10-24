/**
 * SimRocas — App: trazado de perfil sobre el terreno 3D y envío al modo 2D
 * (T3.5), vista en planta y curvas de nivel (T3.7).
 * Mixin sobre SimRocas.App.prototype; se carga después de js/app.js.
 *
 * Requiere (index.html, en este orden): js/dem.js, js/view3d-profile.js,
 * js/view3d-plan.js, js/stl.js (StlSlicer.compileProfile / StlContour),
 * js/view3d.js, js/app-modes.js y js/app-import.js (hook _updateProfile3dPanel).
 *
 * GANCHO DE AUTOMATIZACIÓN (documentado, ejecutable desde la consola o el
 * smoke headless, sin depender de coordenadas de pantalla):
 *   - app.profile3dAddLocalPoint(x, y)  agrega un vértice (coordenadas LOCALES
 *     del DEM; la cota se toma de dem.heightAt → NaN ⇒ vértice rechazado).
 *   - app.profile3dFinish()             cierra el trazado (equivale a doble
 *     clic o al botón 'Terminar').
 * Los clics reales del usuario también agregan vértices (raycast contra la
 * malla; z_local = z_escena / exageración).
 */
(function (SimRocas) {
    'use strict';

    // Umbral (px) para distinguir un clic de un arrastre de OrbitControls.
    const CLICK_MAX_DRAG_PX = 6;

    Object.assign(SimRocas.App.prototype, {
        setupProfile3dControls() {
            this.profile3dActive = false;
            this.profile3dPoints = [];      // vértices locales [{x, y, z}]
            this.profileSection = null;     // metadatos de la última sección
            this._profile3dDown = null;     // pointerdown para filtrar drags
            this._profile3dKeyHandler = null;

            const container = document.getElementById('view3d-container');
            if (container) {
                // Los eventos del canvas (creado perezosamente) burbujean al
                // container: un único listener alcanza aunque el viewer cambie.
                container.addEventListener('pointerdown', (e) => {
                    this._profile3dDown = { x: e.clientX, y: e.clientY, t: Date.now() };
                });
                container.addEventListener('click', (e) => {
                    this._profile3dOnContainerClick(e);
                });
                container.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    this.profile3dFinish();
                });
            }

            const on = (id, fn) => {
                const el = document.getElementById(id);
                if (el) { el.addEventListener('click', fn); }
            };
            on('btn-dem-profile-draw', () => this.profile3dStartDrawing());
            on('btn-dem-profile-finish', () => this.profile3dFinish());
            on('btn-dem-profile-undo', () => this.profile3dUndoVertex());
            on('btn-dem-profile-cancel', () => this.profile3dCancelProfile());
            on('btn-dem-profile-send', () => this.profile3dSendTo2d());
            on('btn-dem-profile-clear', () => this.profile3dClearSection());

            const interval = document.getElementById('dem-contour-interval');
            if (interval) {
                interval.addEventListener('change', () => this._renderContours());
            }
            const contoursToggle = document.getElementById('dem-contours-toggle');
            if (contoursToggle) {
                contoursToggle.addEventListener('change', () => {
                    const overlay = document.getElementById('view3d-contours-check');
                    if (overlay) { overlay.checked = contoursToggle.checked; }
                    this._renderContours();
                });
            }
            const contoursOverlay = document.getElementById('view3d-contours-check');
            if (contoursOverlay) {
                contoursOverlay.addEventListener('change', () => {
                    const side = document.getElementById('dem-contours-toggle');
                    if (side) { side.checked = contoursOverlay.checked; }
                    this._renderContours();
                });
            }
            const planBtn = document.getElementById('btn-view3d-plan');
            if (planBtn) {
                planBtn.addEventListener('click', () => this.togglePlanView());
            }

            // Esc cancela el trazado.
            this._profile3dKeyHandler = (e) => {
                if (e.key === 'Escape' && this.profile3dActive) {
                    this.profile3dCancelProfile();
                }
            };
            document.addEventListener('keydown', this._profile3dKeyHandler);

            this._updateProfile3dPanel();
        },

        /* ------------------------------------------------------ trazado T3.5 */

        /**
         * Clic sobre el visor 3D: agrega un vértice si no fue un arrastre.
         * @private
         */
        _profile3dOnContainerClick(e) {
            if (!this.profile3dActive) { return; }
            const down = this._profile3dDown;
            if (down && Date.now() - down.t < 1500) {
                const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
                if (moved > CLICK_MAX_DRAG_PX) { return; }
            }
            const viewer = this.get3dViewer();
            if (!viewer) { return; }
            const hit = viewer.pickTerrainLocal(e.clientX, e.clientY);
            if (!hit) {
                this._showProfile3dStatus('Clic fuera del terreno.', true);
                return;
            }
            this._showProfile3dStatus('', false);
            this.profile3dAddLocalPoint(hit.x, hit.y, hit.z);
        },

        /**
         * Inicia el trazado de un perfil (sólo con DEM cargado).
         */
        profile3dStartDrawing() {
            if (!this.dem3d) {
                this._showProfile3dStatus('Importa un terreno DEM primero.', true);
                return;
            }
            this.profile3dActive = true;
            this.profile3dPoints = [];
            this._updateProfile3dPanel();
            this._profile3dUpdateInfo();
            this._showProfile3dStatus('Trazando: haz clic sobre el terreno. Doble clic o Terminar cierran; Esc cancela.', false);
            this._syncProfile3dOverlay();
        },

        /**
         * Agrega un vértice en coordenadas LOCALES del DEM (gancho de
         * automatización/documentado). `zLocal` opcional: si no se da, se
         * toma de dem.heightAt(x, y) (NaN ⇒ vértice inválido, se ignora).
         * Duplicados contiguos (<= 1 cm de distancia) se descartan.
         * @param {number} x
         * @param {number} y
         * @param {number} [zLocal]
         */
        profile3dAddLocalPoint(x, y, zLocal) {
            if (!this.dem3d) { return; }
            if (!this.profile3dActive) { this.profile3dActive = true; }
            const dem = this.dem3d;
            let z = zLocal;
            if (!Number.isFinite(z)) {
                z = dem.heightAt(x, y);
            }
            if (!Number.isFinite(z)) {
                this._showProfile3dStatus('Sin datos (NaN) en (' +
                    x.toFixed(1) + ', ' + y.toFixed(1) + '); vértice ignorado.', true);
                return;
            }
            const prev = this.profile3dPoints[this.profile3dPoints.length - 1];
            if (prev && Math.hypot(prev.x - x, prev.y - y) < 0.01) { return; }
            this.profile3dPoints.push({ x: x, y: y, z: z });
            this._syncProfile3dOverlay();
            this._profile3dUpdateInfo();
        },

        /** Deshace el último vértice trazado. */
        profile3dUndoVertex() {
            if (!this.profile3dPoints.length) { return; }
            this.profile3dPoints.pop();
            if (this.profile3dPoints.length === 0) {
                this.profile3dActive = true; // sigue trazando sin línea
            }
            this._syncProfile3dOverlay();
            this._profile3dUpdateInfo();
        },

        /**
         * Termina el trazado (doble clic o botón 'Terminar'): la polilínea
         * queda visible en color de trazado hasta que se envía o se borra.
         */
        profile3dFinish() {
            if (!this.profile3dActive) { return; }
            // Doble clic suele duplicar el último vértice: colapso contiguos.
            const pts = this.profile3dPoints;
            if (pts.length >= 2 &&
                Math.hypot(pts[pts.length - 1].x - pts[pts.length - 2].x,
                    pts[pts.length - 1].y - pts[pts.length - 2].y) < 0.01) {
                pts.pop();
            }
            this.profile3dActive = false;
            if (pts.length < 2) {
                this._showProfile3dStatus('Perfil vacío: se necesitan al menos 2 vértices.', pts.length > 0);
            } else {
                this._showProfile3dStatus('Trazado de ' + pts.length + ' vértices. Pulsa "Enviar a Perfil 2D".', false);
            }
            this._updateProfile3dPanel();
            this._syncProfile3dOverlay();
            this._profile3dUpdateInfo();
        },

        /** Esc/Cancelar: descarta la polilínea en trazado (la sección queda). */
        profile3dCancelProfile() {
            this.profile3dActive = false;
            this.profile3dPoints = [];
            this._showProfile3dStatus('Trazado cancelado.', false);
            this._updateProfile3dPanel();
            this._syncProfile3dOverlay();
            this._profile3dUpdateInfo();
        },

        /* ------------------------------------------------- envío a 2D (T3.5) */

        /**
         * Muestrea el DEM sobre la polilínea trazada, reduce con
         * StlSlicer.compileProfile y carga el perfil en el modo 2D con los
         * mismos pasos de app-stl.js; guarda this.profileSection y vuelve
         * al modo 2D.
         */
        profile3dSendTo2d() {
            const dem = this.dem3d;
            const pts = this.profile3dPoints;
            if (!dem || pts.length < 2) {
                this._showProfile3dStatus('Traza una polilínea (≥ 2 vértices) antes de enviar.', true);
                return;
            }
            const nSelect = document.getElementById('dem-profile-points');
            const target = parseInt((nSelect && nSelect.value) || '100', 10);

            const sampled = SimRocas.ProfileFromDem.sample(dem,
                pts.map((p) => ({ x: p.x, y: p.y })), dem.cellSize);
            const wrapped = document.getElementById('dem-profile-warning');
            if (wrapped) {
                wrapped.style.display = sampled.truncated ? 'block' : 'none';
                if (sampled.truncated) {
                    wrapped.textContent = 'perfil truncado en el primer hueco de datos (NaN): longitud válida ' +
                        sampled.validLength.toFixed(1) + ' m';
                }
            }
            if (sampled.points.length < 2 || sampled.validLength <= 0) {
                this._showProfile3dStatus('No hay datos del DEM a lo largo del tramo trazado. Ajusta la polilínea (la advertencia indica el corte por huecos).', true);
                return;
            }
            // Reducción: mismo compilador del slicer STL ({d, z} → {x, y}) para
            // repartir N distancias uniformes en el rango válido. Su horquilla
            // binaria toma el MÁXIMO por bin (safety envelope para mallas STL);
            // para el trazado sobre DEM se restituye la cota EXACTA
            // interpolada de ProfileFromDem en la distancia conservada, para que
            // el perfil 2D coincida con el DEM dentro de ±0.05 m.
            const reduced = SimRocas.StlSlicer.compileProfile(
                sampled.points.map((p) => ({ d: p.x, z: p.y })),
                sampled.validLength, target);
            const sam = sampled.points;
            for (const p of reduced) {
                if (p.x <= sam[0].x) { p.y = sam[0].y; continue; }
                for (let i = 1; i < sam.length; i++) {
                    if (p.x <= sam[i].x) {
                        const t = (p.x - sam[i - 1].x) / (sam[i].x - sam[i - 1].x);
                        p.y = sam[i - 1].y + t * (sam[i].y - sam[i - 1].y);
                        break;
                    }
                }
                if (sam.length && p.x > sam[sam.length - 1].x) {
                    p.y = sam[sam.length - 1].y;
                }
            }

            this.terrain.setPoints(reduced);
            this.resetSimulation();

            // Corrección T3.5/T4.6: el punto de liberación debe quedar sobre
            // el terreno del perfil NUEVO (x0 + 2 % de la longitud; cota + 5 m
            // en caída libre). Antes conservaba las coordenadas del perfil
            // anterior y la roca quedaba por debajo del terreno.
            if (typeof this._syncReleaseAfterProfile === 'function') {
                this._syncReleaseAfterProfile(reduced);
            }

            const demo = { x: dem.originX, y: dem.originY, z: dem.originZ };
            this.profileSection = {
                polylineLocal: pts.map((p) => ({ x: p.x, y: p.y })),
                polylineWorld: pts.map((p) => {
                    const w = dem.localToWorld(p.x, p.y, p.z);
                    return { x: w.x, y: w.y, z: w.z };
                }),
                azimuthDeg: SimRocas.ProfileFromDem.azimuthDeg(
                    pts.map((p) => ({ x: p.x, y: p.y }))),
                length: SimRocas.ProfileFromDem.polylineLength(
                    pts.map((p) => ({ x: p.x, y: p.y }))),
                demOrigin: demo,
                spacing: dem.cellSize,
                targetPoints: target,
                validLength: sampled.validLength,
                truncated: sampled.truncated
            };

            // La sección queda visible (color distinto) y el trazado se retira.
            const viewer = this.get3dViewer();
            if (viewer) {
                viewer.setSectionLine(this.profile3dPoints);
                viewer.clearProfilePolyline();
            }

            // Cambio al modo 2D con los pasos de app-stl.js.
            this.setDisplayMode('2d');
            this.renderer.autoScale();
            this.updateTerrainInfo();
            this.updateSegmentsList();
            this.render();
            this._showProfile3dStatus('Perfil 2D generado con ' + reduced.length +
                ' puntos (longitud ' + sampled.validLength.toFixed(1) + ' m).', false);
            this._updateProfile3dPanel();
        },

        /** Borra la línea de sección de la escena 3D. */
        profile3dClearSection() {
            const viewer = this.get3dViewer();
            if (viewer) {
                viewer.clearSectionLine();
                viewer.clearProfilePolyline();
            }
            this.profileSection = null;
            this._showProfile3dStatus('Línea de sección borrada.', false);
            this._updateProfile3dPanel();
        },

        /* -------------------------------------------------- vista en planta T3.7 */

        /** Conmuta cámara cenital / 3D ordinaria. */
        togglePlanView() {
            const viewer = this.get3dViewer();
            if (!viewer) { return false; }
            const on = !viewer.isTopView;
            viewer.setTopView(on);
            const btn = document.getElementById('btn-view3d-plan');
            if (btn) {
                btn.classList.toggle('active', on);
                btn.textContent = on ? 'Vista 3D' : 'Vista en planta';
            }
            this._renderContours();
            return on;
        },

        /** ¿Deben mostrarse las curvas de nivel? (casilla(s) o vista en planta) */
        _contoursWanted(viewer) {
            const side = document.getElementById('dem-contours-toggle');
            const overlay = document.getElementById('view3d-contours-check');
            return !!(side && side.checked) || !!(overlay && overlay.checked) ||
                (!!viewer && !!viewer.isTopView);
        },

        /** Genera/actualiza las curvas de nivel según la casilla e intervalo. */
        _renderContours() {
            const viewer = this.get3dViewer();
            if (!viewer) { return; }
            const want = this._contoursWanted(viewer);
            if (!want || !this.dem3d) {
                viewer.clearContourLines();
                return;
            }
            const input = document.getElementById('dem-contour-interval');
            let interval = input ? parseFloat(input.value) : NaN;
            if (!Number.isFinite(interval) || interval <= 0) {
                interval = SimRocas.PlanView.autoInterval(this.dem3d);
                if (input) { input.value = String(interval); }
            }
            const contours = SimRocas.PlanView.buildContoursFromDem(this.dem3d, interval);
            // Elevación local ~ relief/125: por encima del ruido de la malla
            // (bilineal vs. triángulos) sin despegar visualmente.
            const lift = Math.max((this.dem3d.bounds().maxZ -
                this.dem3d.bounds().minZ) * 0.008, 0.2);
            viewer.setContourLines(SimRocas.PlanView.segmentPositions(this.dem3d, contours, lift));
        },

        /* -------------------------------------------------------------- UI */

        /** Habilita/deshabilita y muestra/oculta el bloque de perfil/planta. */
        _updateProfile3dPanel() {
            const hasDem = !!this.dem3d;
            const show = (id, yes) => {
                const el = document.getElementById(id);
                if (el) { el.style.display = yes ? 'block' : 'none'; }
            };
            show('dem-profile-controls', hasDem);
            show('dem-plan-controls', hasDem);
            const setDisabled = (id, dis) => {
                const el = document.getElementById(id);
                if (el) { el.disabled = dis; }
            };
            setDisabled('btn-dem-profile-draw', !hasDem);
            setDisabled('btn-dem-profile-undo', !hasDem || !this.profile3dPoints.length);
            setDisabled('btn-dem-profile-finish', !hasDem || !this.profile3dActive);
            setDisabled('btn-dem-profile-send', !hasDem || this.profile3dActive ||
                this.profile3dPoints.length < 2);
            setDisabled('btn-dem-profile-clear', !hasDem || !this.profileSection);
            const drawBtn = document.getElementById('btn-dem-profile-draw');
            if (drawBtn) { drawBtn.classList.toggle('active', !!this.profile3dActive); }
        },

        /** Redibuja la polilínea en trazado (THREE.Line + marcadores). */
        _syncProfile3dOverlay() {
            const viewer = this.get3dViewer();
            if (!viewer) { return; }
            viewer.setProfilePolyline(this.profile3dActive ? this.profile3dPoints : []);
            this._updateProfile3dPanel();
        },

        /** Longitud total y azimut del primer tramo en el panel. */
        _profile3dUpdateInfo() {
            const el = document.getElementById('dem-profile-info');
            if (!el) { return; }
            const pts = this.profile3dPoints.map((p) => ({ x: p.x, y: p.y }));
            if (pts.length < 2) {
                el.textContent = pts.length
                    ? '1 vértice — agrega al menos otro.'
                    : 'Sin vértices.';
                return;
            }
            const len = SimRocas.ProfileFromDem.polylineLength(pts);
            const az = SimRocas.ProfileFromDem.azimuthDeg(pts);
            const azTxt = Number.isFinite(az) ? az.toFixed(1) + '°' : '—';
            el.textContent = 'Longitud total: ' + len.toFixed(1) + ' m · Azimut 1er tramo: ' +
                azTxt + '(' + pts.length + ' vértices)';
        },

        /** Mensaje no bloqueante dentro del bloque de perfil. */
        _showProfile3dStatus(msg, isWarning) {
            const el = document.getElementById('dem-profile-status');
            if (!el) {
                if (msg) { console.log('[perfil 3D]', msg); }
                return;
            }
            el.textContent = msg || '';
            el.classList.toggle('dem-profile-status-warn', !!isWarning);
            el.style.display = msg ? 'block' : 'none';
        }
    });
})(globalThis.SimRocas);

// Los mixins se cargan tras app.js: en DOMContentLoaded `window.app` ya existe.
document.addEventListener('DOMContentLoaded', () => {
    if (typeof window !== 'undefined' && window.app &&
        typeof window.app.setupProfile3dControls === 'function') {
        window.app.setupProfile3dControls();
    }
});
