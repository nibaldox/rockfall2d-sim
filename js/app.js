/**
 * Clamps a numeric value to a range, returning fallback if invalid.
 * @param {string|number} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
    const n = parseFloat(value);
    return (isNaN(n) || n < min || n > max) ? fallback : n;
}

/**
 * Resuelve la semilla de la corrida (P0.5). Campo vacío: sorteo de 32 bits
 * con crypto.getRandomValues, o Math.random como respaldo. Campo con valor:
 * solo dígitos decimales, entero en [0, 2^32 - 1].
 * @returns {number|null} la semilla, o null si el valor es inválido (ya avisado)
 */
function resolveRunSeed() {
    const input = document.getElementById('sim-seed');
    const text = input && input.value !== undefined && input.value !== null ? String(input.value).trim() : '';
    if (text === '') {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
            return crypto.getRandomValues(new Uint32Array(1))[0];
        }
        return Math.floor(Math.random() * 4294967296) >>> 0;
    }
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
        alert(`Semilla inválida («${text}»): debe ser un entero entre 0 y 4294967295, o quedar vacía para sortearla.`);
        return null;
    }
    return value;
}

// Muestra la semilla usada sin sobrescribir lo que escribió el usuario.
function showSeedUsed(seed) {
    const used = document.getElementById('seed-used');
    if (used) used.textContent = `Vacía = aleatoria; usada: ${seed}`;
    const input = document.getElementById('sim-seed');
    if (input) input.placeholder = `usada: ${seed}`;
}

/**
 * Copia del terreno en el momento de la captura por época: índice de tramo,
 * extremos en X, tipo, etiqueta del preset, cn, ct y rugosidad. Son primitivas
 * copiadas, así que editar el perfil después no altera lo ya publicado.
 */
// P1.1: material por rol del perfil banco–berma. Los presets de terrain.js no
// tienen «roca» ni «grava» genéricas: cara = 'roca-dura'; berma y plataforma =
// 'relleno' (el preset granular suelto, lo más cercano a grava); piso = 'suelo'.
const BENCH_ROLE_MATERIAL = { face: 'roca-dura', berm: 'relleno', platform: 'relleno', floor: 'suelo' };

// --- P1.1: perfil banco–berma, invalidación 6c y bloqueo en corrida ---

// true si hay una corrida en curso: la edición del perfil se ignora y se
// avisa en el estado.
function profileEditBlocked(app) {
    if (!(app.simulation && app.simulation.isRunning) && !app._workerActive) return false;
    const status = document.getElementById('simulation-status');
    if (status) status.textContent = 'Edición del perfil bloqueada durante la corrida; detén la simulación para editar';
    return true;
}

// Toda mutación del perfil (puntos, tramos o materiales) invalida los
// resultados y anula los metadatos banco–berma y su deshacer.
function profileChanged(app) {
    app._benchProfile = null;
    app._benchUndo = null;
    renderBenchMeta(null);
    app._invalidateResults();
}

function renderBenchMeta(benchMeta) {
    const table = document.getElementById('bench-meta-table');
    if (!table) return;
    if (!benchMeta || benchMeta.length === 0) {
        table.innerHTML = '';
        table.style.display = 'none';
        return;
    }
    const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const rows = benchMeta.map(b => `<tr><td>${b.index}</td><td>${n(b.crestX)}; ${n(b.crestY)}</td>` +
        `<td>${n(b.toeX)}; ${n(b.toeY)}</td><td>${n(b.height)}</td><td>${n(b.faceAngleDeg, 1)}</td>` +
        `<td>${n(b.effectiveWidth)}</td></tr>`).join('');
    table.innerHTML = '<thead><tr><th>Banco</th><th>Cresta X; Y (m)</th><th>Pata X; Y (m)</th>' +
        `<th>Altura (m)</th><th>Ángulo (°)</th><th>Berma (m)</th></tr></thead><tbody>${rows}</tbody>`;
    table.style.display = '';
}

// Deshace «Generar»: restaura el perfil, la fuente y el sentido previos.
function undoBenchProfile(app) {
    const undo = app._benchUndo;
    if (!undo) return false;
    app.terrain.clear();
    for (const p of undo.points) app.terrain.addPoint(p.x, p.y, app.selectedPresetType);
    app.terrain.segments = undo.segments.map(s => ({ ...s }));
    app.releasePoint.x = undo.release.x;
    app.releasePoint.y = undo.release.y;
    document.getElementById('release-x').value = undo.releaseX;
    document.getElementById('release-y').value = undo.releaseY;
    const mode = document.getElementById('downhill-mode');
    if (mode) mode.value = undo.downhillMode;
    profileChanged(app);
    app.updateTerrainInfo();
    app.updateSegmentsList();
    app.renderer.autoScale();
    app.updateZoomInfo();
    app.render();
    document.getElementById('simulation-status').textContent = 'Perfil banco–berma deshecho; se restauró el perfil anterior';
    return true;
}

function generateBenchProfile(app) {
    if (profileEditBlocked(app)) return;
    const fail = reason => alert('No se pudo generar el perfil banco–berma: ' + reason);
    const num = id => Number(String(document.getElementById(id).value).trim() || NaN);
    const params = {
        benches: num('bench-count'), benchHeight: num('bench-height'), faceAngleDeg: num('bench-face-angle'),
        bermWidth: num('bench-berm-width'), baseElevation: num('bench-base-elevation'),
        topPlatform: num('bench-top-platform'), floorLength: num('bench-floor-length')
    };
    let out;
    try {
        if (!SimRocas.BenchProfile) throw new Error('el generador no está disponible');
        out = SimRocas.BenchProfile.generate(params);
    } catch (err) {
        fail(err.message);
        return;
    }
    if (!out || out.ok !== true) {
        fail((out && out.error) || 'error desconocido');
        return;
    }
    // I-D e I-E: nunca un perfil parcial; X finita y estrictamente creciente.
    const points = Array.isArray(out.points) ? out.points : [];
    const roles = Array.isArray(out.roles) ? out.roles : [];
    let valid = points.length >= 2 && roles.length === points.length - 1 &&
        roles.every(role => Object.prototype.hasOwnProperty.call(BENCH_ROLE_MATERIAL, role));
    for (let i = 0; valid && i < points.length; i++) {
        valid = Number.isFinite(points[i].x) && Number.isFinite(points[i].y) && (i === 0 || points[i].x - points[i - 1].x >= 1e-9);
    }
    if (!valid) {
        fail('el generador devolvió un perfil inválido');
        return;
    }
    const mode = document.getElementById('downhill-mode');
    const undo = {
        points: app.terrain.points.map(p => ({ x: p.x, y: p.y })),
        segments: app.terrain.segments.map(s => ({ ...s })),
        release: { x: app.releasePoint.x, y: app.releasePoint.y },
        releaseX: document.getElementById('release-x').value,
        releaseY: document.getElementById('release-y').value,
        downhillMode: mode ? mode.value : 'auto'
    };
    try {
        app.terrain.setPoints(points.map(p => ({ x: p.x, y: p.y })));
        if (app.terrain.points.length !== points.length) throw new Error('el perfil no se pudo cargar completo');
    } catch (err) {
        app.terrain.clear();
        for (const p of undo.points) app.terrain.addPoint(p.x, p.y, app.selectedPresetType);
        app.terrain.segments = undo.segments.map(s => ({ ...s }));
        fail(err.message);
        return;
    }
    roles.forEach((role, i) => app.terrain.applyPresetToRange(BENCH_ROLE_MATERIAL[role], i, i));
    profileChanged(app);
    app._benchUndo = undo;
    app._benchProfile = { params: out.params, benchMeta: out.benchMeta, pointsKey: JSON.stringify(app.terrain.points) };
    renderBenchMeta(out.benchMeta);
    // Fuente sobre la plataforma superior, 1 m antes de la primera cresta
    // (o a media plataforma si mide menos de 2 m).
    const first = app.terrain.points[0].x;
    const crest = roles[0] === 'platform' ? app.terrain.points[1].x : first;
    app.releasePoint.x = crest - Math.min(1, (crest - first) / 2);
    const terrainY = app.terrain.getHeightAt(app.releasePoint.x);
    app.releasePoint.y = app.releaseMode === 'detachment' ? terrainY : terrainY + 7;
    document.getElementById('release-x').value = app.releasePoint.x.toFixed(1);
    document.getElementById('release-y').value = app.releasePoint.y.toFixed(1);
    if (mode) mode.value = '+x';
    app.updateTerrainInfo();
    app.updateSegmentsList();
    app.renderer.autoScale();
    app.updateZoomInfo();
    app.render();
    document.getElementById('simulation-status').textContent =
        `Perfil banco–berma generado (${out.benchMeta ? out.benchMeta.length : 0} bancos); sentido de descenso fijado en +X`;
}

// Para los mixins app-stl.js y app-profile3d.js (funciones de módulo: App.prototype no gana métodos).
SimRocas.ProfileEdit = { blocked: profileEditBlocked, changed: profileChanged };

function copyRunSegments(terrain) {
    const points = Array.isArray(terrain?.points) ? terrain.points : [];
    const segments = Array.isArray(terrain?.segments) ? terrain.segments : [];
    const presets = typeof SimRocas !== 'undefined' && SimRocas.TerrainPresets ? SimRocas.TerrainPresets : {};
    const count = Math.min(segments.length, Math.max(0, points.length - 1));
    const result = [];
    for (let i = 0; i < count; i++) {
        const seg = segments[i] || {};
        const preset = presets[seg.type] || null;
        result.push({
            index: i,
            x0: Number.isFinite(points[i]?.x) ? points[i].x : null,
            x1: Number.isFinite(points[i + 1]?.x) ? points[i + 1].x : null,
            type: typeof seg.type === 'string' ? seg.type : '',
            label: preset && typeof preset.label === 'string' ? preset.label : '',
            cn: Number.isFinite(seg.cn) ? seg.cn : null,
            ct: Number.isFinite(seg.ct) ? seg.ct : null,
            roughness: Number.isFinite(seg.roughness) ? seg.roughness : 0
        });
    }
    return result;
}

/** Etiquetas de variabilidad: en masa concentrada los sorteos actúan sobre Kn/Kt. */
function syncVariabilityLabels() {
    const method = document.getElementById('calc-method');
    const suffix = method && method.value === 'lumped-mass' ? ' (se aplica a Kn/Kt)' : '';
    const cnLabel = document.getElementById('cn-variability-label');
    const ctLabel = document.getElementById('ct-variability-label');
    if (cnLabel) cnLabel.textContent = `Variabilidad Cn (%)${suffix}`;
    if (ctLabel) ctLabel.textContent = `Variabilidad Ct (%)${suffix}`;
}

// Bloque «Piezas finales (fragmentación)»: visible solo si Stats publica results.lineage.
function updateLineageBlock(result) {
    const lineage = result && result.lineage ? result.lineage : null;
    const block = document.getElementById('lineage-block');
    if (block) block.style.display = lineage ? 'block' : 'none';
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const format = value => Number.isFinite(value) ? value.toFixed(1) : '—';
    const list = (counts, labels) => Object.keys(labels).filter(key => counts && counts[key] > 0)
        .map(key => `${labels[key]}: ${counts[key]}`).join(' · ') || '—';
    const mass = lineage && lineage.mass ? lineage.mass : {};
    const runout = lineage && lineage.finalRunout ? lineage.finalRunout : {};
    set('lineage-primaries', lineage ? String(lineage.primaries) : '—');
    set('lineage-leaves', lineage ? String(lineage.leaves) : '—');
    set('lineage-by-kind', lineage ? list(lineage.byKind, {
        primary: 'Roca original intacta', core: 'Núcleo de abrasión', major: 'Fragmento principal', spall: 'Esquirla'
    }) : '—');
    set('lineage-by-reason', lineage ? list(lineage.byReason, {
        rest: 'En reposo', culled: 'Fuera del perfil', maxTime: 'Tiempo máximo', maxSteps: 'Pasos máximos'
    }) : '—');
    ['original', 'rest', 'culled', 'censored', 'discarded'].forEach(key => set(`lineage-mass-${key}`, format(mass[key])));
    ['p50', 'p83', 'p95'].forEach(key => set(`lineage-runout-${key}`, format(runout[key])));
    const warning = lineage && Array.isArray(result.warnings) ? result.warnings.find(w => w && w.code === 'masaDescartada') : null;
    const exceeded = lineage && Array.isArray(lineage.discardedByTree) ? lineage.discardedByTree.filter(t => t && t.fraction > 0.01).length : 0;
    set('lineage-warning', warning ? warning.message :
        exceeded ? `Masa descartada superior al 1 % en ${exceeded} roca(s) original(es).` : '');
}

class App {
    constructor() {
        this.terrain = new SimRocas.Terrain();
        this.physics = new SimRocas.PhysicsEngine();
        this.simulation = new SimRocas.Simulation(this.terrain, this.physics);
        this.stats = new SimRocas.Stats();

        this.canvas = document.getElementById('main-canvas');
        this.histogramCanvas = document.getElementById('histogram-canvas');
        this.renderer = new SimRocas.Renderer(this.canvas, this.terrain);

        this.releasePoint = { x: 10, y: 55 };
        this.isSettingRelease = false;
        this.animationId = null;
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };

        // Timeline playback state
        this.timelineActive = false;
        this.timelinePlaying = false;
        this.timelineFrame = 0;
        this.timelineAnimId = null;

        // Terrain segment editor state
        this.selectedSegmentIndex = -1;
        this.selectedPresetType = 'roca-suave';

        // Release mode: 'freefall' or 'detachment'
        this.releaseMode = 'freefall';

        // Multiple release points
        this.multiReleasePoints = [];
        this.multiReleaseEnabled = false;

        // Render throttling — prevents duplicate paints during pan/scroll
        this._renderPending = false;

        this.init();
    }

    init() {
        this.loadTheme();
        this.setupThemeToggle();
        this.setupTabs();
        this.setupSubTabs();
        this.setupSidebarResize();
        this.setupTerrainControls();
        this.setupSegmentEditor();
        this.setupParameterControls();
        this.setupSimulationControls();
        this.setupTimelineControls();
        this.setupCanvasInteraction();
        this.setupToolbarControls();
        this.setupToolbarRight();
        this.setupExportControls();
        this.setupKeyboardShortcuts();
        this.setupBarrierControls();
        this.setupDashboardControls();
        this.setupStlControls();
        this.setupResize();
        this.renderer.resize();  // Must be before loadDefaultTerrain — sets terrain.canvas
        this.loadDefaultTerrain();
        this.render();
    }

    setupTabs() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                this.renderer.activeTab = tabName; // Sync active tab with renderer

                // Special handling for results tab
                if (tabName === 'results') {
                    this.showResultsTab();
                    return;
                }

                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`tab-${tabName}`).classList.add('active');

                // Render immediately to refresh canvas view
                this.render();
            });
        });
    }

    setupSubTabs() {
        document.querySelectorAll('.sub-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const subName = btn.dataset.subtab;
                document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.sub-tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const content = document.getElementById(`subtab-${subName}`);
                if (content) content.classList.add('active');
            });
        });
        // Show first sub-tab by default
        const firstContent = document.querySelector('.sub-tab-content');
        if (firstContent) firstContent.classList.add('active');
    }

    showResultsTab() {
        // Activate the results tab visually
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="results"]').classList.add('active');
        document.getElementById('tab-results').classList.add('active');

        const hasResults = this._resultsValid === true;

        const placeholder = document.getElementById('results-placeholder-msg');
        const content = document.getElementById('results-sidebar-content');

        if (hasResults) {
            placeholder.style.display = 'none';
            content.style.display = 'block';
        } else {
            placeholder.style.display = 'block';
            content.style.display = 'none';
        }
    }

    setupSidebarResize() {
        const handle = document.getElementById('sidebar-resize-handle');
        const sidebar = document.getElementById('sidebar');
        const MIN_W = 260;
        const MAX_W = 700;

        const saved = localStorage.getItem('simrocas-sidebar-width');
        if (saved) {
            const w = parseInt(saved);
            if (w >= MIN_W && w <= MAX_W) sidebar.style.width = w + 'px';
        }

        let startX, startW;

        const onStart = (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            handle.classList.add('active');
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        };

        const onMove = (e) => {
            const diff = e.clientX - startX;
            const newW = Math.max(MIN_W, Math.min(MAX_W, startW + diff));
            sidebar.style.width = newW + 'px';
            this.renderer.resize();
            this.render();
        };

        const onEnd = () => {
            handle.classList.remove('active');
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            localStorage.setItem('simrocas-sidebar-width', sidebar.offsetWidth);
        };

        handle.addEventListener('mousedown', onStart);
    }

    loadTheme() {
        const saved = localStorage.getItem('simrocas-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', saved);
    }

    setupThemeToggle() {
        const btn = document.getElementById('theme-toggle');
        btn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('simrocas-theme', next);
        });
    }

    setupTerrainControls() {
        // P1.1: generador paramétrico banco–berma.
        document.getElementById('btn-bench-generate').addEventListener('click', () => generateBenchProfile(this));

        document.getElementById('btn-add-point').addEventListener('click', () => {
            const x = parseFloat(document.getElementById('input-x').value);
            const y = parseFloat(document.getElementById('input-y').value);
            if (!isNaN(x) && !isNaN(y)) {
                if (profileEditBlocked(this)) return;
                this.terrain.addPoint(x, y, this.selectedPresetType);
                profileChanged(this);
                this.updateTerrainInfo();
                this.updateSegmentsList();
                this.render();
            }
        });

        document.getElementById('btn-clear-terrain').addEventListener('click', () => {
            if (profileEditBlocked(this)) return;
            if (confirm('¿Limpiar todo el perfil?')) {
                this.terrain.clear();
                profileChanged(this);
                this.updateTerrainInfo();
                this.updateSegmentsList();
                this.render();
            }
        });

        document.getElementById('btn-save-profile').addEventListener('click', () => {
            const data = this.terrain.toJSON();
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'terrain-profile.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        document.getElementById('btn-save-csv').addEventListener('click', () => {
            const csv = this.terrain.toCSV();
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'terrain-profile.csv';
            a.click();
            URL.revokeObjectURL(url);
        });

        document.getElementById('btn-load-profile').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        document.getElementById('file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (profileEditBlocked(this)) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                if (profileEditBlocked(this)) return;
                try {
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (ext === 'csv') {
                        this.terrain.fromCSV(ev.target.result);
                    } else {
                        this.terrain.fromJSON(ev.target.result);
                    }
                    profileChanged(this);
                    this.terrain.canvas = this.canvas;
                    this.renderer.autoScale();
                    this.updateTerrainInfo();
                    this.updateSegmentsList();
                    this.render();
                } catch (err) {
                    alert('Error al cargar el perfil: ' + err.message);
                }
            };
            reader.readAsText(file);
        });

        // Copiar coordenadas al portapapeles (formato Excel: X(tab)Y)
        document.getElementById('btn-copy-coords').addEventListener('click', () => {
            if (this.terrain.points.length === 0) {
                alert('No hay puntos para copiar.');
                return;
            }
            let text = '';
            for (const p of this.terrain.points) {
                text += `${p.x}\t${p.y}\n`;
            }
            navigator.clipboard.writeText(text).then(() => {
                alert(`${this.terrain.points.length} coordenadas copiadas al portapapeles.`);
            }).catch(() => {
                // Fallback: crear textarea temporal
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                alert(`${this.terrain.points.length} coordenadas copiadas.`);
            });
        });

        // Pegar coordenadas desde Excel (X(tab/coma)Y, una por línea)
        document.getElementById('btn-paste-coords').addEventListener('click', () => {
            if (profileEditBlocked(this)) return;
            navigator.clipboard.readText().then((text) => {
                if (profileEditBlocked(this)) return;
                const lines = text.trim().split(/\r?\n/);
                let added = 0;
                for (const line of lines) {
                    const parts = line.trim().split(/[\t,;]+/);
                    if (parts.length >= 2) {
                        const x = parseFloat(parts[0]);
                        const y = parseFloat(parts[1]);
                        if (!isNaN(x) && !isNaN(y)) {
                            this.terrain.addPoint(x, y, this.selectedPresetType);
                            added++;
                        }
                    }
                }
                if (added > 0) {
                    profileChanged(this);
                    this.renderer.autoScale();
                    this.updateTerrainInfo();
                    this.updateSegmentsList();
                    this.render();
                    alert(`${added} puntos agregados desde el portapapeles.`);
                } else {
                    alert('No se encontraron coordenadas válidas. Formato esperado: X(tab)Y, una por línea.');
                }
            }).catch(() => {
                alert('No se pudo leer el portapapeles. Intenta copiar las coordenadas primero.');
            });
        });
    }

    setupSegmentEditor() {
        const presets = SimRocas.TerrainPresets;
        const presetBtns = document.querySelectorAll('.preset-btn');
        const applyBtn = document.getElementById('btn-apply-preset');
        this.segFrom = document.getElementById('seg-from');
        this.segTo = document.getElementById('seg-to');

        // Preset button selection
        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                presetBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.selectedPresetType = btn.dataset.type;
            });
        });

        // Apply preset to range
        applyBtn.addEventListener('click', () => {
            const from = parseInt(this.segFrom.value) || 0;
            const to = parseInt(this.segTo.value) !== 0 ? parseInt(this.segTo.value) : this.terrain.segmentCount - 1;
            if (profileEditBlocked(this)) return;
            this.terrain.applyPresetToRange(this.selectedPresetType, from, to);
            profileChanged(this);
            this.updateSegmentsList();
            this.render();
        });

        // Listen for change and input events on #segment-roughness
        const roughnessSlider = document.getElementById('segment-roughness');
        const roughnessVal = document.getElementById('segment-roughness-val');
        if (roughnessSlider && roughnessVal) {
            const handleInput = () => {
                const val = parseInt(roughnessSlider.value) || 0;
                if (this.selectedSegmentIndex >= 0 && this.terrain.segments[this.selectedSegmentIndex]) {
                    if (profileEditBlocked(this)) {
                        roughnessVal.textContent = `${val}°`;
                        return;
                    }
                    if (this.terrain.segments[this.selectedSegmentIndex].roughness !== val) {
                        // P1.1 (4b): la rugosidad pasa por la validación de Terrain; fuera de rango no cambia nada.
                        try {
                            this.terrain.setSegmentProperties(this.selectedSegmentIndex, { roughness: val });
                        } catch (err) {
                            alert('Error al editar el tramo: ' + err.message);
                            const current = this.terrain.segments[this.selectedSegmentIndex].roughness || 0;
                            roughnessSlider.value = current;
                            roughnessVal.textContent = `${current}°`;
                            return;
                        }
                        profileChanged(this);
                    }
                }
                roughnessVal.textContent = `${val}°`;
            };
            roughnessSlider.addEventListener('input', handleInput);
            roughnessSlider.addEventListener('change', () => {
                handleInput();
                this.render();
                this.updateSegmentsList();
            });
        }

        // Set initial range values
        this.segFrom.value = 0;
        this.segTo.value = 0;
    }

    updateSegmentsList() {
        const list = document.getElementById('segments-list');
        const presets = SimRocas.TerrainPresets;
        const count = this.terrain.segmentCount;

        this.segFrom.max = count - 1;
        this.segTo.max = count - 1;
        if (parseInt(this.segTo.value) >= count) this.segTo.value = Math.max(0, count - 1);

        let html = '';
        for (let i = 0; i < count; i++) {
            const seg = this.terrain.segments[i];
            const p1 = this.terrain.points[i];
            const p2 = this.terrain.points[i + 1];
            const label = presets[seg.type] ? presets[seg.type].label : seg.type;
            const selected = i === this.selectedSegmentIndex ? ' selected' : '';
            html += `
                <div class="segment-row${selected}" data-seg="${i}">
                    <span class="segment-color" style="background:${seg.color}"></span>
                    <span class="segment-idx">${i}</span>
                    <span class="segment-type">${label}</span>
                    <span class="segment-coeffs">Cn:${seg.cn.toFixed(2)} Ct:${seg.ct.toFixed(2)} Rg:${seg.roughness || 0}°</span>
                </div>
            `;
        }
        list.innerHTML = html;

        // Show/hide/update roughness editing control based on selectedSegmentIndex
        const roughnessGroup = document.getElementById('seg-roughness-group');
        const roughnessSlider = document.getElementById('segment-roughness');
        const roughnessVal = document.getElementById('segment-roughness-val');

        if (this.selectedSegmentIndex < 0) {
            if (roughnessGroup) roughnessGroup.style.display = 'none';
        } else {
            if (roughnessGroup) roughnessGroup.style.display = 'block';
            const seg = this.terrain.segments[this.selectedSegmentIndex];
            if (seg && roughnessSlider && roughnessVal) {
                const rVal = seg.roughness !== undefined ? seg.roughness : 0;
                roughnessSlider.value = rVal;
                roughnessVal.textContent = `${rVal}°`;
            }
        }

        // Click to select segment
        list.querySelectorAll('.segment-row').forEach(row => {
            row.addEventListener('click', () => {
                this.selectedSegmentIndex = parseInt(row.dataset.seg);
                const seg = this.terrain.segments[this.selectedSegmentIndex];
                if (seg && seg.type) {
                    this.selectedPresetType = seg.type;
                    document.querySelectorAll('.preset-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.type === seg.type);
                    });
                }
                this.updateSegmentsList();
            });
        });
    }

    setupParameterControls() {
        const bindRange = (rangeId, valueId, target, prop) => {
            const range = document.getElementById(rangeId);
            const value = document.getElementById(valueId);
            range.addEventListener('input', () => {
                value.textContent = parseFloat(range.value).toFixed(2);
                target[prop] = parseFloat(range.value);
            });
        };

        bindRange('cn-range', 'cn-value', this.physics, 'cn');
        bindRange('ct-range', 'ct-value', this.physics, 'ct');
        bindRange('kn-range', 'kn-value', this.physics, 'kn');
        bindRange('kt-range', 'kt-value', this.physics, 'kt');
        bindRange('cn-range-ns', 'cn-value-ns', this.physics, 'cn');
        bindRange('mu-range', 'mu-value', this.physics, 'ct');
        bindRange('rolling-friction', 'rolling-value', this.physics, 'rollingFriction');

        // Calculation method selector — show/hide appropriate controls
        const calcMethod = document.getElementById('calc-method');
        const rigidBodyControls = document.getElementById('rigid-body-controls');
        const lumpedMassControls = document.getElementById('lumped-mass-controls');
        const nonsmoothControls = document.getElementById('nonsmooth-controls');
        const energyModelGroup = document.getElementById('energy-model-group');
        const updateCalcMethodVisibility = () => {
            const method = calcMethod.value;
            rigidBodyControls.style.display = method === 'rigid-body' ? 'block' : 'none';
            lumpedMassControls.style.display = method === 'lumped-mass' ? 'block' : 'none';
            nonsmoothControls.style.display = method === 'nonsmooth' ? 'block' : 'none';
            energyModelGroup.style.display = method === 'rigid-body' ? 'block' : 'none';
            this.physics.calcMethod = method;
            syncVariabilityLabels();
        };
        calcMethod.addEventListener('change', updateCalcMethodVisibility);
        updateCalcMethodVisibility();

        // Shape selector — show/hide aspect ratio
        const shapeSelect = document.getElementById('rock-shape');
        const aspectGroup = document.getElementById('aspect-ratio-group');
        const updateAspectVisibility = () => {
            const show = ['ellipse', 'block'].includes(shapeSelect.value);
            aspectGroup.style.display = show ? 'block' : 'none';
        };
        shapeSelect.addEventListener('change', updateAspectVisibility);
        updateAspectVisibility();

        // Energy model selector — show/hide energy ratio
        const energyModel = document.getElementById('energy-model');
        const energyGroup = document.getElementById('energy-ratio-group');
        const updateEnergyVisibility = () => {
            const show = energyModel.value === 'energy-ratio';
            energyGroup.style.display = show ? 'block' : 'none';
        };
        energyModel.addEventListener('change', updateEnergyVisibility);
        updateEnergyVisibility();
        bindRange('energy-ratio-coef', 'energy-ratio-value', this.physics, 'energyRatio');

        // Rolling model selector — show/hide deformation coef
        const rollingModel = document.getElementById('rolling-model');
        const rollingGroup = document.getElementById('rolling-deformation-group');
        const updateRollingVisibility = () => {
            const show = rollingModel.value === 'davis-mcinnnes';
            rollingGroup.style.display = show ? 'block' : 'none';
        };
        rollingModel.addEventListener('change', updateRollingVisibility);
        updateRollingVisibility();
        bindRange('deformation-coef', 'deformation-value', this.physics, 'deformationCoef');

        // Model selectors — update physics engine directly
        energyModel.addEventListener('change', () => {
            this.physics.energyModel = energyModel.value;
        });
        rollingModel.addEventListener('change', () => {
            this.physics.rollingModel = rollingModel.value;
        });

        // Correlated params checkbox
        document.getElementById('correlated-params').addEventListener('change', (e) => {
            this.physics.correlatedParams = e.target.checked;
        });

        // Fragmentation enabled checkbox and sliders
        const fragEnabled = document.getElementById('fragmentation-enabled');
        const fragSettingsGroup = document.getElementById('fragmentation-settings-group');
        const updateFragVisibility = () => {
            const show = fragEnabled.checked;
            fragSettingsGroup.style.display = show ? 'block' : 'none';
            this.physics.fragmentationEnabled = show;
        };
        fragEnabled.addEventListener('change', updateFragVisibility);
        updateFragVisibility();

        // Fracture energy slider
        const fractureEnergyInput = document.getElementById('fracture-energy');
        const fractureEnergyVal = document.getElementById('fracture-energy-val');
        fractureEnergyInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            fractureEnergyVal.textContent = val.toLocaleString() + ' J';
            this.physics.fractureEnergy = val;
        });
        this.physics.fractureEnergy = parseInt(fractureEnergyInput.value);

        // Fracture dissipation slider
        const fractureDissInput = document.getElementById('fracture-dissipation');
        const fractureDissVal = document.getElementById('fracture-dissipation-val');
        fractureDissInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            fractureDissVal.textContent = val + '%';
            this.physics.fractureDissipation = val / 100;
        });
        this.physics.fractureDissipation = parseInt(fractureDissInput.value) / 100;

        document.getElementById('anim-speed').addEventListener('input', (e) => {
            document.getElementById('anim-speed-value').textContent = e.target.value + 'x';
            this.simulation.animationSpeed = parseInt(e.target.value);
        });

        // Release mode selector — toggle Y input visibility
        const releaseMode = document.getElementById('release-mode');
        const releaseYGroup = document.getElementById('release-y-group');
        const updateReleaseMode = () => {
            this.releaseMode = releaseMode.value;
            if (this.releaseMode === 'detachment') {
                releaseYGroup.style.display = 'none';
                // Snap to terrain surface
                const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
                this.releasePoint.y = terrainY;
                document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
                // Force zero velocity for detachment
                document.getElementById('initial-velocity').value = '0';
                document.getElementById('release-angle').value = '0';
            } else {
                releaseYGroup.style.display = '';
            }
            this.render();
        };
        releaseMode.addEventListener('change', updateReleaseMode);

        ['release-x', 'release-y', 'initial-velocity', 'release-angle'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                this.updateReleasePoint();
                this.render();
            });
        });

        // Multi-release points UI
        const multiReleaseCheckbox = document.getElementById('multi-release');
        const multiReleaseList = document.getElementById('multi-release-list');
        const multiReleaseBtns = document.getElementById('multi-release-btns');

        multiReleaseCheckbox.addEventListener('change', () => {
            this.multiReleaseEnabled = multiReleaseCheckbox.checked;
            multiReleaseList.style.display = this.multiReleaseEnabled ? 'block' : 'none';
            multiReleaseBtns.style.display = this.multiReleaseEnabled ? 'flex' : 'none';
            this.render();
        });

        document.getElementById('btn-add-release').addEventListener('click', () => {
            const rx = parseFloat(document.getElementById('release-x').value) || 20;
            const ry = parseFloat(document.getElementById('release-y').value) || 55;
            const vel = parseFloat(document.getElementById('initial-velocity').value) || 0;
            const ang = parseFloat(document.getElementById('release-angle').value) || 0;
            this.multiReleasePoints.push({ x: rx, y: ry, velocity: vel, angle: ang });
            this.updateMultiReleaseList();
            this.render();
        });

        document.getElementById('btn-clear-releases').addEventListener('click', () => {
            this.multiReleasePoints = [];
            this.updateMultiReleaseList();
            this.render();
        });
    }

    updateMultiReleaseList() {
        const list = document.getElementById('multi-release-list');
        if (!this.multiReleaseEnabled || this.multiReleasePoints.length === 0) {
            list.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85em;padding:4px;">No hay puntos definidos. Usa el botón "Agregar punto".</div>';
            return;
        }
        let html = '';
        for (let i = 0; i < this.multiReleasePoints.length; i++) {
            const p = this.multiReleasePoints[i];
            html += `<div class="segment-item">
                <span class="segment-info">P${i + 1}: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) v=${p.velocity} a=${p.angle}°</span>
                <button class="btn btn-danger btn-small" data-remove-release="${i}" style="padding:0 6px;">✕</button>
            </div>`;
        }
        list.innerHTML = html;

        // Wire remove buttons
        list.querySelectorAll('[data-remove-release]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.removeRelease);
                this.multiReleasePoints.splice(idx, 1);
                this.updateMultiReleaseList();
                this.render();
            });
        });
    }

    setupSimulationControls() {
        document.getElementById('btn-run').addEventListener('click', () => this.runSimulation());
        document.getElementById('btn-stop').addEventListener('click', () => this.stopSimulation());
        document.getElementById('btn-reset').addEventListener('click', () => this.resetSimulation());

        const fabBtn = document.getElementById('fab-run');
        if (fabBtn) fabBtn.addEventListener('click', () => {
            if (!this.simulation.isRunning) {
                this.runSimulation();
            } else {
                this.stopSimulation();
            }
        });

        document.getElementById('show-risk-zones').addEventListener('change', (e) => {
            this.renderer.showRiskZones = e.target.checked;
            this.render();
        });

        document.getElementById('show-probability-map').addEventListener('change', (e) => {
            this.renderer.showProbabilityMap = e.target.checked;
            this.render();
        });

        const trajBtn = document.getElementById('btn-toggle-trajectories');
        trajBtn.addEventListener('click', () => {
            this.renderer.showTrajectories = !this.renderer.showTrajectories;
            trajBtn.classList.toggle('active', this.renderer.showTrajectories);
            this.render();
        });
    }

    setupTimelineControls() {
        const scrubber = document.getElementById('tl-scrubber');
        const counter = document.getElementById('tl-counter');
        const playBtn = document.getElementById('btn-tl-play');
        const prevBtn = document.getElementById('btn-tl-prev');
        const nextBtn = document.getElementById('btn-tl-next');
        const playIcon = playBtn.querySelector('.tl-play-icon');
        const pauseIcon = playBtn.querySelector('.tl-pause-icon');

        scrubber.addEventListener('input', () => {
            this.timelineFrame = parseInt(scrubber.value);
            counter.textContent = `${this.timelineFrame + 1} / ${this.simulation.frameCount}`;
            this.renderTimelineFrame();
        });

        playBtn.addEventListener('click', () => {
            if (this.timelinePlaying) {
                this.pauseTimeline();
            } else {
                this.playTimeline();
            }
        });

        prevBtn.addEventListener('click', () => {
            this.pauseTimeline();
            if (this.timelineFrame > 0) {
                this.timelineFrame--;
                scrubber.value = this.timelineFrame;
                counter.textContent = `${this.timelineFrame + 1} / ${this.simulation.frameCount}`;
                this.renderTimelineFrame();
            }
        });

        nextBtn.addEventListener('click', () => {
            this.pauseTimeline();
            if (this.timelineFrame < this.simulation.frameCount - 1) {
                this.timelineFrame++;
                scrubber.value = this.timelineFrame;
                counter.textContent = `${this.timelineFrame + 1} / ${this.simulation.frameCount}`;
                this.renderTimelineFrame();
            }
        });

        // Expose icon toggle helper
        this._tlPlayIcon = playIcon;
        this._tlPauseIcon = pauseIcon;
    }

    activateTimeline() {
        this.timelineActive = true;
        this.timelinePlaying = false;
        this.timelineFrame = 0;

        const bar = document.getElementById('timeline-bar');
        const scrubber = document.getElementById('tl-scrubber');
        const counter = document.getElementById('tl-counter');

        bar.classList.add('visible');
        scrubber.max = this.simulation.frameCount - 1;
        scrubber.value = 0;
        counter.textContent = `1 / ${this.simulation.frameCount}`;

        this._tlPlayIcon.style.display = '';
        this._tlPauseIcon.style.display = 'none';

        this.renderer.resize();
        this.renderTimelineFrame();
    }

    hideTimeline() {
        this.pauseTimeline();
        this.timelineActive = false;
        document.getElementById('timeline-bar').classList.remove('visible');
    }

    playTimeline() {
        if (!this.timelineActive) return;
        if (this.timelineFrame >= this.simulation.frameCount - 1) {
            this.timelineFrame = 0;
        }
        this.timelinePlaying = true;
        this._tlPlayIcon.style.display = 'none';
        this._tlPauseIcon.style.display = '';
        this._timelineStep();
    }

    pauseTimeline() {
        this.timelinePlaying = false;
        this._tlPlayIcon.style.display = '';
        this._tlPauseIcon.style.display = 'none';
        if (this.timelineAnimId) {
            cancelAnimationFrame(this.timelineAnimId);
            this.timelineAnimId = null;
        }
    }

    _timelineStep() {
        if (!this.timelinePlaying) return;

        this.timelineFrame++;
        if (this.timelineFrame >= this.simulation.frameCount) {
            this.timelineFrame = this.simulation.frameCount - 1;
            this.pauseTimeline();
        }

        const scrubber = document.getElementById('tl-scrubber');
        const counter = document.getElementById('tl-counter');
        scrubber.value = this.timelineFrame;
        counter.textContent = `${this.timelineFrame + 1} / ${this.simulation.frameCount}`;

        this.renderTimelineFrame();

        if (this.timelinePlaying) {
            this.timelineAnimId = requestAnimationFrame(() => this._timelineStep());
        }
    }

    renderTimelineFrame() {
        this.renderer.renderTimelineFrame(
            this.timelineFrame,
            this.simulation.frames,
            this.simulation.rocks,
            this.releasePoint.x,
            this.releasePoint.y
        );
    }

    setupToolbarControls() {
        document.getElementById('btn-reset-view').addEventListener('click', () => {
            this.renderer.autoScale();
            this.updateTerrainInfo();
            this.updateZoomInfo();
            this.render();
        });
    }

    /**
     * Right toolbar (AutoCAD-style) — navigation + editing tools.
     * Tracks activeTool: 'crosshair' (add) | 'delete' | 'pan'.
     */
    setupToolbarRight() {
        this.activeTool = 'crosshair';

        const setActive = (id) => {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            if (id) document.getElementById(id).classList.add('active');
            this.activeTool = id || 'crosshair';
            // Update canvas cursor
            const canvas = this.canvas;
            if (this.activeTool === 'pan') {
                canvas.style.cursor = 'grab';
            } else if (this.activeTool === 'delete') {
                canvas.style.cursor = 'not-allowed';
            } else {
                canvas.style.cursor = 'crosshair';
            }
        };

        // Zoom +
        document.getElementById('tool-zoom-in').addEventListener('click', () => {
            const cx = this.canvas.width / 2;
            const cy = this.canvas.height / 2;
            const wx = (cx - this.terrain.offsetX) / this.terrain.scale;
            const wy = (cy - this.terrain.offsetY) / this.terrain.scale;
            this.terrain.scale = Math.min(50, this.terrain.scale * 1.3);
            this.terrain.offsetX = cx - wx * this.terrain.scale;
            this.terrain.offsetY = cy - wy * this.terrain.scale;
            this.updateZoomInfo();
            this.render();
        });

        // Zoom -
        document.getElementById('tool-zoom-out').addEventListener('click', () => {
            const cx = this.canvas.width / 2;
            const cy = this.canvas.height / 2;
            const wx = (cx - this.terrain.offsetX) / this.terrain.scale;
            const wy = (cy - this.terrain.offsetY) / this.terrain.scale;
            this.terrain.scale = Math.max(0.2, this.terrain.scale / 1.3);
            this.terrain.offsetX = cx - wx * this.terrain.scale;
            this.terrain.offsetY = cy - wy * this.terrain.scale;
            this.updateZoomInfo();
            this.render();
        });

        // Pan
        document.getElementById('tool-pan').addEventListener('click', () => {
            setActive(this.activeTool === 'pan' ? null : 'tool-pan');
        });

        // Fit / Reset View
        document.getElementById('tool-fit').addEventListener('click', () => {
            this.renderer.autoScale();
            this.updateZoomInfo();
            this.render();
        });

        // Add point mode
        document.getElementById('tool-add').addEventListener('click', () => {
            setActive(this.activeTool === 'tool-add' ? null : 'tool-add');
        });

        // Delete point mode
        document.getElementById('tool-delete').addEventListener('click', () => {
            setActive(this.activeTool === 'tool-delete' ? null : 'tool-delete');
        });

        // Undo
        document.getElementById('tool-undo').addEventListener('click', () => {
            if (profileEditBlocked(this)) return;
            if (undoBenchProfile(this)) return;
            if (this.terrain.points.length > 0) {
                this.terrain.removePoint(this.terrain.points.length - 1);
                profileChanged(this);
                this.updateTerrainInfo();
                this.updateSegmentsList();
                this.render();
            }
        });

        // Random terrain
        document.getElementById('tool-random').addEventListener('click', () => {
            if (profileEditBlocked(this)) return;
            this.terrain.points = [];
            this.terrain.segments = [];
            profileChanged(this);
            const pts = this.generateRandomTerrain();
            for (const p of pts) {
                this.terrain.addPoint(p.x, p.y, this.selectedPresetType);
            }
            this.updateTerrainInfo();
            this.updateSegmentsList();
            const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
            this.releasePoint.y = terrainY + 7;
            document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
            this.renderer.autoScale();
            this.updateZoomInfo();
            this.render();
        });

        // Play / Simulate
        document.getElementById('tool-play').addEventListener('click', () => {
            if (!this.simulation.isRunning) this.runSimulation();
        });

        // Stop / Reset simulation
        document.getElementById('tool-stop').addEventListener('click', () => {
            if (this.simulation.isRunning) this.stopSimulation();
            else this.resetSimulation();
        });
    }

    updateZoomInfo() {
        const zoomPercent = Math.round(this.terrain.scale / 2 * 100);
        const el = document.getElementById('zoom-level');
        if (el) el.textContent = `Zoom: ${zoomPercent}%`;
    }

    setupExportControls() {
        const imgBtn = document.getElementById('btn-export-image');
        if (imgBtn) imgBtn.addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = 'simrocas-simulation.png';
            link.href = this.canvas.toDataURL('image/png');
            link.click();
        });

        const csvBtn = document.getElementById('btn-export-csv');
        if (csvBtn) csvBtn.addEventListener('click', () => {
            if (!this._resultsValid) return;
            const csv = this.stats.generateCSV();
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simrocas-results.csv';
            a.click();
            URL.revokeObjectURL(url);
        });

        const impactsBtn = document.getElementById('btn-export-impacts');
        if (impactsBtn) impactsBtn.addEventListener('click', () => {
            if (!this._resultsValid) return;
            if (!this.stats.results || this.stats.results.impactExportAvailable !== true) return;
            const csv = this.stats.generateImpactCSV();
            if (csv === null || csv === undefined) return;
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simrocas_impactos.csv';
            a.click();
            URL.revokeObjectURL(url);
        });

        const reportBtn = document.getElementById('btn-export-report');
        if (reportBtn) reportBtn.addEventListener('click', () => {
            if (!this._resultsValid) return;
            const report = this.stats.generateReport();
            const blob = new Blob([report], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simrocas-report.txt';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // No activar atajos si el usuario está escribiendo en un input
            const tag = document.activeElement.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            // Ctrl+E o Ctrl+Enter — ejecutar simulación
            if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E' || e.key === 'Enter')) {
                e.preventDefault();
                if (!this.simulation.isRunning) this.runSimulation();
                return;
            }

            // Escape — close dashboard or stop simulation
            if (e.key === 'Escape') {
                const dashboard = document.getElementById('results-dashboard');
                if (!dashboard.classList.contains('hidden')) {
                    this.hideResultsDashboard();
                    return;
                }
                if (this.simulation.isRunning) this.stopSimulation();
                return;
            }

            // Ctrl+Z — deshacer último punto del terreno
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                if (profileEditBlocked(this)) return;
                if (undoBenchProfile(this)) return;
                if (this.terrain.points.length > 0) {
                    this.terrain.removePoint(this.terrain.points.length - 1);
                    profileChanged(this);
                    this.updateTerrainInfo();
                    this.updateSegmentsList();
                    this.render();
                }
                return;
            }

            // Ctrl+S — guardar perfil JSON
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                document.getElementById('btn-save-profile').click();
                return;
            }

            // Espacio — pausar/reanudar simulación
            if (e.key === ' ') {
                e.preventDefault();
                if (this.simulation.isRunning) {
                    this.simulation.togglePause();
                    document.getElementById('simulation-status').textContent =
                        this.simulation.isPaused ? 'Pausado' : 'Simulando...';
                }
                return;
            }

            // T — regenerar terreno aleatorio
            if (e.key === 't' || e.key === 'T') {
                if (!profileEditBlocked(this)) {
                    this.terrain.points = [];
                    this.terrain.segments = [];
                    profileChanged(this);
                    const defaultPoints = this.generateRandomTerrain();
                    for (const p of defaultPoints) {
                        this.terrain.addPoint(p.x, p.y, this.selectedPresetType);
                    }
                    this.updateTerrainInfo();
                    this.updateSegmentsList();
                    const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
                    this.releasePoint.y = terrainY + 7;
                    document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
                    this.renderer.autoScale();
                    this.updateZoomInfo();
                    this.render();
                }
                return;
            }

            // R — reset simulación
            if (e.key === 'r' || e.key === 'R') {
                if (!this.simulation.isRunning) this.resetSimulation();
                return;
            }
        });
    }

    setupBarrierControls() {
        this.barriers = [];

        document.getElementById('btn-add-barrier').addEventListener('click', () => {
            const x1 = parseFloat(document.getElementById('barrier-x1').value);
            const y1 = parseFloat(document.getElementById('barrier-y1').value);
            const x2 = parseFloat(document.getElementById('barrier-x2').value);
            const y2 = parseFloat(document.getElementById('barrier-y2').value);
            const cn = parseFloat(document.getElementById('barrier-cn').value) || 0.3;
            const ct = parseFloat(document.getElementById('barrier-ct').value) || 0.5;

            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                alert('Coordenadas inválidas. Ingresa valores numéricos.');
                return;
            }

            this.barriers.push({ x1, y1, x2, y2, cn, ct });
            this.simulation.barriers = this.barriers;
            this.updateBarrierList();
            this.render();
        });

        document.getElementById('btn-clear-barriers').addEventListener('click', () => {
            this.barriers = [];
            this.simulation.barriers = [];
            this.updateBarrierList();
            this.render();
        });
    }

    setupDashboardControls() {
        // Open dashboard button
        document.getElementById('btn-open-dashboard').addEventListener('click', () => {
            this.showResultsDashboard();
        });

        // Close dashboard button
        document.getElementById('btn-dashboard-close').addEventListener('click', () => {
            this.hideResultsDashboard();
        });

        // Dashboard export buttons
        document.getElementById('btn-dashboard-png').addEventListener('click', () => {
            this.exportDashboardPNG();
        });

        document.getElementById('btn-dashboard-csv').addEventListener('click', () => {
            if (!this._resultsValid) return;
            const csv = this.stats.generateCSV();
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simrocas-results.csv';
            a.click();
            URL.revokeObjectURL(url);
        });

        document.getElementById('btn-dashboard-report').addEventListener('click', () => {
            if (!this._resultsValid) return;
            const report = this.stats.generateReport();
            const blob = new Blob([report], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simrocas-report.txt';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    showResultsDashboard() {
        const hasResults = this._resultsValid === true;

        if (!hasResults) {
            alert('Ejecuta una simulación para ver resultados.');
            return;
        }

        const dashboard = document.getElementById('results-dashboard');
        dashboard.classList.remove('hidden');

        // Update stat badges
        const r = this.stats.results;
        if (r) {
            const format = value => Number.isFinite(value) ? value.toFixed(1) : '—';
            document.getElementById('dash-stat-total').textContent = r.population.rest;
            document.getElementById('dash-stat-max-ke').textContent = format(r.kineticEnergy?.max);
            document.getElementById('dash-stat-max-bounce').textContent = format(r.flightHeight?.max);
            document.getElementById('dash-stat-max-runout').textContent = format(r.finalRunout?.max);
            document.getElementById('dash-stat-max-vel').textContent = format(r.impactVelocity?.max);
            document.getElementById('dash-stat-savigny').textContent = format(r.reachAngle?.min);
            const p95 = r.reachBounds?.p95;
            document.getElementById('dash-stat-p95').textContent = p95 ? `${p95.exact ? '' : '≥ '}${format(p95.lower)}` : '—';
        }

        // Render charts after a frame so the DOM has updated dimensions
        const resultEpoch = this._runEpoch;
        requestAnimationFrame(() => {
            if (!this._resultsValid || resultEpoch !== this._runEpoch) return;
            this.renderer.renderResultsDashboard(r, this.terrain);
        });
    }

    hideResultsDashboard() {
        const dashboard = document.getElementById('results-dashboard');
        dashboard.classList.add('hidden');
    }

    exportDashboardPNG() {
        if (!this._resultsValid) return;
        const dashboard = document.getElementById('results-dashboard');
        // Create a temporary canvas combining all chart canvases
        const charts = dashboard.querySelectorAll('.chart-panel canvas');
        if (charts.length === 0) return;

        const cols = 2;
        const rows = 3;
        const chartW = charts[0].width;
        const chartH = charts[0].height;
        const gap = 10;
        const headerH = 50;

        const totalW = cols * chartW + (cols - 1) * gap + 40;
        const totalH = headerH + rows * chartH + (rows - 1) * gap + 40;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = totalW;
        tempCanvas.height = totalH;
        const ctx = tempCanvas.getContext('2d');

        // Background
        ctx.fillStyle = '#0f0f0f';
        ctx.fillRect(0, 0, totalW, totalH);

        // Title
        ctx.fillStyle = '#e4e4e4';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText('SimRocas 2D — Resultados de Simulación', 20, 30);

        // Draw each chart
        for (let i = 0; i < charts.length; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = 20 + col * (chartW + gap);
            const y = headerH + row * (chartH + gap);
            ctx.drawImage(charts[i], x, y);
        }

        const link = document.createElement('a');
        link.download = 'simrocas-dashboard.png';
        link.href = tempCanvas.toDataURL('image/png');
        link.click();
    }

    updateBarrierList() {
        const list = document.getElementById('barrier-list');
        if (this.barriers.length === 0) {
            list.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85em;padding:4px;">Sin barreras definidas.</div>';
            return;
        }
        let html = '';
        for (let i = 0; i < this.barriers.length; i++) {
            const b = this.barriers[i];
            html += `<div class="segment-item">
                <span class="segment-info">B${i + 1}: (${b.x1.toFixed(1)},${b.y1.toFixed(1)})→(${b.x2.toFixed(1)},${b.y2.toFixed(1)}) Cn=${b.cn} Ct=${b.ct}</span>
                <button class="btn btn-danger btn-small" data-remove-barrier="${i}" style="padding:0 6px;">✕</button>
            </div>`;
        }
        list.innerHTML = html;

        list.querySelectorAll('[data-remove-barrier]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.removeBarrier);
                this.barriers.splice(idx, 1);
                this.simulation.barriers = this.barriers;
                this.updateBarrierList();
                this.render();
            });
        });
    }

    setupCanvasInteraction() {
        this.isDrawingSlice = false;

        this.canvas.addEventListener('click', (e) => {
            if (this.renderer.activeTab === 'stl3d') return; // Guard!

            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const world = this.terrain.canvasToWorld(cx, cy);

            if (document.getElementById('tab-terrain').classList.contains('active')) {
                if (profileEditBlocked(this)) return;
                if (this.activeTool === 'tool-delete') {
                    const idx = this.terrain.findNearestPoint(cx, cy);
                    if (idx >= 0) {
                        this.terrain.removePoint(idx);
                        profileChanged(this);
                        this.updateTerrainInfo();
                        this.updateSegmentsList();
                    }
                } else {
                    // crosshair (add) or pan — add point when not panning
                    this.terrain.addPoint(world.wx, world.wy, this.selectedPresetType);
                    profileChanged(this);
                    this.updateTerrainInfo();
                    this.updateSegmentsList();
                }
            } else {
                const terrainY = this.terrain.getHeightAt(world.wx);
                this.releasePoint.x = world.wx;
                if (this.releaseMode === 'detachment') {
                    this.releasePoint.y = terrainY;
                } else {
                    this.releasePoint.y = Math.max(world.wy, terrainY + 2);
                }
                document.getElementById('release-x').value = this.releasePoint.x.toFixed(1);
                document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
            }
            this.render();
        });

        this.canvas.addEventListener('contextmenu', (e) => {
            if (this.renderer.activeTab === 'stl3d') {
                e.preventDefault();
                return;
            }
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const idx = this.terrain.findNearestPoint(cx, cy);
            if (idx >= 0) {
                if (profileEditBlocked(this)) return;
                this.terrain.removePoint(idx);
                profileChanged(this);
                this.updateTerrainInfo();
                this.updateSegmentsList();
                this.render();
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            if (this.renderer.activeTab === 'stl3d') {
                if (this.renderer.toStlWorld) {
                    const stlWorld = this.renderer.toStlWorld(cx, cy);
                    document.getElementById('cursor-coords').textContent =
                        `X: ${stlWorld.x.toFixed(1)} m | Y: ${stlWorld.y.toFixed(1)} m`;

                    if (this.isDrawingSlice) {
                        this.renderer.sliceLine.x2 = stlWorld.x;
                        this.renderer.sliceLine.y2 = stlWorld.y;
                        
                        document.getElementById('stl-slice-x2').value = Math.round(stlWorld.x);
                        document.getElementById('stl-slice-y2').value = Math.round(stlWorld.y);
                        this.render();
                    }
                }
            } else {
                const world = this.terrain.canvasToWorld(cx, cy);
                document.getElementById('cursor-coords').textContent =
                    `X: ${world.wx.toFixed(1)} m | Y: ${world.wy.toFixed(1)} m`;
            }

            // Pan logic
            if (this.isPanning) {
                const dx = e.clientX - this.panStart.x;
                const dy = e.clientY - this.panStart.y;
                this.terrain.offsetX += dx;
                this.terrain.offsetY -= dy;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.render();
            }
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.renderer.activeTab === 'stl3d') return; // Guard!

            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const worldBefore = this.terrain.canvasToWorld(cx, cy);
            const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const newScale = Math.max(0.2, Math.min(50, this.terrain.scale * zoomFactor));

            this.terrain.scale = newScale;
            this.terrain.offsetX = cx - worldBefore.wx * newScale;
            this.terrain.offsetY = this.canvas.height - cy - worldBefore.wy * newScale;

            this.updateTerrainInfo();
            this.render();
        });

        // Pan or Draw Slice Line
        this.canvas.addEventListener('mousedown', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            if (this.renderer.activeTab === 'stl3d') {
                if (e.button === 0 && !e.shiftKey && this.currentStl && this.renderer.toStlWorld) {
                    e.preventDefault();
                    this.isDrawingSlice = true;
                    const stlWorld = this.renderer.toStlWorld(cx, cy);
                    
                    this.renderer.sliceLine.x1 = stlWorld.x;
                    this.renderer.sliceLine.y1 = stlWorld.y;
                    this.renderer.sliceLine.x2 = stlWorld.x;
                    this.renderer.sliceLine.y2 = stlWorld.y;
                    this.renderer.sliceLine.active = true;

                    document.getElementById('stl-slice-x1').value = Math.round(stlWorld.x);
                    document.getElementById('stl-slice-y1').value = Math.round(stlWorld.y);
                    document.getElementById('stl-slice-x2').value = Math.round(stlWorld.x);
                    document.getElementById('stl-slice-y2').value = Math.round(stlWorld.y);
                    this.render();
                }
            } else {
                if (e.button === 1 || (e.button === 0 && e.shiftKey) || (e.button === 0 && this.activeTool === 'tool-pan')) {
                    e.preventDefault();
                    this.isPanning = true;
                    this.panStart = { x: e.clientX, y: e.clientY };
                    this.canvas.style.cursor = 'grabbing';
                }
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            if (this.renderer.activeTab === 'stl3d') {
                if (this.isDrawingSlice && e.button === 0 && this.renderer.toStlWorld) {
                    this.isDrawingSlice = false;
                    const rect = this.canvas.getBoundingClientRect();
                    const cx = e.clientX - rect.left;
                    const cy = e.clientY - rect.top;
                    const stlWorld = this.renderer.toStlWorld(cx, cy);
                    
                    this.renderer.sliceLine.x2 = stlWorld.x;
                    this.renderer.sliceLine.y2 = stlWorld.y;
                    document.getElementById('stl-slice-x2').value = Math.round(stlWorld.x);
                    document.getElementById('stl-slice-y2').value = Math.round(stlWorld.y);
                    this.render();
                }
            } else {
                if (this.isPanning && (e.button === 1 || e.button === 0)) {
                    this.isPanning = false;
                    this.canvas.style.cursor = 'crosshair';
                }
            }
        });

        // Window-level mouseup to catch releases outside the canvas
        window.addEventListener('mouseup', (e) => {
            if (!this.isDrawingSlice) return;
            if (this.renderer.activeTab !== 'stl3d') return;
            // Mouse is up — finalize the slice line even if released outside canvas
            this.isDrawingSlice = false;
            const rect = this.canvas.getBoundingClientRect();
            // Clamp to canvas bounds for the world coordinate computation
            const cx = Math.max(0, Math.min(this.canvas.width, e.clientX - rect.left));
            const cy = Math.max(0, Math.min(this.canvas.height, e.clientY - rect.top));
            const stlWorld = this.renderer.toStlWorld(cx, cy);
            this.renderer.sliceLine.x2 = stlWorld.x;
            this.renderer.sliceLine.y2 = stlWorld.y;
            document.getElementById('stl-slice-x2').value = Math.round(stlWorld.x);
            document.getElementById('stl-slice-y2').value = Math.round(stlWorld.y);
            this.render();
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.isPanning = false;
            this.canvas.style.cursor = 'crosshair';
            // Note: do NOT reset isDrawingSlice here — window mouseup handles it
        });
    }

    setupResize() {
        window.addEventListener('resize', () => {
            this.renderer.resize();
            this.render();
        });
        setTimeout(() => this.renderer.resize(), 100);
    }

    /**
     * Generates a random but geologically coherent terrain profile.
     * Coherent means: generally descending left-to-right (rockfall slope),
     * with some irregular steps, backscarps, and flat sections.
     */
    generateRandomTerrain() {
        const points = [];
        const numSegments = 6 + Math.floor(Math.random() * 5); // 6–10 segments
        const totalLength = 180 + Math.random() * 60; // 180–240m horizontal

        // Start elevation (left side — higher)
        let x = 0;
        let y = 35 + Math.random() * 25; // 35–60m

        points.push({ x, y });

        for (let i = 0; i < numSegments; i++) {
            const progress = (i + 1) / numSegments;
            // Target elevation descends as we move right
            const targetY = 35 + Math.random() * 25 - progress * (30 + Math.random() * 15);

            // Segment type: mostly smooth descent, sometimes a cliff/step
            const isCliff = Math.random() < 0.25 && i > 0 && i < numSegments - 1;
            const segLen = (totalLength / numSegments) * (0.5 + Math.random() * 1.0);

            if (isCliff) {
                // Vertical-ish drop (cliff), then flatter slope
                x += segLen * 0.15;
                points.push({ x, y });

                const drop = 4 + Math.random() * 10;
                y = Math.max(2, y - drop);
                x += segLen * 0.1;
                points.push({ x, y });

                y = y + (targetY - y) * 0.6;
                x += segLen * 0.75;
            } else {
                // Smooth or piecewise descent
                const steps = 1 + Math.floor(Math.random() * 3);
                for (let s = 0; s < steps; s++) {
                    x += segLen / steps;
                    y = y + (targetY - y) * (0.4 + Math.random() * 0.5);
                    y = Math.max(1, y);
                    points.push({ x, y });
                }
            }
        }

        // Ensure flat runout at the end
        x = totalLength;
        y = 0.5 + Math.random() * 2;
        points.push({ x, y });

        x = totalLength + 20;
        points.push({ x, y });

        return points;
    }

    loadDefaultTerrain() {
        const defaultPoints = this.generateRandomTerrain();

        for (const p of defaultPoints) {
            this.terrain.addPoint(p.x, p.y, this.selectedPresetType);
        }
        this.updateTerrainInfo();
        this.updateSegmentsList();
        // Ajustar punto de liberación por encima del terreno
        const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
        this.releasePoint.y = terrainY + 7;
        document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
        this.renderer.autoScale();
        this.updateZoomInfo();
    }

    updateReleasePoint() {
        this.releasePoint.x = clamp(document.getElementById('release-x').value, -100, 600, 10);
        const terrainY = this.terrain.getHeightAt(this.releasePoint.x);

        if (this.releaseMode === 'detachment') {
            // Snap to terrain surface
            this.releasePoint.y = terrainY;
            document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
        } else {
            this.releasePoint.y = clamp(document.getElementById('release-y').value, -100, 500, 55);
            // Alert user if release point is at or below terrain (auto-fix silently but warn)
            if (this.releasePoint.y <= terrainY + 1) {
                const oldY = this.releasePoint.y;
                this.releasePoint.y = terrainY + 5;
                document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
                console.info(`Release point auto-ajustado: ${oldY.toFixed(1)}m → ${this.releasePoint.y.toFixed(1)}m (dentro del terreno)`);
            }
        }
    }

    updateTerrainInfo() {
        const pts = this.terrain.points.length;
        const segs = this.terrain.segments ? this.terrain.segments.length : Math.max(0, pts - 1);
        const ptsEl = document.getElementById('terrain-points-count');
        const segEl = document.getElementById('terrain-segments-count');
        ptsEl.textContent = `Puntos perfil: ${pts}`;
        segEl.textContent = `Segmentos: ${segs}`;

        // Warning for high point count (>30 → amber, >40 → red)
        ptsEl.classList.remove('warning-amber', 'warning-red');
        if (pts >= 40) ptsEl.classList.add('warning-red');
        else if (pts >= 30) ptsEl.classList.add('warning-amber');

        const scaleInfo = document.getElementById('scale-info');
        if (scaleInfo) {
            scaleInfo.textContent = `1 px = ${(1 / this.terrain.scale).toFixed(2)} m`;
        }
        this.updateZoomInfo();
    }

    getSimulationParams() {
        // P03-6: el motor exige entero; se redondea, luego se acota a [1, 10000]
        // y el input muestra el valor efectivo. Un dato no numérico usa 100.
        const numRocksInput = document.getElementById('num-rocks');
        const rawNumRocks = parseFloat(numRocksInput.value);
        const numRocks = Number.isFinite(rawNumRocks)
            ? Math.min(10000, Math.max(1, Math.round(rawNumRocks))) : 100;
        if (numRocksInput) numRocksInput.value = String(numRocks);
        return {
            downhillMode: document.getElementById('downhill-mode')?.value || 'auto',
            numRocks,
            gravity: clamp(document.getElementById('gravity').value, 1, 20, 9.81),
            cn: this.physics.cn,
            ct: this.physics.ct,
            rollingFriction: this.physics.rollingFriction,
            cnVariability: clamp(document.getElementById('cn-variability').value, 0, 50, 10),
            ctVariability: clamp(document.getElementById('ct-variability').value, 0, 50, 10),
            timeStep: clamp(document.getElementById('time-step').value, 0.001, 0.05, 0.005),
            animationSpeed: this.simulation.animationSpeed,
            maxDuration: clamp(document.getElementById('max-duration').value, 1, 600, 30),
            ignoreResting: document.getElementById('ignore-resting').checked,
            fragmentationEnabled: this.physics.fragmentationEnabled,
            fractureEnergy: this.physics.fractureEnergy,
            fractureDissipation: this.physics.fractureDissipation
        };
    }

    // _invalidateResults(): runSimulation, stopSimulation, resetSimulation,
    // _completeRun (censura) y onerror de runSimulationWithWorker.
    _invalidateResults() {
        this._resultsValid = false;
        const count = document.getElementById('rock-count-display');
        if (count) { count.textContent = 'Rocas: 0'; count.classList.remove('warning-amber', 'warning-red'); }
        this.stats.results = null;
        this.renderer.probabilityPercentiles = null;
        const ids = ['stat-max-ke', 'stat-mean-ke', 'stat-max-bounce', 'stat-max-runout',
            'stat-max-velocity', 'stat-max-bounces', 'stat-savigny-angle', 'dash-stat-total',
            'dash-stat-max-ke', 'dash-stat-max-bounce', 'dash-stat-max-runout',
            'dash-stat-max-vel', 'dash-stat-savigny', 'dash-stat-p95'];
        ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '-'; });
        ['stat-n-rest', 'stat-pct-leaving', 'stat-reach-p95'].forEach(id => {
            const el = document.getElementById(id); if (el) el.textContent = '—';
        });
        const warnings = document.getElementById('stats-warnings');
        if (warnings) warnings.textContent = '';
        updateLineageBlock(null);
        const dashboard = document.getElementById('results-dashboard');
        if (dashboard) {
            dashboard.classList.add('hidden');
            dashboard.querySelectorAll('.chart-panel canvas').forEach(canvas => {
                canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            });
        }
        const placeholder = document.getElementById('results-placeholder-msg');
        const content = document.getElementById('results-sidebar-content');
        if (placeholder) placeholder.style.display = 'block';
        if (content) content.style.display = 'none';
        ['btn-export-csv', 'btn-export-report', 'btn-export-impacts', 'btn-dashboard-csv', 'btn-dashboard-report',
            'btn-dashboard-png', 'btn-open-dashboard'].forEach(id => {
            const el = document.getElementById(id); if (el) el.disabled = true;
        });
        const ctx = this.histogramCanvas.getContext('2d');
        ctx.fillStyle = '#1e2a4a';
        ctx.fillRect(0, 0, this.histogramCanvas.width, this.histogramCanvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '12px sans-serif';
        ctx.fillText('Sin datos', this.histogramCanvas.width / 2 - 20, this.histogramCanvas.height / 2);
    }

    // _completeRun(rocks, status, worker): onComplete normal y mensaje complete del worker.
    _completeRun(rocks, status, worker) {
        // Barrera común para los consumidores Stats y renderer.
        const isCompatibleResultRock = rock => {
            if (!rock || typeof rock !== 'object' || (!worker && typeof rock.getShapeVertices !== 'function')) return false;
            const numbers = ['x', 'y', 'finalX', 'finalY', 'rotation', 'radius', 'stepsTaken',
                'elapsedTime', 'bounces', 'maxKineticEnergy', 'maxBounceHeight', 'maxImpactVelocity'];
            if (!numbers.every(key => Number.isFinite(rock[key])) || rock.isResting !== true) return false;
            const finiteArray = array => Array.isArray(array) && Array.from(array).every(Number.isFinite);
            if (!finiteArray(rock.trajectory) || rock.trajectory.length % 3 !== 0 ||
                !finiteArray(rock.impactEnergies) || !Array.isArray(rock.bouncePoints) ||
                !Array.from(rock.bouncePoints).every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.energy)) ||
                !Array.isArray(rock.shape) || !Array.from(rock.shape).every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
            // Campos β del §2: cada uno se valida con su regla; un fallo rechaza la roca.
            const betaNumber = value => value === null || (Number.isFinite(value) && value >= 0);
            const eventKeys = ['t', 'x', 'y', 'surface', 'index', 'vn', 'speed', 'contactSpeed',
                'energy', 'cnEff', 'ctEff', 'flightHeightBefore'];
            const isImpactEvent = event => {
                if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
                const keys = Object.keys(event);
                if (keys.length !== eventKeys.length || !eventKeys.every(key => Object.hasOwn(event, key))) return false;
                const nums = [event.t, event.x, event.y, event.vn, event.speed, event.energy, event.cnEff, event.ctEff];
                if (!nums.every(Number.isFinite)) return false;
                // Magnitudes del §2: ninguna puede ser negativa.
                if (event.vn < 0 || event.speed < 0 || event.energy < 0) return false;
                if (!(event.contactSpeed === null || (Number.isFinite(event.contactSpeed) && event.contactSpeed >= 0))) return false;
                if (!(event.flightHeightBefore === null || Number.isFinite(event.flightHeightBefore))) return false;
                return ['terrain', 'barrier'].includes(event.surface) &&
                    Number.isInteger(event.index) && event.index >= 0;
            };
            if (!Number.isInteger(rock.impactCount) || rock.impactCount < 0 ||
                !betaNumber(rock.maxImpactNormalSpeed) || !betaNumber(rock.maxImpactSpeed) ||
                !betaNumber(rock.maxImpactContactSpeed) || !betaNumber(rock.maxImpactEnergy) ||
                !(rock.maxFlightHeight === null || Number.isFinite(rock.maxFlightHeight)) ||
                !Array.isArray(rock.impactEvents) || rock.impactEvents.length > 200 ||
                !rock.impactEvents.every(isImpactEvent) ||
                !Number.isInteger(rock.droppedImpactEvents) || rock.droppedImpactEvents < 0 ||
                rock.droppedImpactEvents !== rock.impactCount - rock.impactEvents.length) return false;
            if (!Number.isFinite(rock.releaseX) || !Number.isFinite(rock.releaseY) ||
                !Number.isInteger(rock.sourceIndex) || rock.sourceIndex < 0 ||
                ![1, -1, null].includes(rock.downhillSign) ||
                (rock.downhillSign === null ? rock.maxDownhillAdvance !== null : !Number.isFinite(rock.maxDownhillAdvance)) ||
                !['minX', 'maxX', 'minY', 'maxY', null].includes(rock.cullBoundary) ||
                (rock.stopReason !== 'culled' && rock.cullBoundary !== null)) return false;
            // Linaje P0.4 (§2): tipos por roca y coherencia de las primarias.
            const nonNegative = value => Number.isFinite(value) && value >= 0;
            const isRockId = value => Number.isInteger(value) && value >= 1;
            if (!isRockId(rock.id) || !(rock.parentId === null || isRockId(rock.parentId)) ||
                !isRockId(rock.rootId) || !['primary', 'core', 'major', 'spall'].includes(rock.fragmentKind) ||
                !nonNegative(rock.bornAt) || !nonNegative(rock.discardedMass) ||
                (rock.parentId === null) !== (rock.fragmentKind === 'primary') ||
                (rock.parentId === null && rock.rootId !== rock.id)) return false;
            if (!rock.color || !['r', 'g', 'b'].every(key => Number.isFinite(rock.color[key]))) return false;
            return ['_colorActive', '_colorResting', '_colorStroke'].every(key => typeof rock[key] === 'string');
        };
        // Validación de conjunto del linaje (§3); supone rocas ya validadas una a una.
        const isValidLineageSet = list => {
            const byId = new Map();
            for (const rock of list) {
                if (byId.has(rock.id)) return false;
                byId.set(rock.id, rock);
            }
            // E1.3: `fragmentKind` coherente con `isCore` y `generation` (physics.js: primaria,
            // constructor de Rock; `core` conserva la generación; `major` y `spall` suman 1).
            const generationOf = rock => rock.parentId === null && rock.generation === undefined ? 0 : rock.generation;
            const parents = new Set();
            for (const rock of list) {
                if (!byId.has(rock.rootId)) return false;
                if (rock.parentId === null) {
                    if (rock.isCore === true || generationOf(rock) !== 0) return false;
                    continue;
                }
                const parent = byId.get(rock.parentId);
                if (!parent || parent.stopReason !== 'fragmented' || parent.rootId !== rock.rootId) return false;
                // E1.3: el hijo nace en el `elapsedTime` final del padre.
                if (!(Math.abs(rock.bornAt - parent.elapsedTime) <= 1e-9)) return false;
                const step = rock.fragmentKind === 'core' ? 0 : 1;
                if (!Number.isInteger(rock.generation) || rock.generation !== generationOf(parent) + step ||
                    rock.isCore !== (rock.fragmentKind !== 'spall')) return false;
                parents.add(rock.parentId);
            }
            // E1.3: toda entidad `fragmented` tiene al menos un hijo en el conjunto.
            for (const rock of list) {
                if (rock.stopReason === 'fragmented' && !parents.has(rock.id)) return false;
            }
            // Sin ciclos: toda cadena de parentId termina en una primaria.
            const rooted = new Set();
            for (const rock of list) {
                const path = new Set();
                let current = rock;
                while (current.parentId !== null && !rooted.has(current.id)) {
                    if (path.has(current.id)) return false;
                    path.add(current.id);
                    current = byId.get(current.parentId);
                }
                path.forEach(id => rooted.add(id));
            }
            return true;
        };
        const allowed = ['rest', 'culled', 'maxTime', 'maxSteps', 'fragmented', 'cancelled', 'safetyLimit'];
        const counts = {};
        let incompatible = !Array.isArray(rocks) || rocks.length === 0 || !['completed', 'safetyLimit'].includes(status);
        const hasRockList = Array.isArray(rocks);
        if (!hasRockList) rocks = [];
        let safeRocks = rocks.filter(r => isCompatibleResultRock(r));
        if (!hasRockList || safeRocks.length !== rocks.length) {
            incompatible = true;
            // Los frames se indexan por roca: no deben apuntar a un subconjunto distinto.
            this.simulation.frames = [];
        } else if (!isValidLineageSet(safeRocks)) {
            // Linaje incoherente: se rechaza la corrida entera, sin rocas ni frames.
            incompatible = true;
            safeRocks = [];
            this.simulation.frames = [];
        }
        if (worker) safeRocks.forEach(r => { r.getShapeVertices = this._workerRockShapeVertices; });
        this.simulation.rocks = safeRocks;
        this.simulation.finishedRocks = safeRocks.filter(r => r.isResting);
        this.simulation.simulatedCount = safeRocks.length;
        rocks.forEach(r => {
            const reason = r && r.stopReason;
            if (!allowed.includes(reason)) incompatible = true;
            const key = allowed.includes(reason) ? reason : 'desconocido';
            counts[key] = (counts[key] || 0) + 1;
        });
        const invalid = status === 'safetyLimit' || incompatible ||
            rocks.some(r => r && ['cancelled', 'safetyLimit'].includes(r.stopReason));
        const summary = Object.entries(counts).map(([reason, count]) => `${reason}: ${count}`).join(', ');
        let message;
        // Con fragmentación (results.lineage) el conteo visible es por roca original, no por entidad.
        let publishedCount = rocks.length;
        if (invalid) {
            this._invalidateResults();
            message = `Corrida incompleta/censurada${incompatible ? ' (protocolo incompatible)' : ''}: ${summary || 'sin datos'}${status === 'safetyLimit' ? ' (límite de seguridad)' : ''}`;
        } else {
            // Misma regla de época que _runSources: solo la corrida vigente aporta
            // sus valores efectivos, copiados como primitivas.
            const info = this._runInfo && this._runInfo.epoch === this._runEpoch ?
                {
                    timeStep: this._runInfo.timeStep, calcMethod: this._runInfo.calcMethod,
                    cnVariability: this._runInfo.cnVariability, ctVariability: this._runInfo.ctVariability,
                    segments: this._runInfo.segments.map(segment => ({ ...segment })),
                    seed: this._runInfo.seed, rngAlgorithm: this._runInfo.rngAlgorithm,
                    engineVersion: this._runInfo.engineVersion, correlatedParams: this._runInfo.correlatedParams
                } : null;
            this.stats.compute(rocks, this.releasePoint, info);
            const result = this.stats.results;
            if (result.status === 'bloqueado') {
                const reason = result.blockedReason;
                this._invalidateResults();
                message = `Resultados bloqueados (${reason}): ${summary || 'sin datos'}`;
            } else {
                this.stats.updateUI();
                updateLineageBlock(result);
                this.renderer.renderHistogram(this.histogramCanvas, result);
                const population = result.population;
                const sign = rocks[0].downhillSign;
                const sourceIndex = population.sources[0];
                // Sin instantánea solo se admite compatibilidad con llamadas directas de prueba.
                const snapshot = this._runSources;
                const sources = snapshot ? (snapshot.epoch === this._runEpoch ? (snapshot.multi || [snapshot.single]) : []) :
                    (this.multiReleaseEnabled && this.multiReleasePoints?.length ? this.multiReleasePoints : [this.releasePoint]);
                const source = sources[sourceIndex];
                const mapEligible = population.sources.length === 1 && population.directionResolved && result.reachBounds &&
                    rocks.every(r => r.downhillSign === sign) && source && Number.isFinite(source.x);
                this.renderer.probabilityPercentiles = mapEligible ? {
                    originX: source.x, sign, title: 'Alcance máximo',
                    bands: [10, 50, 83, 95].map(p => ({ label: `P${p}`, value: result.reachBounds[`p${p}`].lower, exact: result.reachBounds[`p${p}`].exact }))
                } : null;
                this._resultsValid = true;
                const placeholder = document.getElementById('results-placeholder-msg');
                const content = document.getElementById('results-sidebar-content');
                if (placeholder) placeholder.style.display = 'none';
                if (content) content.style.display = 'block';
                ['btn-export-csv', 'btn-export-report', 'btn-dashboard-csv', 'btn-dashboard-report',
                    'btn-dashboard-png', 'btn-open-dashboard'].forEach(id => {
                    const el = document.getElementById(id); if (el) el.disabled = false;
                });
                const impactsBtn = document.getElementById('btn-export-impacts');
                if (impactsBtn) impactsBtn.disabled = result.impactExportAvailable !== true;
                const warnings = result.warnings.map(w => w.message).join(' ');
                let mapReason = '';
                if (!mapEligible) {
                    const cause = population.sources.length !== 1 ? 'varias fuentes o ninguna fuente' :
                        !population.directionResolved || !rocks.every(r => r.downhillSign === sign) ? 'sentido ambiguo o no común' :
                        !result.reachBounds ? 'cotas de alcance no disponibles' : 'origen nominal no disponible';
                    mapReason = ` Mapa no disponible: ${cause}.`;
                }
                const lineage = result.lineage;
                const format = value => Number.isFinite(value) ? value.toFixed(1) : '—';
                if (lineage) publishedCount = lineage.primaries;
                const subject = lineage ? `${lineage.primaries} rocas originales` : `${rocks.length} rocas`;
                const detail = lineage ?
                    `${lineage.leaves} piezas finales, masa en reposo ${format(lineage.mass && lineage.mass.rest)} kg (entidades: ${summary})` : summary;
                message = `${result.status === 'parcial' ? 'Resultado parcial' : 'Completado'} (${subject}${worker ? ', Worker' : ''}): ${detail}. ${warnings}${mapReason}`;
            }
        }
        document.getElementById('simulation-status').textContent = message;
        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        const fab = document.getElementById('fab-run');
        if (fab) { fab.classList.remove('running'); fab.textContent = '▶'; }
        const count = document.getElementById('rock-count-display');
        if (count && this._resultsValid) count.textContent = `Rocas: ${publishedCount}`;
        if (this.simulation.frameCount > 0) this.activateTimeline();
    }

    runSimulation() {
        if (this.terrain.points.length < 2) {
            alert('Define al menos 2 puntos del perfil del terreno.');
            return;
        }

        // P0.5: la semilla se resuelve antes de cada corrida y antes de tocar
        // cualquier estado; si es inválida, la corrida no arranca.
        const seed = resolveRunSeed();
        if (seed === null) return;

        const diameter = clamp(document.getElementById('rock-diameter').value, 0.1, 20, 0.5);
        const density = clamp(document.getElementById('rock-density').value, 1000, 5000, 2700);
        const initVel = clamp(document.getElementById('initial-velocity').value, 0, 100, 0);
        const angle = clamp(document.getElementById('release-angle').value, -90, 90, 0);
        const shapeType = document.getElementById('rock-shape').value;
        const aspectRatio = clamp(document.getElementById('rock-aspect-ratio').value, 0.2, 1, 0.6);

        if (this.releaseMode === 'detachment') {
            const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
            this.releasePoint.y = terrainY + diameter * 0.55;
            document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
        } else {
            const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
            if (this.releasePoint.y <= terrainY) {
                alert(`El punto de liberación está dentro del terreno. Se ajusta automáticamente a Y=${(terrainY + 5).toFixed(1)}m`);
                this.releasePoint.y = terrainY + 5;
                document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
            } else {
                const gap = this.releasePoint.y - terrainY;
                if (gap < 5) {
                    const suggestedY = terrainY + 5;
                    if (!confirm(`El punto de liberación está a solo ${gap.toFixed(1)}m sobre el terreno — riesgo de embed. ¿Ajustar a Y=${suggestedY.toFixed(1)}m?`)) {
                        return;
                    }
                    this.releasePoint.y = suggestedY;
                    document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
                }
            }
        }

        // Validate multi-release points if enabled
        let multiPoints = null;
        if (this.multiReleaseEnabled && this.multiReleasePoints.length > 0) {
            multiPoints = this.multiReleasePoints.map(p => {
                const pp = { ...p };
                if (this.releaseMode === 'detachment') {
                    const tY = this.terrain.getHeightAt(pp.x);
                    pp.y = tY + diameter * 0.55;
                } else {
                    const tY = this.terrain.getHeightAt(pp.x);
                    if (pp.y <= tY) {
                        pp.y = tY + 5;
                    }
                }
                return pp;
            });
        }

        this._runEpoch = (this._runEpoch || 0) + 1;
        const runEpoch = this._runEpoch;
        // Guardar las coordenadas nominales ajustadas enviadas en esta época.
        this._runSources = {
            epoch: runEpoch,
            single: { x: this.releasePoint.x, y: this.releasePoint.y },
            multi: multiPoints && multiPoints.length ? multiPoints.map(p => ({ ...p })) : null
        };
        if (this.animationId !== null && this.animationId !== undefined) cancelAnimationFrame(this.animationId);
        if (this._worker) this._worker.terminate();
        this._worker = null;
        this._workerActive = false;
        this._workerRocks = null;
        this._invalidateResults();
        this.hideTimeline();

        // La misma semilla viaja en params por ambos caminos: configure() en
        // el modo normal y simParams en el mensaje del Worker.
        const params = this.getSimulationParams();
        params.seed = seed;
        this.simulation.configure(params);

        this.simulation.onUpdate = (data) => {
            if (runEpoch !== this._runEpoch) return;
            this.render();
            const progress = Math.round(data.progress * 100);
            document.getElementById('simulation-status').textContent =
                `Simulando... ${progress}% (${this.simulation.simulatedCount}/${this.simulation.totalRocks}) · semilla ${seed}`;
            const rockCountEl = document.getElementById('rock-count-display');
            if (rockCountEl) {
                const count = this.simulation.simulatedCount;
                rockCountEl.textContent = `Rocas: ${count}`;
                rockCountEl.classList.remove('warning-amber', 'warning-red');
                if (count >= 800) rockCountEl.classList.add('warning-red');
                else if (count >= 500) rockCountEl.classList.add('warning-amber');
            }
        };

        this.simulation.onComplete = (rocks) => {
            if (runEpoch !== this._runEpoch) return;
            this._completeRun(rocks, 'completed', false);
        };

        this.simulation.start(
            this.releasePoint.x,
            this.releasePoint.y,
            diameter,
            density,
            initVel,
            angle,
            params.maxDuration,
            params.ignoreResting,
            shapeType,
            aspectRatio,
            this.releaseMode,
            multiPoints
        );

        // Captura por época de los valores efectivos de esta corrida. Se toma del
        // motor de la simulación (en producción this.physics === this.simulation.physics);
        // son primitivas copiadas y no se releen los controles al exportar.
        this._runInfo = {
            epoch: runEpoch,
            timeStep: this.simulation.physics.dt,
            calcMethod: this.simulation.physics.calcMethod,
            cnVariability: this.simulation.physics.cnVariability,
            ctVariability: this.simulation.physics.ctVariability,
            segments: copyRunSegments(this.terrain),
            seed,
            rngAlgorithm: SimRocas.RNG_ALGORITHM || null,
            engineVersion: typeof WORKER_VERSION === 'number' ? WORKER_VERSION : null,
            correlatedParams: this.simulation.physics.correlatedParams === true
        };
        showSeedUsed(seed);

        document.getElementById('btn-run').disabled = true;
        document.getElementById('btn-stop').disabled = false;
        document.getElementById('simulation-status').textContent = `Simulando... (semilla ${seed})`;
        const fabStart = document.getElementById('fab-run');
        if (fabStart) {
            fabStart.classList.add('running');
            fabStart.textContent = '⏹';
        }

        // Check if Web Worker mode is enabled
        if (document.getElementById('use-worker').checked) {
            this.runSimulationWithWorker(diameter, density, initVel, angle, shapeType, aspectRatio, params, multiPoints);
        } else {
            this.animate();
        }
    }

    animate() {
        if (!this.simulation.isRunning) return;

        this.simulation.step();
        this._doRender();
        const runEpoch = this._runEpoch;
        this.animationId = requestAnimationFrame(() => {
            if (runEpoch === this._runEpoch) this.animate();
        });
    }

    /**
     * Runs simulation in chunks to avoid blocking the browser.
     * Uses setTimeout to yield between batches for high animation speeds.
     */
    _animateChunked() {
        if (!this.simulation.isRunning) return;

        // At high speeds, run multiple steps per frame to keep up
        const chunks = Math.ceil(this.simulation.animationSpeed / 10);
        for (let c = 0; c < chunks; c++) {
            this.simulation.step();
            if (!this.simulation.isRunning) break;
        }

        if (this.simulation.isRunning) {
            const runEpoch = this._runEpoch;
            setTimeout(() => {
                if (runEpoch === this._runEpoch) this._animateChunked();
            }, 0);
        }
    }

    stopSimulation() {
        this._runEpoch = (this._runEpoch || 0) + 1;
        if (this.animationId !== null && this.animationId !== undefined) cancelAnimationFrame(this.animationId);
        const workerRun = this._workerActive;
        if (this._worker && this._workerActive) {
            this._worker.terminate();
            this._workerActive = false;
        }

        this._worker = null;
        this._workerRocks = null;
        this.simulation.stop();
        if (workerRun) {
            this.simulation.rocks = [];
            this.simulation.finishedRocks = [];
            this.simulation.frames = [];
        }
        this._invalidateResults();
        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        const counts = {};
        if (!workerRun) {
            this.simulation.rocks.forEach(rock => {
                const reason = rock.stopReason || 'desconocido';
                counts[reason] = (counts[reason] || 0) + 1;
            });
        }
        const summary = Object.entries(counts).map(([reason, count]) => `${reason}: ${count}`).join(', ');
        document.getElementById('simulation-status').textContent = workerRun
            ? 'Corrida incompleta: cancelada por usuario (Worker; resultados descartados)'
            : `Corrida incompleta: cancelada por usuario${summary ? ` — ${summary}` : ''}`;
        const fabStop = document.getElementById('fab-run');
        if (fabStop) {
            fabStop.classList.remove('running');
            fabStop.textContent = '▶';
        }

        if (this.simulation.frameCount > 1) {
            this.activateTimeline();
        } else {
            this.render();
        }
    }

    resetSimulation() {
        this._runEpoch = (this._runEpoch || 0) + 1;
        if (this.animationId !== null && this.animationId !== undefined) cancelAnimationFrame(this.animationId);
        this._invalidateResults();
        this._workerRocks = null;
        this.hideTimeline();
        if (this._worker && this._workerActive) {
            this._worker.terminate();
            this._workerActive = false;
        }
        this._worker = null;
        this.simulation.reset();
        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        document.getElementById('simulation-status').textContent = 'Listo';
        const fab = document.getElementById('fab-run');
        if (fab) { fab.classList.remove('running'); fab.textContent = '▶'; }

        this.render();
    }


    render() {
        if (this._renderPending) return;
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            this._doRender();
        });
    }

    _doRender() {
        if (this.timelineActive && !this.simulation.isRunning && this.simulation.frameCount > 0) {
            this.renderTimelineFrame();
        } else {
            this.renderer.releaseMode = this.releaseMode;
            this.renderer.multiReleasePoints = (this.multiReleaseEnabled && this.multiReleasePoints.length > 0)
                ? this.multiReleasePoints : null;
            this.renderer.barriers = this.barriers || [];
            this.renderer.render(
                this.simulation.isRunning || this.simulation.rocks.length > 0 ? this.simulation : null,
                this.releasePoint.x,
                this.releasePoint.y
            );
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});

// Export to namespace
SimRocas.App = App;
SimRocas.clamp = clamp;
SimRocas.copyRunSegments = copyRunSegments;
SimRocas.syncVariabilityLabels = syncVariabilityLabels;
window.SimRocas = SimRocas; // Make namespace globally accessible
