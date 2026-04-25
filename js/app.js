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
        this.setupSidebarResize();
        this.setupTerrainControls();
        this.setupSegmentEditor();
        this.setupParameterControls();
        this.setupSimulationControls();
        this.setupTimelineControls();
        this.setupCanvasInteraction();
        this.setupToolbarControls();
        this.setupExportControls();
        this.setupKeyboardShortcuts();
        this.setupBarrierControls();
        this.setupResize();
        this.loadDefaultTerrain();
        this.renderer.resize();
        this.render();
    }

    setupTabs() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
            });
        });
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
        document.getElementById('btn-add-point').addEventListener('click', () => {
            const x = parseFloat(document.getElementById('input-x').value);
            const y = parseFloat(document.getElementById('input-y').value);
            if (!isNaN(x) && !isNaN(y)) {
                this.terrain.addPoint(x, y, this.selectedPresetType);
                this.updateTerrainInfo();
                this.updateSegmentsList();
                this.render();
            }
        });

        document.getElementById('btn-clear-terrain').addEventListener('click', () => {
            if (confirm('¿Limpiar todo el perfil?')) {
                this.terrain.clear();
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
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (ext === 'csv') {
                        this.terrain.fromCSV(ev.target.result);
                    } else {
                        this.terrain.fromJSON(ev.target.result);
                    }
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
            navigator.clipboard.readText().then((text) => {
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
            this.terrain.applyPresetToRange(this.selectedPresetType, from, to);
            this.updateSegmentsList();
            this.render();
        });

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
                    <span class="segment-coeffs">Cn:${seg.cn.toFixed(2)} Ct:${seg.ct.toFixed(2)}</span>
                </div>
            `;
        }
        list.innerHTML = html;

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

    updateZoomInfo() {
        const zoomPercent = Math.round(this.terrain.scale / 2 * 100);
        const el = document.getElementById('zoom-level');
        if (el) el.textContent = `Zoom: ${zoomPercent}%`;
    }

    setupExportControls() {
        document.getElementById('btn-export-image').addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = 'simrocas-simulation.png';
            link.href = this.canvas.toDataURL('image/png');
            link.click();
        });

        document.getElementById('btn-export-csv').addEventListener('click', () => {
            const csv = this.stats.generateCSV();
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simrocas-results.csv';
            a.click();
            URL.revokeObjectURL(url);
        });

        document.getElementById('btn-export-report').addEventListener('click', () => {
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

            // Escape — detener simulación
            if (e.key === 'Escape') {
                if (this.simulation.isRunning) this.stopSimulation();
                return;
            }

            // Ctrl+Z — deshacer último punto del terreno
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                if (this.terrain.points.length > 0) {
                    this.terrain.removePoint(this.terrain.points.length - 1);
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
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const world = this.terrain.canvasToWorld(cx, cy);

            if (document.getElementById('tab-terrain').classList.contains('active')) {
                this.terrain.addPoint(world.wx, world.wy, this.selectedPresetType);
                this.updateTerrainInfo();
                this.updateSegmentsList();
            } else {
                const terrainY = this.terrain.getHeightAt(world.wx);
                this.releasePoint.x = world.wx;
                if (this.releaseMode === 'detachment') {
                    // Snap release point to terrain surface
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
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const idx = this.terrain.findNearestPoint(cx, cy);
            if (idx >= 0) {
                this.terrain.removePoint(idx);
                this.updateTerrainInfo();
                this.updateSegmentsList();
                this.render();
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const world = this.terrain.canvasToWorld(cx, cy);
            document.getElementById('cursor-coords').textContent =
                `X: ${world.wx.toFixed(1)} m | Y: ${world.wy.toFixed(1)} m`;
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
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

        // Pan con botón central o Shift+clic izquierdo
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
                e.preventDefault();
                this.isPanning = true;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.canvas.style.cursor = 'grabbing';
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isPanning) {
                const dx = e.clientX - this.panStart.x;
                const dy = e.clientY - this.panStart.y;
                this.terrain.offsetX += dx;
                this.terrain.offsetY -= dy;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.render();
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            if (this.isPanning && (e.button === 1 || (e.button === 0))) {
                this.isPanning = false;
                this.canvas.style.cursor = 'crosshair';
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.isPanning = false;
            this.canvas.style.cursor = 'crosshair';
        });
    }

    setupResize() {
        window.addEventListener('resize', () => {
            this.renderer.resize();
            this.render();
        });
        setTimeout(() => this.renderer.resize(), 100);
    }

    loadDefaultTerrain() {
        const defaultPoints = [
            { x: 0, y: 50 },
            { x: 5, y: 50 },
            { x: 10, y: 48 },
            { x: 15, y: 42 },
            { x: 20, y: 35 },
            { x: 25, y: 28 },
            { x: 30, y: 22 },
            { x: 35, y: 18 },
            { x: 40, y: 15 },
            { x: 45, y: 14 },
            { x: 50, y: 12 },
            { x: 55, y: 10 },
            { x: 60, y: 8 },
            { x: 65, y: 6 },
            { x: 70, y: 5 },
            { x: 75, y: 4 },
            { x: 80, y: 3 },
            { x: 85, y: 2.5 },
            { x: 90, y: 2 },
            { x: 100, y: 1.5 },
            { x: 120, y: 1 },
            { x: 150, y: 0.5 },
            { x: 180, y: 0 },
            { x: 200, y: 0 }
        ];

        for (const p of defaultPoints) {
            this.terrain.addPoint(p.x, p.y, this.selectedPresetType);
        }
        this.updateTerrainInfo();
        this.updateSegmentsList();
        // Ajustar punto de liberación por encima del terreno
        const terrainY = this.terrain.getHeightAt(this.releasePoint.x);
        this.releasePoint.y = terrainY + 7;
        document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
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
            // Asegurar que la roca esté por encima del terreno
            if (this.releasePoint.y <= terrainY + 1) {
                this.releasePoint.y = terrainY + 5;
                document.getElementById('release-y').value = this.releasePoint.y.toFixed(1);
            }
        }
    }

    updateTerrainInfo() {
        document.getElementById('terrain-points-count').textContent =
            `Puntos perfil: ${this.terrain.points.length}`;
        const scaleInfo = document.getElementById('scale-info');
        if (scaleInfo) {
            scaleInfo.textContent = `1 px = ${(1 / this.terrain.scale).toFixed(2)} m`;
        }
        this.updateZoomInfo();
    }

    getSimulationParams() {
        return {
            numRocks: clamp(document.getElementById('num-rocks').value, 1, 10000, 100),
            gravity: clamp(document.getElementById('gravity').value, 1, 20, 9.81),
            cn: this.physics.cn,
            ct: this.physics.ct,
            rollingFriction: this.physics.rollingFriction,
            cnVariability: clamp(document.getElementById('cn-variability').value, 0, 50, 10),
            ctVariability: clamp(document.getElementById('ct-variability').value, 0, 50, 10),
            timeStep: clamp(document.getElementById('time-step').value, 0.001, 0.05, 0.005),
            animationSpeed: this.simulation.animationSpeed,
            maxDuration: clamp(document.getElementById('max-duration').value, 1, 600, 30),
            ignoreResting: document.getElementById('ignore-resting').checked
        };
    }

    runSimulation() {
        if (this.terrain.points.length < 2) {
            alert('Define al menos 2 puntos del perfil del terreno.');
            return;
        }

        this.hideTimeline();
        this.updateReleasePoint();

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

        const params = this.getSimulationParams();
        this.simulation.configure(params);

        this.simulation.onUpdate = (data) => {
            this.render();
            const progress = Math.round(data.progress * 100);
            document.getElementById('simulation-status').textContent =
                `Simulando... ${progress}% (${this.simulation.simulatedCount}/${this.simulation.totalRocks})`;
        };

        this.simulation.onComplete = (rocks) => {
            this.stats.compute(rocks, this.releasePoint);
            this.stats.updateUI();
            this.renderer.renderHistogram(this.histogramCanvas, rocks);

            // Compute probability map percentiles
            const rd = this.stats.results.runoutDistance;
            const sorted = [...rocks.filter(r => r.isResting).map(r => r.finalX)].sort((a, b) => a - b);
            if (sorted.length > 0) {
                const p = (arr, pct) => {
                    const idx = (pct / 100) * (arr.length - 1);
                    const lo = Math.floor(idx);
                    const hi = Math.ceil(idx);
                    const f = idx - lo;
                    return arr[lo] * (1 - f) + arr[hi] * f;
                };
                this.renderer.probabilityPercentiles = {
                    p10: p(sorted, 10),
                    p50: p(sorted, 50),
                    p83: p(sorted, 83),
                    p95: p(sorted, 95),
                    mean: rd.mean
                };
            }

            document.getElementById('simulation-status').textContent =
                `Completado (${rocks.length} rocas)`;
            document.getElementById('btn-run').disabled = false;
            document.getElementById('btn-stop').disabled = true;
            this.activateTimeline();
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

        document.getElementById('btn-run').disabled = true;
        document.getElementById('btn-stop').disabled = false;
        document.getElementById('simulation-status').textContent = 'Simulando...';

        // Check if Web Worker mode is enabled
        if (document.getElementById('use-worker').checked) {
            this.runSimulationWithWorker(diameter, density, initVel, angle, shapeType, aspectRatio, params, multiPoints);
        } else {
            this.animate();
        }
    }

    runSimulationWithWorker(diameter, density, initVel, angle, shapeType, aspectRatio, params, multiPoints) {
        if (this._worker) {
            this._worker.terminate();
        }

        this._worker = new Worker('js/worker.js');
        this._workerActive = true;

        // Build rock configs for worker
        const origins = (multiPoints && multiPoints.length > 0)
            ? multiPoints
            : [{ x: this.releasePoint.x, y: this.releasePoint.y, velocity: initVel, angle: angle }];

        const perOrigin = Math.ceil(this.simulation.totalRocks / origins.length);
        const rockConfigs = [];
        let created = 0;

        for (const origin of origins) {
            const count = Math.min(perOrigin, this.simulation.totalRocks - created);
            const oVel = origin.velocity !== undefined ? origin.velocity : initVel;
            const oAng = origin.angle !== undefined ? origin.angle : angle;
            for (let i = 0; i < count; i++) {
                rockConfigs.push({
                    x: origin.x + (Math.random() - 0.5) * diameter,
                    y: origin.y + (this.releaseMode === 'detachment' ? 0 : (Math.random() - 0.5) * diameter * 0.5),
                    diameter, density,
                    velocity: oVel,
                    angle: oAng,
                    shapeType, aspectRatio
                });
            }
            created += count;
        }

        const terrainData = {
            points: this.terrain.points,
            segmentMaterials: this.terrain.segmentMaterials || []
        };

        const config = {
            gravity: this.simulation.physics.gravity,
            dt: this.simulation.physics.dt,
            cn: this.simulation.physics.cn,
            ct: this.simulation.physics.ct,
            maxStepsPerRock: this.simulation.maxStepsPerRock,
            maxDuration: params.maxDuration || 30,
            animationSpeed: this.simulation.animationSpeed
        };

        this._worker.onmessage = (e) => {
            const msg = e.data;

            if (msg.type === 'progress') {
                const progress = Math.round(msg.data.progress * 100);
                document.getElementById('simulation-status').textContent =
                    `Simulando (Worker)... ${progress}% (${msg.data.simulatedCount}/${msg.data.totalRocks})`;
            }

            if (msg.type === 'frame') {
                // Reconstruct lightweight rock objects for rendering
                if (!this._workerRocks || this._workerRocks.length !== msg.frame.length) {
                    this._workerRocks = msg.frame.map(f => ({ isResting: f.isResting }));
                }
                for (let i = 0; i < msg.frame.length; i++) {
                    const f = msg.frame[i];
                    const r = this._workerRocks[i];
                    r.x = f.x;
                    r.y = f.y;
                    r.rotation = f.rotation;
                    r.isResting = f.isResting;
                }
                this._renderWorkerFrame();
            }

            if (msg.type === 'complete') {
                this._workerActive = false;
                // Reconstruct full rocks for stats
                const rocks = msg.rocks;
                this.simulation.rocks = rocks;
                this.simulation.finishedRocks = rocks.filter(r => r.isResting);
                this.simulation.simulatedCount = rocks.length;
                this.simulation.isRunning = false;

                this.stats.compute(rocks, this.releasePoint);
                this.stats.updateUI();
                this.renderer.renderHistogram(this.histogramCanvas, rocks);

                // Probability map
                const rd = this.stats.results.runoutDistance;
                const sorted = [...rocks.filter(r => r.isResting).map(r => r.finalX)].sort((a, b) => a - b);
                if (sorted.length > 0) {
                    const p = (arr, pct) => {
                        const idx = (pct / 100) * (arr.length - 1);
                        const lo = Math.floor(idx);
                        const hi = Math.ceil(idx);
                        const f = idx - lo;
                        return arr[lo] * (1 - f) + arr[hi] * f;
                    };
                    this.renderer.probabilityPercentiles = {
                        p10: p(sorted, 10), p50: p(sorted, 50),
                        p83: p(sorted, 83), p95: p(sorted, 95), mean: rd.mean
                    };
                }

                document.getElementById('simulation-status').textContent =
                    `Completado (${rocks.length} rocas, Worker)`;
                document.getElementById('btn-run').disabled = false;
                document.getElementById('btn-stop').disabled = true;
                this.activateTimeline();
                this.render();
            }
        };

        this._worker.onerror = (err) => {
            console.error('Worker error:', err);
            alert('Error en Web Worker. Revisa la consola.');
            this._workerActive = false;
            document.getElementById('btn-run').disabled = false;
            document.getElementById('btn-stop').disabled = true;
        };

        this._worker.postMessage({
            type: 'start',
            terrainData,
            rockConfigs,
            config,
            barriers: this.barriers || []
        });
    }

    _renderWorkerFrame() {
        if (!this._workerRocks) return;
        // Quick render: just positions as dots
        const ctx = this.canvas.getContext('2d');
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;

        // Use the standard render pipeline but with worker rocks as positions
        this.renderer.render(null, this.releasePoint.x, this.releasePoint.y);

        // Overlay worker rock positions
        const rocks = this._workerRocks;
        ctx.fillStyle = 'rgba(180, 160, 140, 0.7)';
        for (let i = 0; i < rocks.length; i++) {
            const r = rocks[i];
            if (r.isResting) continue;
            const cx = r.x * scale + offsetX;
            const cy = canvasH - (r.y * scale + offsetY);
            ctx.beginPath();
            ctx.arc(cx, cy, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    animate() {
        if (!this.simulation.isRunning) return;

        this.simulation.step();
        this._doRender();
        this.animationId = requestAnimationFrame(() => this.animate());
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
            setTimeout(() => this._animateChunked(), 0);
        }
    }

    stopSimulation() {
        if (this._worker && this._workerActive) {
            this._worker.terminate();
            this._workerActive = false;
        }

        this.simulation.stop();
        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        document.getElementById('simulation-status').textContent = 'Detenido por usuario';

        this.stats.compute(this.simulation.rocks, this.releasePoint);
        this.stats.updateUI();
        this.renderer.renderHistogram(this.histogramCanvas, this.simulation.rocks);

        if (this.simulation.frameCount > 1) {
            this.activateTimeline();
        } else {
            this.render();
        }
    }

    resetSimulation() {
        this.hideTimeline();
        if (this._worker && this._workerActive) {
            this._worker.terminate();
            this._workerActive = false;
        }
        this.simulation.reset();
        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        document.getElementById('simulation-status').textContent = 'Listo';

        ['stat-max-ke', 'stat-mean-ke', 'stat-max-bounce', 'stat-max-runout',
          'stat-max-velocity', 'stat-max-bounces', 'stat-savigny-angle'].forEach(id => {
            document.getElementById(id).textContent = '-';
        });

        const ctx = this.histogramCanvas.getContext('2d');
        ctx.fillStyle = '#1e2a4a';
        ctx.fillRect(0, 0, this.histogramCanvas.width, this.histogramCanvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '12px sans-serif';
        ctx.fillText('Sin datos', this.histogramCanvas.width / 2 - 20, this.histogramCanvas.height / 2);

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
window.SimRocas = SimRocas; // Make namespace globally accessible
