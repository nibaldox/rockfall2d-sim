globalThis.SimRocas = globalThis.SimRocas || {};
/**
 * SimRocas — App: conmutador de modo Perfil 2D / Vista 3D (T3.4).
 * Mixin sobre SimRocas.App.prototype; se carga después de js/app.js.
 * La instalación en el DOM ocurre en DOMContentLoaded (éste listener se
 * registra en orden de carga, después del de app.js, así `window.app`
 * ya está instanciado). Los métodos existen desde la carga y son
 * cubiertos por tests/app.split.test.js.
 */
Object.assign(SimRocas.App.prototype, {
    /**
     * Valida el modo almacenado en localStorage o el valor entrante.
     * @param {string} value
     * @returns {'2d'|'3d'} modo normalizado ('2d' si es inválido).
     */
    _coerceDisplayMode(value) {
        return value === '3d' ? '3d' : '2d';
    },

    /**
     * Registra listeners del conmutador del header y restaura el último
     * modo recordado en localStorage 'simrocas.mode' (por defecto 2D).
     */
    setupModeControls() {
        this.displayMode = '2d';

        const btn2d = document.getElementById('mode-2d');
        const btn3d = document.getElementById('mode-3d');
        if (btn2d) btn2d.addEventListener('click', () => this.setDisplayMode('2d'));
        if (btn3d) btn3d.addEventListener('click', () => this.setDisplayMode('3d'));

        // Restaurar la última elección (si el usuario quedó en 3D).
        let stored = null;
        try { stored = localStorage.getItem('simrocas.mode'); } catch (e) { /* sin storage */ }
        if (this._coerceDisplayMode(stored) === '3d') {
            this.setDisplayMode('3d');
        }
    },

    /**
     * Cambia el modo de visualización: permuta las clases del body y los
     * botones del conmutador; recuerda la elección en localStorage.
     * El modo 3D (principal a futuro) se activa bajo demanda.
     * @param {'2d'|'3d'} mode
     */
    setDisplayMode(mode) {
        const m = this._coerceDisplayMode(mode);
        this.displayMode = m;

        const is3d = m === '3d';
        document.body.classList.toggle('mode-3d', is3d);

        const btn2d = document.getElementById('mode-2d');
        const btn3d = document.getElementById('mode-3d');
        if (btn2d) btn2d.classList.toggle('active', !is3d);
        if (btn3d) btn3d.classList.toggle('active', is3d);
        if (btn2d) btn2d.setAttribute('aria-pressed', String(!is3d));
        if (btn3d) btn3d.setAttribute('aria-pressed', String(is3d));

        try { localStorage.setItem('simrocas.mode', m); } catch (e) { /* sin storage */ }

        // UX: al entrar al modo 3D seleccionar la pestaña 'DEM 3D'; al volver
        // al 2D, la pestaña 'Perfil Terreno' (T3.7).
        if (typeof this._activateTab === 'function') {
            this._activateTab(is3d ? 'dem3d' : 'terrain');
        }

        if (is3d) {
            this._enterMode3d();
        } else {
            // El estado 2D se conserva intacto; sólo se restaura el layout.
            this.renderer.resize();
            this.render();
        }
    },

    /**
     * Entra al modo 3D: crea el Viewer3D de forma perezosa (la primera
     * vez), esperando THREE (importmap + three-bridge). Si ya había
     * terreno importado, lo vuelve a colocar en la escena.
     */
    async _enterMode3d() {
        if (this.viewer3d) {
            this.viewer3d.requestRender();
            return;
        }
        const container = document.getElementById('view3d-container');
        if (!container) { return; }
        try {
            await SimRocas.whenThreeReady();
        } catch (err) {
            console.error('No se pudo cargar Three.js:', err);
            return;
        }
        // El usuario pudo volver a 2D mientras esperábamos.
        if (this.displayMode !== '3d') { return; }
        if (this.viewer3d) { return; }
        this.viewer3d = new SimRocas.Viewer3D(container);
        if (this.demMesh3d) {
            this.viewer3d.setTerrain(this.demMesh3d, {
                colorMode: this.demColorMode || 'elevation',
                exaggeration: this.demExaggeration || 1,
                fit: true
            });
        }
    },

    /**
     * Cambia la pestaña principal del sidebar (como el listener de
     * setupTabs). Ignora 'results' (tiene lógica propia).
     * @param {string} name data-tab destino (terrain, dem3d, …).
     */
    _activateTab(name) {
        if (name === 'results') { return; }
        // Tolera docs de prueba sin querySelector (tests/app-modes.test.js).
        if (typeof document.querySelector !== 'function' ||
            typeof document.querySelectorAll !== 'function') { return; }
        const btn = document.querySelector('.tab[data-tab="' + name + '"]');
        const content = document.getElementById('tab-' + name);
        if (!btn || !content) { return; }
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        content.classList.add('active');
        if (this.renderer) { this.renderer.activeTab = name; }
    },

    /**
     * Devuelve el Viewer3D activo (o null si aún no se creó el modo 3D).
     * @returns {SimRocas.Viewer3D|null}
     */
    get3dViewer() {
        return this.viewer3d || null;
    }
});

// Los mixins se cargan tras app.js, por lo que este listener corre después
// del registro de app.js: en DOMContentLoaded `window.app` ya existe.
document.addEventListener('DOMContentLoaded', () => {
    if (typeof window !== 'undefined' && window.app && typeof window.app.setupModeControls === 'function') {
        window.app.setupModeControls();
    }
});
