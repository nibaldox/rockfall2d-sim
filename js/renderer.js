class Renderer {
    constructor(canvas, terrain) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.terrain = terrain;
        this.showRiskZones = false;
        this.showTrajectories = true;
        this.showProbabilityMap = false;
        this.probabilityPercentiles = null;
        this.releaseMode = 'freefall';
        this.multiReleasePoints = null;
        this.barriers = [];
        this._cssVars = {};
        this._getCssVar = (name, defaultValue = '') => {
            if (!(name in this._cssVars)) {
                this._cssVars[name] = getComputedStyle(document.documentElement)
                    .getPropertyValue(name).trim() || defaultValue;
            }
            return this._cssVars[name] || defaultValue;
        };
        this.terrain.colors = {
            fill: this._getCssVar('--canvas-terrain-fill', 'rgba(139, 90, 43, 0.6)'),
            stroke: this._getCssVar('--canvas-terrain-stroke', '#8B5A2B'),
            points: this._getCssVar('--canvas-terrain-points', '#e94560')
        };
        this.gridColor = this._getCssVar('--canvas-grid', 'rgba(255, 255, 255, 0.05)');
        this.axisColor = this._getCssVar('--canvas-axis', 'rgba(255, 255, 255, 0.3)');
        this.textColor = this._getCssVar('--canvas-text', 'rgba(255, 255, 255, 0.5)');
        this.trajectoryColor = this._getCssVar('--canvas-trajectory', 'rgba(78, 205, 196, 0.3)');
        this.releaseFreefallColor = this._getCssVar('--canvas-release-freefall', '#ffa500');
        this.releaseDetachmentColor = this._getCssVar('--canvas-release-detachment', '#4ecdc4');
        this.histogramBg = this._getCssVar('--canvas-histogram-bg', '#1e2a4a');
        this._hexCache = {};
        this.activeTab = 'terrain';
        this.currentStl = null;
        this.sliceLine = { x1: 0, y1: 0, x2: 0, y2: 0, active: false };
        this.stlUpAxis = 'Z';
        this.stlHeightmap = null;
        this.stlContours = [];
        this.stlContourInterval = 10;
        this.highlightSegmentIndex = -1;
    }

    resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const toolbarHeight = 36;
        const timelineBar = document.getElementById('timeline-bar');
        const timelineHeight = (timelineBar && timelineBar.classList.contains('visible')) ? 40 : 0;
        this.canvas.width = rect.width;
        this.canvas.height = rect.height - toolbarHeight - timelineHeight;
        this.terrain.canvas = this.canvas;
        this.autoScale();
    }

    autoScale() {
        if (this.terrain.points.length < 2) {
            this.terrain.scale = 2;
            this.terrain.offsetX = 50;
            this.terrain.offsetY = 50;
            return;
        }

        const pts = this.terrain.points;
        let minX = pts[0].x, maxX = pts[0].x;
        let minY = pts[0].y, maxY = pts[0].y;
        for (let i = 1; i < pts.length; i++) {
            const px = pts[i].x, py = pts[i].y;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }

        const width = maxX - minX || 1;
        const height = maxY - minY || 1;

        const margin = 60;
        const availW = this.canvas.width - margin * 2;
        const availH = this.canvas.height - margin * 2;

        this.terrain.scale = Math.min(availW / width, availH / height);
        this.terrain.offsetX = margin - minX * this.terrain.scale;
        this.terrain.offsetY = margin + (availH - height * this.terrain.scale) - minY * this.terrain.scale;
    }

    clear() {
        this.ctx.fillStyle = this._getCssVar('--canvas-bg', '#0a0a1a');
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    drawGrid() {
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;

        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 0.5;

        const gridSpacing = this.getGridSpacing();

        const startX = -offsetX / scale;
        const endX = (this.canvas.width - offsetX) / scale;
        const startYScaled = -(this.canvas.height - offsetY) / scale;
        const endYScaled = offsetY / scale;

        const xStart = Math.floor(startX / gridSpacing) * gridSpacing;
        const yStart = Math.floor(startYScaled / gridSpacing) * gridSpacing;

        ctx.font = '9px monospace';
        ctx.fillStyle = this.textColor;

        for (let x = xStart; x <= endX; x += gridSpacing) {
            const c = this.terrain.worldToCanvas(x, 0);
            ctx.beginPath();
            ctx.moveTo(c.cx, 0);
            ctx.lineTo(c.cx, this.canvas.height);
            ctx.stroke();
            ctx.fillText(x.toFixed(0), c.cx + 2, this.canvas.height - 5);
        }

        for (let y = yStart; y <= endYScaled; y += gridSpacing) {
            const c = this.terrain.worldToCanvas(0, y);
            ctx.beginPath();
            ctx.moveTo(0, c.cy);
            ctx.lineTo(this.canvas.width, c.cy);
            ctx.stroke();
            ctx.fillText(y.toFixed(0), 3, c.cy - 2);
        }
    }

    getGridSpacing() {
        const scale = this.terrain.scale;
        const pixelPerUnit = scale;

        if (pixelPerUnit > 40) return 1;
        if (pixelPerUnit > 10) return 5;
        if (pixelPerUnit > 4) return 10;
        if (pixelPerUnit > 1) return 25;
        return 50;
    }

    drawTerrain() {
        const ctx = this.ctx;
        const points = this.terrain.points;

        if (points.length < 2) return;

        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;

        // Single pass: fill + stroke per segment
        for (let i = 0; i < points.length - 1; i++) {
            const seg = this.terrain.segments[i];
            const color = seg ? seg.color : '#A0522D';
            const p1 = points[i], p2 = points[i + 1];
            const cx1 = p1.x * scale + offsetX, cy1 = canvasH - (p1.y * scale + offsetY);
            const cx2 = p2.x * scale + offsetX, cy2 = canvasH - (p2.y * scale + offsetY);

            // Fill
            ctx.beginPath();
            ctx.moveTo(cx1, cy1);
            ctx.lineTo(cx2, cy2);
            ctx.lineTo(cx2, canvasH);
            ctx.lineTo(cx1, canvasH);
            ctx.closePath();
            ctx.fillStyle = this._hexToRgba(color, 0.5);
            ctx.fill();

            // Stroke
            ctx.beginPath();
            ctx.moveTo(cx1, cy1);
            ctx.lineTo(cx2, cy2);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }

        // Draw point markers
        ctx.fillStyle = this.terrain.colors.points;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const cx = p.x * scale + offsetX, cy = canvasH - (p.y * scale + offsetY);
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    drawSegmentHighlight() {
        if (this.highlightSegmentIndex < 0) return;
        const idx = this.highlightSegmentIndex;
        const points = this.terrain.points;
        if (idx < 0 || idx >= points.length - 1) return;

        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;
        const ctx = this.ctx;

        const p1 = points[idx], p2 = points[idx + 1];
        const cx1 = p1.x * scale + offsetX, cy1 = canvasH - (p1.y * scale + offsetY);
        const cx2 = p2.x * scale + offsetX, cy2 = canvasH - (p2.y * scale + offsetY);

        ctx.save();
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 4;
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(cx1, cy1);
        ctx.lineTo(cx2, cy2);
        ctx.stroke();

        const midX = (cx1 + cx2) / 2;
        const midY = (cy1 + cy2) / 2;
        const seg = this.terrain.segments[idx];
        const label = seg ? `S${idx + 1}: ${seg.angle != null ? seg.angle.toFixed(1) + '°' : ''}` : `S${idx + 1}`;
        ctx.shadowBlur = 0;
        ctx.font = '12px monospace';
        ctx.fillStyle = '#00ff88';
        ctx.textAlign = 'center';
        ctx.fillText(label, midX, midY - 10);
        ctx.restore();
    }

    /**
     * Converts hex color to rgba string (cached).
     */
    _hexToRgba(hex, alpha) {
        const key = hex + '|' + alpha;
        if (this._hexCache[key]) return this._hexCache[key];
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const result = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        this._hexCache[key] = result;
        return result;
    }

    drawRocks(rockList, color = 'rgb(160, 140, 120)', alpha = 0.7) {
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const canvasH = this.canvas.height;
        const canvasW = this.canvas.width;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const margin = 20;

        for (const rock of rockList) {
            // Viewport culling: inline worldToCanvas for performance
            const cx = rock.x * scale + offsetX;
            const cy = canvasH - (rock.y * scale + offsetY);
            const r = Math.max(3, rock.radius * scale * 2);
            if (cx < -r - margin || cx > canvasW + r + margin ||
                cy < -r - margin || cy > canvasH + r + margin) {
                continue;
            }

            const vertices = rock.getShapeVertices();
            const fillStyle = alpha > 0.8 ? rock._colorActive : rock._colorResting;

            if (!vertices || vertices.length < 3) {
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = fillStyle;
                ctx.fill();
                continue;
            }

            ctx.beginPath();
            for (let i = 0; i < vertices.length; i++) {
                const px = vertices[i].x * scale + offsetX;
                const py = canvasH - (vertices[i].y * scale + offsetY);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();

            ctx.fillStyle = fillStyle;
            ctx.fill();
            ctx.strokeStyle = rock._colorStroke;
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
    }

    parseColor(color) {
        const match = color.match(/(\d+)/g);
        if (match) return { r: parseInt(match[0]), g: parseInt(match[1]), b: parseInt(match[2]) };
        return { r: 160, g: 140, b: 120 };
    }

    drawTrajectories(rockList, maxTrajPoints = 150) {
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;
        const maxDraw = Math.min(rockList.length, 40);
        const step = Math.max(1, Math.floor(rockList.length / maxDraw));

        // Create a fast map of rock list by ID
        const rockMap = {};
        for (const r of rockList) {
            rockMap[r.id] = r;
        }

        for (let ri = 0; ri < rockList.length; ri += step) {
            const rock = rockList[ri];
            const traj = rock.trajectory;
            const numPoints = traj.length / 3;  // Flat array: x,y,v triplets
            if (numPoints < 2) continue;

            const trajStep = Math.max(1, Math.floor(numPoints / maxTrajPoints)) * 3;

            ctx.beginPath();
            let started = false;

            // Draw from parent's final trajectory position if it exists
            if (rock.parentId !== null && rockMap[rock.parentId]) {
                const parent = rockMap[rock.parentId];
                const pt = parent.trajectory;
                if (pt && pt.length >= 3) {
                    const px = pt[pt.length - 3] * scale + offsetX;
                    const py = canvasH - (pt[pt.length - 2] * scale + offsetY);
                    ctx.moveTo(px, py);
                    started = true;
                }
            }

            for (let i = 0; i < traj.length; i += trajStep) {
                const px = traj[i] * scale + offsetX;
                const py = canvasH - (traj[i + 1] * scale + offsetY);
                if (!started) {
                    ctx.moveTo(px, py);
                    started = true;
                } else {
                    ctx.lineTo(px, py);
                }
            }

            ctx.strokeStyle = this.trajectoryColor;
            ctx.lineWidth = 0.5;
            ctx.stroke();

            // Render a distinct explosive/shatter marker at parent's rotura
            if (rock.parentId !== null && rockMap[rock.parentId]) {
                const parent = rockMap[rock.parentId];
                const pt = parent.trajectory;
                if (pt && pt.length >= 3) {
                    const px = pt[pt.length - 3] * scale + offsetX;
                    const py = canvasH - (pt[pt.length - 2] * scale + offsetY);

                    // Draw explosive marker (small circle + star burst)
                    ctx.fillStyle = '#ff6b6b';
                    ctx.beginPath();
                    ctx.arc(px, py, 4, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                        ctx.moveTo(px, py);
                        ctx.lineTo(px + Math.cos(angle) * 7, py + Math.sin(angle) * 7);
                    }
                    ctx.stroke();
                }
            }
        }
    }

    drawBouncePoints(rockList) {
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;
        const maxDraw = Math.min(rockList.length, 25);
        const step = Math.max(1, Math.floor(rockList.length / maxDraw));

        for (let ri = 0; ri < rockList.length; ri += step) {
            const rock = rockList[ri];
            const maxBounceDraw = 15;
            const bounceStep = Math.max(1, Math.floor(rock.bouncePoints.length / maxBounceDraw));

            for (let i = 0; i < rock.bouncePoints.length; i += bounceStep) {
                const bp = rock.bouncePoints[i];
                const intensity = Math.min(1, bp.energy / 100);
                const cx = bp.x * scale + offsetX;
                const cy = canvasH - (bp.y * scale + offsetY);

                const size = 2 + intensity * 3;
                ctx.beginPath();
                ctx.arc(cx, cy, size, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(233, 69, 96, ${0.3 + intensity * 0.5})`;
                ctx.fill();
            }
        }
    }

    drawReleasePoint(x, y) {
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;
        const cx = x * scale + offsetX;
        const cy = canvasH - (y * scale + offsetY);

        const ctx = this.ctx;
        const isDetachment = this.releaseMode === 'detachment';

        if (!isDetachment) {
            // Caída libre: línea vertical punteada desde release al suelo
            ctx.setLineDash([5, 5]);
            ctx.strokeStyle = this.trajectoryColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx, canvasH);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            // Desprendimiento: línea corta hacia abajo desde la superficie
            const terrainY = this.terrain.getHeightAt(x);
            const terrainCY = canvasH - (terrainY * scale + offsetY);
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = 'rgba(255, 165, 0, 0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, terrainCY - 15);
            ctx.lineTo(cx, terrainCY);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Circle marker
        const markerColor = isDetachment ? this.releaseDetachmentColor : this.releaseFreefallColor;
        const strokeColor = markerColor;
        const label = isDetachment ? 'Desprendimiento' : 'Release';

        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fillStyle = markerColor;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = strokeColor;
        ctx.font = '10px sans-serif';
        ctx.fillText(label, cx + 12, cy - 5);
        ctx.fillText(`(${x.toFixed(1)}, ${y.toFixed(1)})`, cx + 12, cy + 7);
    }

    drawMultiReleasePoint(point, index) {
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;
        const cx = point.x * scale + offsetX;
        const cy = canvasH - (point.y * scale + offsetY);
        const ctx = this.ctx;

        // Diamond marker for multi-release points
        const size = 7;
        ctx.beginPath();
        ctx.moveTo(cx, cy - size);
        ctx.lineTo(cx + size, cy);
        ctx.lineTo(cx, cy + size);
        ctx.lineTo(cx - size, cy);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 107, 107, 0.3)';
        ctx.fill();
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ff6b6b';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText(`P${index}`, cx + 12, cy - 3);
        ctx.font = '9px sans-serif';
        ctx.fillText(`(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`, cx + 12, cy + 8);
    }

    drawBarriers(barriers) {
        if (!barriers || barriers.length === 0) return;
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;

        for (let i = 0; i < barriers.length; i++) {
            const b = barriers[i];
            const cx1 = b.x1 * scale + offsetX;
            const cy1 = canvasH - (b.y1 * scale + offsetY);
            const cx2 = b.x2 * scale + offsetX;
            const cy2 = canvasH - (b.y2 * scale + offsetY);

            // Barrier line
            ctx.beginPath();
            ctx.moveTo(cx1, cy1);
            ctx.lineTo(cx2, cy2);
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 4;
            ctx.stroke();

            // Endpoints
            [{ x: cx1, y: cy1 }, { x: cx2, y: cy2 }].forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#c0392b';
                ctx.fill();
            });

            // Label
            const midX = (cx1 + cx2) / 2;
            const midY = (cy1 + cy2) / 2;
            ctx.fillStyle = '#e74c3c';
            ctx.font = 'bold 9px sans-serif';
            ctx.fillText(`B${i + 1}`, midX + 8, midY - 4);
        }
    }

    drawProbabilityMap(percentiles, releaseX) {
        if (!percentiles || !this.showProbabilityMap) return;

        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;

        // Percentile zones: draw colored vertical bands
        // Colors from green (low prob) to red (high prob)
        const zones = [
            { label: 'P95', value: percentiles.p95, color: 'rgba(231, 76, 60, 0.12)', line: '#e74c3c' },
            { label: 'P83', value: percentiles.p83, color: 'rgba(243, 156, 18, 0.10)', line: '#f39c12' },
            { label: 'P50', value: percentiles.p50, color: 'rgba(52, 152, 219, 0.08)', line: '#3498db' },
            { label: 'P10', value: percentiles.p10 || percentiles.mean, color: 'rgba(46, 204, 113, 0.06)', line: '#2ecc71' },
        ];

        for (const zone of zones) {
            if (zone.value === undefined || zone.value === null) continue;

            const cx = zone.value * scale + offsetX;
            const terrainCY = canvasH - (this.terrain.getHeightAt(zone.value) * scale + offsetY);

            // Draw zone from release to percentile runout
            const fromX = releaseX * scale + offsetX;
            ctx.fillStyle = zone.color;
            ctx.fillRect(fromX, 0, cx - fromX, terrainCY);

            // Vertical line
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(cx, terrainCY);
            ctx.lineTo(cx, 0);
            ctx.strokeStyle = zone.line;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.setLineDash([]);

            // Label
            ctx.fillStyle = zone.line;
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText(`${zone.label}: ${zone.value.toFixed(1)}m`, cx + 5, 20 + zones.indexOf(zone) * 16);
        }
    }

    drawRestingPositions(rockList) {
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const canvasH = this.canvas.height;
        const positions = rockList.filter(r => r.isResting).map(r => r.finalX);

        if (positions.length < 2) return;

        const bins = Math.min(30, Math.max(5, Math.floor(positions.length / 3)));
        const histogram = this.computeHistogram(positions, bins);

        // Safe max calculation (avoids stack overflow with large arrays)
        let maxCount = 0;
        for (const h of histogram) {
            if (h.count > maxCount) maxCount = h.count;
        }
        const binWidth = histogram[0].width;

        ctx.fillStyle = 'rgba(233, 69, 96, 0.15)';
        ctx.strokeStyle = 'rgba(233, 69, 96, 0.6)';
        ctx.lineWidth = 1;

        for (const bin of histogram) {
            const cx1 = bin.bin * scale + offsetX;
            const cx2 = (bin.bin + bin.width) * scale + offsetX;
            const cy = canvasH - (0 * scale + offsetY);
            const barHeight = (bin.count / maxCount) * 80;

            ctx.fillRect(cx1, cy - barHeight, cx2 - cx1, barHeight);
            ctx.strokeRect(cx1, cy - barHeight, cx2 - cx1, barHeight);
        }
    }

    computeHistogram(values, bins = 30) {
        if (values.length === 0) return [];

        // Safe min/max for large arrays (avoids stack overflow)
        let min = values[0], max = values[0];
        for (let i = 1; i < values.length; i++) {
            if (values[i] < min) min = values[i];
            if (values[i] > max) max = values[i];
        }
        const range = max - min || 1;
        const binWidth = range / bins;

        const histogram = [];
        for (let i = 0; i < bins; i++) {
            histogram.push({ bin: min + i * binWidth, width: binWidth, count: 0 });
        }

        for (const v of values) {
            const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
            if (idx >= 0) histogram[idx].count++;
        }

        return histogram;
    }

    drawAxes() {
        const ctx = this.ctx;
        ctx.strokeStyle = this.axisColor;
        ctx.lineWidth = 1;

        const origin = this.terrain.worldToCanvas(0, 0);

        ctx.beginPath();
        ctx.moveTo(origin.cx, 0);
        ctx.lineTo(origin.cx, this.canvas.height);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, origin.cy);
        ctx.lineTo(this.canvas.width, origin.cy);
        ctx.stroke();

        ctx.fillStyle = this.textColor;
        ctx.font = '10px sans-serif';
        ctx.fillText('X (m)', this.canvas.width - 30, origin.cy - 5);
        ctx.fillText('Y (m)', origin.cx + 5, 15);
    }

    render(simulation, releaseX, releaseY) {
        this.clear();

        if (this.activeTab === 'stl3d') {
            this.drawStlTopDown(this.currentStl, this.sliceLine);
            return;
        }

        this.drawGrid();
        this.drawAxes();
        this.drawTerrain();
        this.drawSegmentHighlight();

        if (releaseX !== undefined && releaseY !== undefined) {
            this.drawReleasePoint(releaseX, releaseY);
        }

        // Draw multi-release points
        if (this.multiReleasePoints && this.multiReleasePoints.length > 0) {
            for (let i = 0; i < this.multiReleasePoints.length; i++) {
                this.drawMultiReleasePoint(this.multiReleasePoints[i], i + 1);
            }
        }

        this.drawBarriers(this.barriers);

        // Draw probability map after simulation
        if (this.showProbabilityMap && this.probabilityPercentiles && releaseX !== undefined) {
            this.drawProbabilityMap(this.probabilityPercentiles, releaseX);
        }

        if (simulation) {
            if (this.showTrajectories) {
                this.drawTrajectories(simulation.rocks);
            }
            this.drawBouncePoints(simulation.rocks);
            this.drawRocks(simulation.activeRocks, 'rgb(180, 160, 140)', 0.9);
            // Limit finished rocks drawn to avoid canvas saturation with >1000 rocks
            const nonFragmentedFinished = simulation.finishedRocks.filter(r => !r.isFragmented);
            const maxFinished = 200;
            const finishedRocks = nonFragmentedFinished.length > maxFinished
                ? nonFragmentedFinished.filter((_, i) => i % Math.ceil(nonFragmentedFinished.length / maxFinished) === 0)
                : nonFragmentedFinished;
            this.drawRocks(finishedRocks, 'rgb(120, 110, 100)', 0.5);

            if (this.showRiskZones) {
                this.drawRestingPositions(simulation.rocks);
            }
        }
    }

    /**
     * Converts canvas coordinates back to horizontal STL world coordinates.
     */
    toStlWorld(cx, cy) {
        if (!this.currentStl || !this.stlScale) return { x: 0, y: 0 };
        return {
            x: (cx - this.stlOffsetX) / this.stlScale,
            y: (this.canvas.height - cy - this.stlOffsetY) / this.stlScale
        };
    }

    /**
     * Draws a plan view (planta) of the STL mesh with contour lines and slice line.
     * Uses a pre-computed heightmap for heatmap + marching-squares contour lines.
     */
    drawStlTopDown(stlData, sliceLine) {
        const ctx = this.ctx;

        if (!stlData || !stlData.triangles) {
            ctx.fillStyle = this.textColor;
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('📂 Carga un archivo STL para generar curvas de nivel.', this.canvas.width / 2, this.canvas.height / 2);
            ctx.textAlign = 'left';
            return;
        }

        const bounds = stlData.bounds;
        const upAxis = this.stlUpAxis || 'Z';

        // Map 3D bounds to horizontal/vertical based on upAxis
        let minHX, maxHX, minHY, maxHY, minV, maxV;
        if (upAxis === 'Y') {
            minHX = bounds.minX; maxHX = bounds.maxX;
            minHY = bounds.minZ; maxHY = bounds.maxZ;
            minV = bounds.minY;  maxV = bounds.maxY;
        } else {
            minHX = bounds.minX; maxHX = bounds.maxX;
            minHY = bounds.minY; maxHY = bounds.maxY;
            minV = bounds.minZ;  maxV = bounds.maxZ;
        }

        const hWidth = maxHX - minHX;
        const hHeight = maxHY - minHY;
        const vHeight = maxV - minV;

        // Compute scale to fit mesh in canvas with padding
        const pad = 60;
        const canvasW = this.canvas.width - pad * 2;
        const canvasH = this.canvas.height - pad * 2;
        const scaleX = canvasW / (hWidth || 1);
        const scaleY = canvasH / (hHeight || 1);
        const scale = Math.min(scaleX, scaleY);
        const offsetX = pad + (canvasW - hWidth * scale) / 2 - minHX * scale;
        const offsetY = pad + (canvasH - hHeight * scale) / 2 - minHY * scale;

        this.stlScale = scale;
        this.stlOffsetX = offsetX;
        this.stlOffsetY = offsetY;

        const getCx = (hx) => hx * scale + offsetX;
        const getCy = (hy) => this.canvas.height - (hy * scale + offsetY);

        // Draw heatmap from heightmap if available
        const hm = this.stlHeightmap;
        if (hm) {
            const { heights, cols, rows, cellW, cellH, minHX: hmMinX, minHY: hmMinY } = hm;

            // Find min/max for normalization
            let hMin = Infinity, hMax = -Infinity;
            for (let i = 0; i < heights.length; i++) {
                if (heights[i] > -1e20) {
                    if (heights[i] < hMin) hMin = heights[i];
                    if (heights[i] > hMax) hMax = heights[i];
                }
            }
            const vRange = (hMax - hMin) || 1;

            // Draw heatmap as filled rectangles (one per grid cell)
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const h = heights[r * cols + c];
                    if (h < -1e20) continue; // No data

                    const t = Math.max(0, Math.min(1, (h - hMin) / vRange));
                    // Color ramp: deep blue → cyan → green → yellow → brown
                    let cr, cg, cb;
                    if (t < 0.25) {
                        const s = t * 4;
                        cr = Math.round(20 + 10 * s);
                        cg = Math.round(50 + 130 * s);
                        cb = Math.round(80 + 80 * s);
                    } else if (t < 0.5) {
                        const s = (t - 0.25) * 4;
                        cr = Math.round(30 + 100 * s);
                        cg = Math.round(180 + 40 * s);
                        cb = Math.round(160 - 120 * s);
                    } else if (t < 0.75) {
                        const s = (t - 0.5) * 4;
                        cr = Math.round(130 + 100 * s);
                        cg = Math.round(220 - 40 * s);
                        cb = Math.round(40 - 20 * s);
                    } else {
                        const s = (t - 0.75) * 4;
                        cr = Math.round(230 - 50 * s);
                        cg = Math.round(180 - 100 * s);
                        cb = Math.round(20 + 40 * s);
                    }

                    const x1 = getCx(hmMinX + c * cellW);
                    const y1 = getCy(hmMinY + (r + 1) * cellH);
                    const x2 = getCx(hmMinX + (c + 1) * cellW);
                    const y2 = getCy(hmMinY + r * cellH);

                    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
                    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                }
            }
        } else {
            // Fallback: faint wireframe if no heightmap yet
            const numTriangles = stlData.triangles.length / 9;
            const maxDraw = 8000;
            const step = Math.max(1, Math.floor(numTriangles / maxDraw));
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.lineWidth = 0.3;
            ctx.beginPath();
            for (let i = 0; i < numTriangles; i += step) {
                const idx = i * 9;
                let p1hx, p1hy, p2hx, p2hy, p3hx, p3hy;
                if (upAxis === 'Y') {
                    p1hx = stlData.triangles[idx]; p1hy = stlData.triangles[idx + 2];
                    p2hx = stlData.triangles[idx + 3]; p2hy = stlData.triangles[idx + 5];
                    p3hx = stlData.triangles[idx + 6]; p3hy = stlData.triangles[idx + 8];
                } else {
                    p1hx = stlData.triangles[idx]; p1hy = stlData.triangles[idx + 1];
                    p2hx = stlData.triangles[idx + 3]; p2hy = stlData.triangles[idx + 4];
                    p3hx = stlData.triangles[idx + 6]; p3hy = stlData.triangles[idx + 7];
                }
                ctx.moveTo(getCx(p1hx), getCy(p1hy));
                ctx.lineTo(getCx(p2hx), getCy(p2hy));
                ctx.lineTo(getCx(p3hx), getCy(p3hy));
                ctx.closePath();
            }
            ctx.stroke();
        }

        // Draw contour lines
        if (this.stlContours && this.stlContours.length > 0) {
            const contours = this.stlContours;
            for (let ci = 0; ci < contours.length; ci++) {
                const { level, segments } = contours[ci];
                // Color: darker brown for major contours, lighter for minor
                const isMajor = Math.abs(level % (this.stlContourInterval * 5)) < 0.5;
                ctx.strokeStyle = isMajor ? 'rgba(60, 40, 20, 0.7)' : 'rgba(80, 60, 30, 0.4)';
                ctx.lineWidth = isMajor ? 1.5 : 0.6;
                ctx.beginPath();
                for (let si = 0; si < segments.length; si++) {
                    const [sx1, sy1, sx2, sy2] = segments[si];
                    ctx.moveTo(getCx(sx1), getCy(sy1));
                    ctx.lineTo(getCx(sx2), getCy(sy2));
                }
                ctx.stroke();

                // Label major contours
                if (isMajor && segments.length > 2) {
                    // Place label at the longest segment
                    let maxLen = 0, bestIdx = 0;
                    for (let si = 0; si < Math.min(segments.length, 200); si++) {
                        const [sx1, sy1, sx2, sy2] = segments[si];
                        const len = (sx2 - sx1) ** 2 + (sy2 - sy1) ** 2;
                        if (len > maxLen) { maxLen = len; bestIdx = si; }
                    }
                    const [sx1, sy1, sx2, sy2] = segments[bestIdx];
                    const mx = getCx((sx1 + sx2) / 2);
                    const my = getCy((sy1 + sy2) / 2);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                    ctx.font = '9px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText(level.toFixed(0), mx, my - 3);
                    ctx.textAlign = 'left';
                }
            }
        }

        // Draw bounding box outline
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const bMinX = getCx(minHX);
        const bMaxY = getCy(maxHY);
        const bMaxX = getCx(maxHX);
        const bMinY = getCy(minHY);
        ctx.strokeRect(bMinX, bMaxY, bMaxX - bMinX, bMinY - bMaxY);
        ctx.setLineDash([]);

        // Info label
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.font = '11px sans-serif';
        const triCount = (stlData.triangles.length / 9).toLocaleString();
        ctx.fillText(`Planta | X:${hWidth.toFixed(0)}m  Y:${hHeight.toFixed(0)}m  ${upAxis}:${vHeight.toFixed(0)}m | ${triCount} triángulos | Equidistancia: ${this.stlContourInterval}m`, 15, this.canvas.height - 12);

        // Axis indicator (bottom-left)
        const axOx = 50, axOy = this.canvas.height - 45, axLen = 30;
        ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(axOx, axOy); ctx.lineTo(axOx + axLen, axOy); ctx.stroke();
        ctx.fillStyle = '#ff4444'; ctx.font = 'bold 10px sans-serif';
        ctx.fillText('X', axOx + axLen + 3, axOy + 4);
        ctx.strokeStyle = '#44ff44';
        ctx.beginPath(); ctx.moveTo(axOx, axOy); ctx.lineTo(axOx, axOy - axLen); ctx.stroke();
        ctx.fillStyle = '#44ff44';
        ctx.fillText('Y', axOx - 3, axOy - axLen - 4);

        // Draw Slice Line
        if (sliceLine && sliceLine.active) {
            const pAx = getCx(sliceLine.x1);
            const pAy = getCy(sliceLine.y1);
            const pBx = getCx(sliceLine.x2);
            const pBy = getCy(sliceLine.y2);

            ctx.strokeStyle = '#4caf50';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(pAx, pAy);
            ctx.lineTo(pBx, pBy);
            ctx.stroke();

            // Endpoints
            ctx.fillStyle = '#4caf50';
            ctx.beginPath();
            ctx.arc(pAx, pAy, 6, 0, Math.PI * 2);
            ctx.arc(pBx, pBy, 6, 0, Math.PI * 2);
            ctx.fill();

            // Labels
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText('A', pAx - 14, pAy - 6);
            ctx.fillText('B', pBx + 10, pBy - 6);
        }
    }

    /**
     * Renders a specific recorded frame for timeline playback.
     * Reconstructs trajectories by connecting positions from frame 0 to frameIndex,
     * and draws rocks at their recorded positions using the rock objects for shape/color.
     *
     * @param {number} frameIndex - Frame to render
     * @param {Array} frames - Array of frame snapshots from Simulation
     * @param {Array} rocks - Rock objects (for shape, color, radius)
     * @param {number} releaseX - Release point X
     * @param {number} releaseY - Release point Y
     */
    renderTimelineFrame(frameIndex, frames, rocks, releaseX, releaseY) {
        this.clear();
        this.drawGrid();
        this.drawAxes();
        this.drawTerrain();
        this.drawSegmentHighlight();

        if (releaseX !== undefined && releaseY !== undefined) {
            this.drawReleasePoint(releaseX, releaseY);
        }

        const frame = frames[frameIndex];
        if (!frame) return;

        // Draw trajectories from frame 0 to current frame
        if (this.showTrajectories) {
            this.drawTimelineTrajectories(frameIndex, frames, rocks);
        }

        // Draw rocks at their frame positions
        const ctx = this.ctx;
        const scale = this.terrain.scale;
        const canvasH = this.canvas.height;
        const canvasW = this.canvas.width;
        const offsetX = this.terrain.offsetX;
        const offsetY = this.terrain.offsetY;
        const margin = 20;

        for (let i = 0; i < frame.length; i++) {
            const state = frame[i];
            const rock = rocks[i];
            if (!rock) continue;

            // Skip drawing if already fragmented in this frame
            if (state.isFragmented) continue;

            const cx = state.x * scale + offsetX;
            const cy = canvasH - (state.y * scale + offsetY);
            const r = Math.max(3, rock.radius * scale * 2);

            // Viewport culling
            if (cx < -r - margin || cx > canvasW + r + margin ||
                cy < -r - margin || cy > canvasH + r + margin) {
                continue;
            }

            // Get rotated shape vertices at frame position
            const cos = Math.cos(state.rotation);
            const sin = Math.sin(state.rotation);
            const vertices = rock.shape.map(p => ({
                x: state.x + p.x * cos - p.y * sin,
                y: state.y + p.x * sin + p.y * cos
            }));

            const rockColor = rock.color;
            const alpha = state.isResting ? 0.5 : 0.9;

            if (vertices.length >= 3) {
                ctx.beginPath();
                for (let vi = 0; vi < vertices.length; vi++) {
                    const px = vertices[vi].x * scale + offsetX;
                    const py = canvasH - (vertices[vi].y * scale + offsetY);
                    if (vi === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.closePath();

                ctx.fillStyle = `rgba(${rockColor.r}, ${rockColor.g}, ${rockColor.b}, ${alpha})`;
                ctx.fill();
                ctx.strokeStyle = `rgba(${Math.min(255, rockColor.r + 40)}, ${Math.min(255, rockColor.g + 40)}, ${Math.min(255, rockColor.b + 40)}, ${alpha * 0.6})`;
                ctx.lineWidth = 0.5;
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${rockColor.r}, ${rockColor.g}, ${rockColor.b}, ${alpha})`;
                ctx.fill();
            }
        }

        if (this.showRiskZones) {
            // Show resting positions only up to current frame
            const restingRocks = [];
            for (let i = 0; i < frame.length; i++) {
                if (frame[i].isResting) {
                    restingRocks.push({ finalX: frame[i].x, isResting: true });
                }
            }
            if (restingRocks.length >= 2) {
                this.drawRestingPositions(restingRocks);
            }
        }
    }

    /**
     * Draws trajectory lines by connecting rock positions from frame 0 to frameIndex.
     * Used during timeline playback — reconstructs trajectories from recorded data.
     */
    drawTimelineTrajectories(frameIndex, frames, rocks) {
        const ctx = this.ctx;
        const maxDraw = Math.min(rocks.length, 30);
        const rockStep = Math.max(1, Math.floor(rocks.length / maxDraw));
        const frameStep = Math.max(1, Math.floor(frameIndex / 200));

        for (let ri = 0; ri < rocks.length; ri += rockStep) {
            const rock = rocks[ri];
            ctx.beginPath();
            let started = false;

            let parentIndex = -1;
            if (rock.parentId !== null) {
                parentIndex = rocks.findIndex(r => r.id === rock.parentId);
            }

            for (let fi = 0; fi <= frameIndex; fi += frameStep) {
                const state = frames[fi][ri];
                if (!state) continue;

                const c = this.terrain.worldToCanvas(state.x, state.y);
                if (!started) {
                    if (parentIndex !== -1) {
                        // Find first frame where child was active
                        let spawnFrame = fi;
                        while (spawnFrame > 0 && frames[spawnFrame - 1][ri]) {
                            spawnFrame--;
                        }
                        const parentState = frames[Math.max(0, spawnFrame - 1)][parentIndex] || frames[spawnFrame][parentIndex];
                        if (parentState) {
                            const pc = this.terrain.worldToCanvas(parentState.x, parentState.y);
                            ctx.moveTo(pc.cx, pc.cy);
                        } else {
                            ctx.moveTo(c.cx, c.cy);
                        }
                    } else {
                        ctx.moveTo(c.cx, c.cy);
                    }
                    started = true;
                }
                ctx.lineTo(c.cx, c.cy);
            }

            // Last frame point (may not be on frameStep boundary)
            if (frameIndex % frameStep !== 0) {
                const state = frames[frameIndex][ri];
                if (state) {
                    const c = this.terrain.worldToCanvas(state.x, state.y);
                    if (!started) {
                        ctx.moveTo(c.cx, c.cy);
                        started = true;
                    } else {
                        ctx.lineTo(c.cx, c.cy);
                    }
                }
            }

            if (started) {
                ctx.strokeStyle = 'rgba(78, 180, 196, 0.3)';
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }

            // Draw explosive/shatter marker at fragmentation point during timeline playback
            if (rock.parentId !== null && parentIndex !== -1 && started) {
                let spawnFrame = 0;
                while (spawnFrame < frames.length && !frames[spawnFrame][ri]) {
                    spawnFrame++;
                }
                if (spawnFrame < frames.length && spawnFrame <= frameIndex) {
                    const parentState = frames[Math.max(0, spawnFrame - 1)][parentIndex] || frames[spawnFrame][parentIndex];
                    if (parentState) {
                        const pc = this.terrain.worldToCanvas(parentState.x, parentState.y);

                        ctx.fillStyle = '#ff6b6b';
                        ctx.beginPath();
                        ctx.arc(pc.cx, pc.cy, 4, 0, Math.PI * 2);
                        ctx.fill();

                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                            ctx.moveTo(pc.cx, pc.cy);
                            ctx.lineTo(pc.cx + Math.cos(angle) * 7, pc.cy + Math.sin(angle) * 7);
                        }
                        ctx.stroke();
                    }
                }
            }
        }
    }

    renderHistogram(canvas, rocks) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = this.histogramBg;
        ctx.fillRect(0, 0, w, h);

        const energies = rocks.map(r => r.maxKineticEnergy / 1000).filter(e => e > 0);

        if (energies.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '12px sans-serif';
            ctx.fillText('Sin datos', w / 2 - 20, h / 2);
            return;
        }

        const histogram = this.computeHistogram(energies, 20);
        let maxCount = 0;
        for (const h of histogram) {
            if (h.count > maxCount) maxCount = h.count;
        }
        const lastBin = histogram[histogram.length - 1];
        const maxEnergy = lastBin.bin + lastBin.width;

        const padding = { top: 20, right: 15, bottom: 30, left: 45 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (plotH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '9px monospace';
            ctx.fillText(Math.round(maxCount * (1 - i / 4)), 2, y + 3);
        }

        const barWidth = plotW / histogram.length;

        for (let i = 0; i < histogram.length; i++) {
            const bin = histogram[i];
            const barH = (bin.count / maxCount) * plotH;
            const x = padding.left + i * barWidth;
            const y = padding.top + plotH - barH;

            const intensity = bin.bin / (maxEnergy || 1);
            const r = Math.floor(78 + 177 * intensity);
            const g = Math.floor(205 - 140 * intensity);
            const b = Math.floor(196 - 140 * intensity);

            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fillRect(x, y, barWidth - 1, barH);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, plotW, plotH);

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px sans-serif';
        ctx.fillText('Energía (kJ)', w / 2 - 25, h - 3);

        ctx.save();
        ctx.translate(10, h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Frecuencia', 0, 0);
        ctx.restore();

        // Mini stats
        const sortedE = [...energies].sort((a, b) => a - b);
        const maxKE = sortedE[sortedE.length - 1];
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`N=${energies.length}`, w - padding.right - 2, padding.top + 10);
        ctx.fillText(`Max=${maxKE.toFixed(1)}kJ`, w - padding.right - 2, padding.top + 21);
        ctx.textAlign = 'left';
    }

    // =============================================
    // Results Dashboard Chart Methods
    // =============================================

    /**
     * Resizes all dashboard chart canvases to their container dimensions.
     */
    resizeDashboardCanvases() {
        const ids = [
            'chart-energy-hist', 'chart-energy-distance', 'chart-accumulation',
            'chart-bounce-distance', 'chart-velocity-distance', 'chart-runout-dist'
        ];
        for (const id of ids) {
            const canvas = document.getElementById(id);
            if (!canvas) continue;
            const parent = canvas.parentElement;
            const titleEl = parent.querySelector('h4');
            const titleH = titleEl ? titleEl.offsetHeight + 1 : 30;
            const w = parent.clientWidth;
            const h = parent.clientHeight - titleH;
            if (w > 0 && h > 0) {
                canvas.width = w;
                canvas.height = Math.max(h, 150);
            }
        }
    }

    /**
     * Renders all six dashboard charts.
     */
    renderResultsDashboard(rocks, terrain, releasePoint, stats) {
        this.resizeDashboardCanvases();

        const restingRocks = rocks.filter(r => r.isResting);

        this.renderEnergyHistogram(
            document.getElementById('chart-energy-hist'),
            restingRocks
        );
        this.renderEnergyVsDistance(
            document.getElementById('chart-energy-distance'),
            restingRocks, terrain, releasePoint
        );
        this.renderAccumulationZones(
            document.getElementById('chart-accumulation'),
            restingRocks, terrain, releasePoint
        );
        this.renderBounceHeightVsDistance(
            document.getElementById('chart-bounce-distance'),
            restingRocks, terrain, releasePoint
        );
        this.renderImpactVelocityVsDistance(
            document.getElementById('chart-velocity-distance'),
            restingRocks, terrain, releasePoint
        );
        this.renderRunoutDistribution(
            document.getElementById('chart-runout-dist'),
            restingRocks, terrain, releasePoint, stats
        );
    }

    /**
     * Draws terrain profile as a transparent filled silhouette at the bottom of a chart.
     */
    drawTerrainSilhouette(ctx, terrain, w, h, padding) {
        const points = terrain.points;
        if (!points || points.length < 2) return;

        let minX = points[0].x, maxX = points[0].x;
        let minY = points[0].y, maxY = points[0].y;
        for (let i = 1; i < points.length; i++) {
            if (points[i].x < minX) minX = points[i].x;
            if (points[i].x > maxX) maxX = points[i].x;
            if (points[i].y < minY) minY = points[i].y;
            if (points[i].y > maxY) maxY = points[i].y;
        }

        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;
        const rangeX = maxX - minX || 1;
        const rangeY = maxY - minY || 1;

        // Silhouette occupies the bottom 30% of plot area
        const silH = plotH * 0.30;

        const scaleX = plotW / rangeX;

        ctx.save();
        ctx.beginPath();

        // Start from bottom-left
        const startX = padding.left;
        const bottomY = padding.top + plotH;
        ctx.moveTo(startX, bottomY);

        for (let i = 0; i < points.length; i++) {
            const px = padding.left + (points[i].x - minX) / rangeX * plotW;
            const normalizedY = (points[i].y - minY) / rangeY;
            const py = bottomY - normalizedY * silH;
            ctx.lineTo(px, py);
        }

        // Close to bottom-right
        ctx.lineTo(padding.left + plotW, bottomY);
        ctx.closePath();

        ctx.fillStyle = 'rgba(139, 90, 43, 0.15)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(139, 90, 43, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Draws labeled axes with grid lines for a chart.
     */
    drawChartAxes(ctx, w, h, padding, xLabel, yLabel, xTicks, yTicks) {
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        // Grid lines and Y tick labels
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 0.5;
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';

        for (let i = 0; i < yTicks.length; i++) {
            const y = padding.top + plotH - (yTicks[i].norm) * plotH;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.fillText(yTicks[i].label, padding.left - 6, y + 3);
        }

        // X tick labels
        ctx.textAlign = 'center';
        for (let i = 0; i < xTicks.length; i++) {
            const x = padding.left + xTicks[i].norm * plotW;

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, padding.top + plotH);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.fillText(xTicks[i].label, x, padding.top + plotH + 14);
        }

        // Axis labels
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(xLabel, padding.left + plotW / 2, h - 2);

        ctx.save();
        ctx.translate(10, padding.top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();

        // Border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, plotW, plotH);
    }

    /**
     * Generates nice tick values for a numeric range.
     */
    _niceTicks(min, max, targetCount) {
        const range = max - min || 1;
        const roughStep = range / targetCount;
        const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
        const residual = roughStep / magnitude;
        let niceStep;
        if (residual <= 1.5) niceStep = magnitude;
        else if (residual <= 3) niceStep = 2 * magnitude;
        else if (residual <= 7) niceStep = 5 * magnitude;
        else niceStep = 10 * magnitude;

        const ticks = [];
        const start = Math.ceil(min / niceStep) * niceStep;
        for (let v = start; v <= max; v += niceStep) {
            ticks.push(v);
        }
        return ticks;
    }

    _percentile(arr, pct) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = (pct / 100) * (sorted.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
    }

    _drawStatsBox(ctx, x, y, lines) {
        ctx.font = '10px monospace';
        let maxW = 0;
        for (const line of lines) {
            const m = ctx.measureText(line);
            if (m.width > maxW) maxW = m.width;
        }
        const pad = 6;
        const lineH = 14;
        const boxW = maxW + pad * 2;
        const boxH = lines.length * lineH + pad * 2;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        ctx.roundRect(x, y, boxW, boxH, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
        ctx.textAlign = 'left';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], x + pad, y + pad + (i + 1) * lineH - 3);
        }
    }

    _drawTrendLine(ctx, points, padding, plotW, plotH, minX, rangeX, minY, rangeY, color) {
        if (points.length < 3) return;
        const sorted = [...points].sort((a, b) => a.x - b.x);
        const windowSize = Math.max(3, Math.floor(sorted.length / 8));
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < sorted.length; i++) {
            const lo = Math.max(0, i - windowSize);
            const hi = Math.min(sorted.length - 1, i + windowSize);
            let sumY = 0, count = 0;
            for (let j = lo; j <= hi; j++) { sumY += sorted[j].y; count++; }
            const avgY = sumY / count;
            const px = padding.left + ((sorted[i].x - minX) / rangeX) * plotW;
            const py = padding.top + plotH - ((avgY - minY) / rangeY) * plotH;
            if (!started) { ctx.moveTo(px, py); started = true; }
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    _drawVerticalLine(ctx, xVal, minVal, rangeVal, padding, plotW, plotH, color, label, labelY) {
        const px = padding.left + ((xVal - minVal) / rangeVal) * plotW;
        if (px < padding.left || px > padding.left + plotW) return;
        ctx.setLineDash([5, 3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, padding.top);
        ctx.lineTo(px, padding.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        if (label) {
            ctx.fillStyle = color;
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(label, px, labelY || padding.top - 4);
        }
    }

    /**
     * Chart 1: Energy Distribution Histogram (enhanced with terrain silhouette).
     */
    renderEnergyHistogram(canvas, rocks) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        // Background
        ctx.fillStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-surface').trim() || '#161616';
        ctx.fillRect(0, 0, w, h);

        const energies = rocks.map(r => r.maxKineticEnergy / 1000).filter(e => e > 0);

        if (energies.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin datos de energía', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        const padding = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        const bins = Math.min(25, Math.max(8, Math.floor(energies.length / 5)));
        const histogram = this.computeHistogram(energies, bins);
        let maxCount = 0;
        for (const b of histogram) {
            if (b.count > maxCount) maxCount = b.count;
        }
        const lastBin = histogram[histogram.length - 1];
        const maxEnergy = lastBin.bin + lastBin.width;

        // Y ticks
        const yRawTicks = this._niceTicks(0, maxCount, 5);
        const yTicks = yRawTicks.map(v => ({
            value: v,
            norm: maxCount > 0 ? v / maxCount : 0,
            label: v.toFixed(0)
        }));

        // X ticks
        const xRawTicks = this._niceTicks(0, maxEnergy, 6);
        const xTicks = xRawTicks.map(v => ({
            value: v,
            norm: maxEnergy > 0 ? v / maxEnergy : 0,
            label: v.toFixed(1)
        }));

        // Draw axes
        this.drawChartAxes(ctx, w, h, padding, 'Energía (kJ)', 'Frecuencia', xTicks, yTicks);

        // Draw histogram bars with blue-to-red gradient
        const barWidth = plotW / histogram.length;
        for (let i = 0; i < histogram.length; i++) {
            const bin = histogram[i];
            const barH = maxCount > 0 ? (bin.count / maxCount) * plotH : 0;
            const x = padding.left + i * barWidth;
            const y = padding.top + plotH - barH;

            const intensity = maxEnergy > 0 ? (bin.bin + bin.width / 2) / maxEnergy : 0;
            const r = Math.floor(60 + 195 * intensity);
            const g = Math.floor(130 - 70 * intensity);
            const b = Math.floor(220 - 180 * intensity);

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
            ctx.fillRect(x + 1, y, barWidth - 2, barH);
        }

        // Statistics
        const sortedE = [...energies].sort((a, b) => a - b);
        const mean = energies.reduce((s, v) => s + v, 0) / energies.length;
        const median = this._percentile(sortedE, 50);
        const p95 = this._percentile(sortedE, 95);
        const sd = Math.sqrt(energies.reduce((s, v) => s + (v - mean) ** 2, 0) / energies.length);
        this._drawVerticalLine(ctx, median, 0, maxEnergy, padding, plotW, plotH, '#f0c040', `Med: ${median.toFixed(1)}kJ`, padding.top - 4);
        this._drawStatsBox(ctx, w - padding.right - 165, padding.top + 4, [
            `N = ${energies.length}`,
            `Media = ${mean.toFixed(1)} kJ`,
            `P50  = ${median.toFixed(1)} kJ`,
            `P95  = ${p95.toFixed(1)} kJ`,
            `SD   = ${sd.toFixed(1)} kJ`
        ]);
    }

    /**
     * Chart 2: Energy vs Distance scatter plot.
     */
    renderEnergyVsDistance(canvas, rocks, terrain, releasePoint) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-surface').trim() || '#161616';
        ctx.fillRect(0, 0, w, h);

        const padding = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        this.drawTerrainSilhouette(ctx, terrain, w, h, padding);

        if (rocks.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin datos', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        let minX = rocks[0].finalX, maxX = rocks[0].finalX;
        let maxKE = 0;
        for (const r of rocks) {
            if (r.finalX < minX) minX = r.finalX;
            if (r.finalX > maxX) maxX = r.finalX;
            const ke = r.maxKineticEnergy / 1000;
            if (ke > maxKE) maxKE = ke;
        }
        const rangeX = maxX - minX || 1;
        const rangeKE = maxKE || 1;

        const yTicks = this._niceTicks(0, maxKE, 5).map(v => ({
            value: v, norm: v / rangeKE, label: v.toFixed(1)
        }));
        const xTicks = this._niceTicks(minX, maxX, 6).map(v => ({
            value: v, norm: (v - minX) / rangeX, label: v.toFixed(0)
        }));

        this.drawChartAxes(ctx, w, h, padding, 'Distancia (m)', 'Energía (kJ)', xTicks, yTicks);

        // Scatter dots
        for (const r of rocks) {
            const ke = r.maxKineticEnergy / 1000;
            const px = padding.left + ((r.finalX - minX) / rangeX) * plotW;
            const py = padding.top + plotH - (ke / rangeKE) * plotH;

            const intensity = ke / rangeKE;
            const cr = Math.floor(60 + 195 * intensity);
            const cg = Math.floor(130 - 70 * intensity);
            const cb = Math.floor(220 - 180 * intensity);

            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.7)`;
            ctx.fill();
        }

        // Trend line (moving average)
        const points = rocks.map(r => ({ x: r.finalX, y: r.maxKineticEnergy / 1000 }));
        this._drawTrendLine(ctx, points, padding, plotW, plotH, minX, rangeX, 0, maxKE, 'rgba(78, 205, 196, 0.6)');

        // Statistics box
        const meanKE = rocks.reduce((s, r) => s + r.maxKineticEnergy / 1000, 0) / rocks.length;
        const maxKEActual = rocks.reduce((m, r) => Math.max(m, r.maxKineticEnergy / 1000), 0);
        const n = rocks.length;
        const meanX = rocks.reduce((s, r) => s + r.finalX, 0) / n;
        const cov = rocks.reduce((s, r) => s + (r.finalX - meanX) * (r.maxKineticEnergy / 1000 - meanKE), 0) / n;
        const sdX = Math.sqrt(rocks.reduce((s, r) => s + (r.finalX - meanX) ** 2, 0) / n);
        const sdKE = Math.sqrt(rocks.reduce((s, r) => s + (r.maxKineticEnergy / 1000 - meanKE) ** 2, 0) / n);
        const r = (sdX > 0 && sdKE > 0) ? cov / (sdX * sdKE) : 0;
        this._drawStatsBox(ctx, w - padding.right - 155, padding.top + 4, [
            `N = ${n}`,
            `Max = ${maxKEActual.toFixed(1)} kJ`,
            `Media = ${meanKE.toFixed(1)} kJ`,
            `r = ${r.toFixed(3)}`
        ]);
    }

    /**
     * Chart 3: Rock Accumulation Zones histogram.
     */
    renderAccumulationZones(canvas, rocks, terrain, releasePoint) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-surface').trim() || '#161616';
        ctx.fillRect(0, 0, w, h);

        const padding = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        this.drawTerrainSilhouette(ctx, terrain, w, h, padding);

        if (rocks.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin datos', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        const positions = rocks.map(r => r.finalX);
        const bins = Math.min(25, Math.max(8, Math.floor(positions.length / 5)));
        const histogram = this.computeHistogram(positions, bins);

        let maxCount = 0;
        for (const b of histogram) {
            if (b.count > maxCount) maxCount = b.count;
        }

        let minBin = histogram[0].bin;
        let maxBin = histogram[histogram.length - 1].bin + histogram[0].width;
        const rangeX = maxBin - minBin || 1;

        const yTicks = this._niceTicks(0, maxCount, 5).map(v => ({
            value: v, norm: maxCount > 0 ? v / maxCount : 0, label: v.toFixed(0)
        }));
        const xTicks = this._niceTicks(minBin, maxBin, 6).map(v => ({
            value: v, norm: (v - minBin) / rangeX, label: v.toFixed(0)
        }));

        this.drawChartAxes(ctx, w, h, padding, 'Distancia (m)', 'Cantidad de rocas', xTicks, yTicks);

        // Draw bars colored by density
        const barWidth = plotW / histogram.length;
        for (let i = 0; i < histogram.length; i++) {
            const bin = histogram[i];
            const barH = maxCount > 0 ? (bin.count / maxCount) * plotH : 0;
            const x = padding.left + ((bin.bin - minBin) / rangeX) * plotW;
            const y = padding.top + plotH - barH;

            const intensity = maxCount > 0 ? bin.count / maxCount : 0;
            // Light gray → bright accent
            const cr = Math.floor(100 + 120 * intensity);
            const cg = Math.floor(100 + 80 * intensity);
            const cb = Math.floor(120 + 80 * intensity);

            ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.85)`;
            ctx.fillRect(x, y, barWidth - 1, barH);
        }

        // Statistics
        let maxBinCount = 0, modalBin = histogram[0];
        for (const b of histogram) {
            if (b.count > maxBinCount) { maxBinCount = b.count; modalBin = b; }
        }
        const sortedPos = [...positions].sort((a, b) => a - b);
        const median = this._percentile(sortedPos, 50);
        const n = rocks.length;
        const sortedAll = [...rocks].sort((a, b) => a.finalX - b.finalX);
        const p50 = this._percentile(sortedAll.map(r => r.finalX), 50);
        const mean = positions.reduce((s, v) => s + v, 0) / n;
        this._drawVerticalLine(ctx, modalBin.bin + modalBin.width / 2, minBin, rangeX, padding, plotW, plotH, '#e94560', `Moda: ${modalBin.bin.toFixed(0)}-${(modalBin.bin + modalBin.width).toFixed(0)}m`, padding.top - 4);
        this._drawStatsBox(ctx, w - padding.right - 155, padding.top + 4, [
            `N = ${n}`,
            `Moda = ${modalBin.bin.toFixed(0)}-${(modalBin.bin + modalBin.width).toFixed(0)}m`,
            `P50  = ${p50.toFixed(1)}m`,
            `Media = ${mean.toFixed(1)}m`
        ]);
    }

    /**
     * Chart 4: Bounce Height vs Distance scatter plot.
     */
    renderBounceHeightVsDistance(canvas, rocks, terrain, releasePoint) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-surface').trim() || '#161616';
        ctx.fillRect(0, 0, w, h);

        const padding = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        this.drawTerrainSilhouette(ctx, terrain, w, h, padding);

        if (rocks.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin datos', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        let minX = rocks[0].finalX, maxX = rocks[0].finalX;
        let maxBH = 0;
        for (const r of rocks) {
            if (r.finalX < minX) minX = r.finalX;
            if (r.finalX > maxX) maxX = r.finalX;
            if (r.maxBounceHeight > maxBH) maxBH = r.maxBounceHeight;
        }
        const rangeX = maxX - minX || 1;
        const rangeBH = maxBH || 1;

        const yTicks = this._niceTicks(0, maxBH, 5).map(v => ({
            value: v, norm: v / rangeBH, label: v.toFixed(1)
        }));
        const xTicks = this._niceTicks(minX, maxX, 6).map(v => ({
            value: v, norm: (v - minX) / rangeX, label: v.toFixed(0)
        }));

        this.drawChartAxes(ctx, w, h, padding, 'Distancia (m)', 'Altura Rebote (m)', xTicks, yTicks);

        // Teal/cyan dots
        for (const r of rocks) {
            const px = padding.left + ((r.finalX - minX) / rangeX) * plotW;
            const py = padding.top + plotH - (r.maxBounceHeight / rangeBH) * plotH;

            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(78, 205, 196, 0.65)';
            ctx.fill();
        }

        // Trend line
        const bhPoints = rocks.map(r => ({ x: r.finalX, y: r.maxBounceHeight }));
        this._drawTrendLine(ctx, bhPoints, padding, plotW, plotH, minX, rangeX, 0, maxBH, 'rgba(78, 205, 196, 0.6)');

        // Statistics
        const bhVals = rocks.map(r => r.maxBounceHeight);
        const meanBH = bhVals.reduce((s, v) => s + v, 0) / bhVals.length;
        const maxBHactual = bhVals.reduce((m, v) => Math.max(m, v), 0);
        this._drawStatsBox(ctx, w - padding.right - 155, padding.top + 4, [
            `N = ${rocks.length}`,
            `Max = ${maxBHactual.toFixed(2)} m`,
            `Media = ${meanBH.toFixed(2)} m`
        ]);
    }

    /**
     * Chart 5: Impact Velocity vs Distance scatter plot.
     */
    renderImpactVelocityVsDistance(canvas, rocks, terrain, releasePoint) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-surface').trim() || '#161616';
        ctx.fillRect(0, 0, w, h);

        const padding = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        this.drawTerrainSilhouette(ctx, terrain, w, h, padding);

        if (rocks.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin datos', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        let minX = rocks[0].finalX, maxX = rocks[0].finalX;
        let maxV = 0;
        for (const r of rocks) {
            if (r.finalX < minX) minX = r.finalX;
            if (r.finalX > maxX) maxX = r.finalX;
            if (r.maxImpactVelocity > maxV) maxV = r.maxImpactVelocity;
        }
        const rangeX = maxX - minX || 1;
        const rangeV = maxV || 1;

        const yTicks = this._niceTicks(0, maxV, 5).map(v => ({
            value: v, norm: v / rangeV, label: v.toFixed(1)
        }));
        const xTicks = this._niceTicks(minX, maxX, 6).map(v => ({
            value: v, norm: (v - minX) / rangeX, label: v.toFixed(0)
        }));

        this.drawChartAxes(ctx, w, h, padding, 'Distancia (m)', 'Velocidad (m/s)', xTicks, yTicks);

        // Orange dots
        for (const r of rocks) {
            const px = padding.left + ((r.finalX - minX) / rangeX) * plotW;
            const py = padding.top + plotH - (r.maxImpactVelocity / rangeV) * plotH;

            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(243, 156, 18, 0.7)';
            ctx.fill();
        }

        // Trend line
        const ivPoints = rocks.map(r => ({ x: r.finalX, y: r.maxImpactVelocity }));
        this._drawTrendLine(ctx, ivPoints, padding, plotW, plotH, minX, rangeX, 0, maxV, 'rgba(243, 156, 18, 0.6)');

        // Statistics
        const ivVals = rocks.map(r => r.maxImpactVelocity);
        const meanV = ivVals.reduce((s, v) => s + v, 0) / ivVals.length;
        const maxVactual = ivVals.reduce((m, v) => Math.max(m, v), 0);
        this._drawStatsBox(ctx, w - padding.right - 165, padding.top + 4, [
            `N = ${rocks.length}`,
            `Max = ${maxVactual.toFixed(1)} m/s`,
            `Media = ${meanV.toFixed(1)} m/s`
        ]);
    }

    /**
     * Chart 6: Cumulative Runout Distance Distribution (S-curve).
     */
    renderRunoutDistribution(canvas, rocks, terrain, releasePoint, stats) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-surface').trim() || '#161616';
        ctx.fillRect(0, 0, w, h);

        const padding = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = w - padding.left - padding.right;
        const plotH = h - padding.top - padding.bottom;

        if (rocks.length === 0 || !releasePoint) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin datos', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        // Runout = horizontal distance from release point
        const runouts = rocks.map(r => Math.abs(r.finalX - releasePoint.x)).sort((a, b) => a - b);
        const maxRunout = runouts[runouts.length - 1] || 1;
        const n = runouts.length;

        const yTicks = [0, 25, 50, 75, 100].map(v => ({
            value: v, norm: v / 100, label: v + '%'
        }));

        const xTicks = this._niceTicks(0, maxRunout, 6).map(v => ({
            value: v, norm: v / maxRunout, label: v.toFixed(0)
        }));

        this.drawChartAxes(ctx, w, h, padding, 'Distancia runout (m)', 'Porcentaje acumulado (%)', xTicks, yTicks);

        // Draw S-curve
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top + plotH);
        for (let i = 0; i < n; i++) {
            const px = padding.left + (runouts[i] / maxRunout) * plotW;
            const py = padding.top + plotH - ((i + 1) / n * 100 / 100) * plotH;
            ctx.lineTo(px, py);
        }
ctx.strokeStyle = this.trajectoryColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Fill under curve
        ctx.fillStyle = this.trajectoryColor;
        ctx.fill();

        // Draw percentile lines: compute percentiles from sorted runouts
        const pVal = (arr, pct) => {
            const idx = (pct / 100) * (arr.length - 1);
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            const f = idx - lo;
            return arr[lo] * (1 - f) + arr[hi] * f;
        };

        const percentiles = [
            { pct: 50, label: 'P50', color: '#3498db', value: pVal(runouts, 50) },
            { pct: 83, label: 'P83', color: '#f39c12', value: pVal(runouts, 83) },
            { pct: 95, label: 'P95', color: '#e74c3c', value: pVal(runouts, 95) }
        ];

        for (const p of percentiles) {
            const yNorm = p.pct / 100;
            const py = padding.top + plotH - yNorm * plotH;

            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(padding.left, py);
            ctx.lineTo(padding.left + plotW, py);
            ctx.stroke();
            ctx.setLineDash([]);

            // Dot at intersection
            const px = padding.left + (p.value / maxRunout) * plotW;
            ctx.beginPath();
            ctx.arc(Math.min(px, padding.left + plotW), py, 4, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.fill();

            // Label
            const labelText = `${p.label}: ${p.value.toFixed(1)}m`;
            ctx.fillStyle = p.color;
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(labelText, padding.left + plotW - 4, py - 5);
        }

        // Statistics box
        const runoutStats = rocks.map(r => Math.abs(r.finalX - releasePoint.x)).sort((a, b) => a - b);
        const mean = runoutStats.reduce((s, v) => s + v, 0) / runoutStats.length;
        const sd = Math.sqrt(runoutStats.reduce((s, v) => s + (v - mean) ** 2, 0) / runoutStats.length);
        this._drawStatsBox(ctx, w - padding.right - 145, h - padding.bottom - 4 - 54, [
            `N = ${runoutStats.length}`,
            `Media = ${mean.toFixed(1)} m`,
            `SD   = ${sd.toFixed(1)} m`
        ]);
    }
}

SimRocas.Renderer = Renderer;
