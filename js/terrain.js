/**
 * SimRocas 2D — Shared namespace.
 * All modules attach their classes to this object to avoid global scope pollution.
 */
window.SimRocas = window.SimRocas || {};

/**
 * Preset terrain types with default coefficients.
 * Based on CRSP / Pierre2 calibration tables.
 */
const TerrainPresets = {
    'roca-dura': { label: 'Roca Dura', cn: 0.80, ct: 0.20, color: '#8B7355', roughness: 2 },
    'roca-suave': { label: 'Roca Suave', cn: 0.60, ct: 0.30, color: '#A08060', roughness: 8 },
    'suelo': { label: 'Suelo', cn: 0.40, ct: 0.40, color: '#6B8E23', roughness: 5 },
    'vegetacion': { label: 'Vegetación', cn: 0.30, ct: 0.50, color: '#228B22', roughness: 12 },
    'relleno': { label: 'Relleno', cn: 0.20, ct: 0.60, color: '#556B2F', roughness: 15 },
    'concreto': { label: 'Concreto', cn: 0.85, ct: 0.15, color: '#808080', roughness: 0 },
    'asfalto': { label: 'Asfalto', cn: 0.50, ct: 0.35, color: '#404040', roughness: 1 }
};

class Terrain {
    constructor() {
        this.points = [];
        this.segments = []; // One per segment: { type, cn, ct, color }
        this.scale = 2;
        this.offsetX = 0;
        this.offsetY = 0;
        // Cache for segment lookups — rocks move gradually so the last
        // found segment is a good hint for the next query.
        this._lastSegIdx = 0;
    }

    setScale(scale) {
        this.scale = scale;
    }

    setOffset(x, y) {
        this.offsetX = x;
        this.offsetY = y;
    }

    /**
     * Adds a point and manages segment properties.
     * When a point is inserted between two existing points,
     * the new segments inherit properties from the original segment.
     */
    addPoint(x, y, segmentType = 'roca-suave') {
        const newPoint = { x, y };
        const preset = TerrainPresets[segmentType] || TerrainPresets['roca-suave'];
        const newSeg = { type: segmentType, cn: preset.cn, ct: preset.ct, color: preset.color, roughness: preset.roughness };

        const idx = this._findInsertIndex(x);
        // Reject duplicate X coordinates to prevent division by zero
        if (idx > 0 && Math.abs(this.points[idx - 1].x - x) < 1e-9) return;
        if (idx < this.points.length && Math.abs(this.points[idx].x - x) < 1e-9) return;
        this.points.splice(idx, 0, newPoint);

        // Manage segments array
        if (this.points.length === 1) {
            // First point — no segments yet
        } else if (this.points.length === 2) {
            // Second point — create first segment
            this.segments = [newSeg];
        } else {
            // Insert point between existing segments
            // segments[i] is between points[i] and points[i+1]
            // Inserting at point index `idx` splits segment at idx-1
            if (idx > 0 && idx < this.points.length - 1) {
                // Split existing segment at idx-1
                const oldSeg = this.segments[idx - 1];
                this.segments.splice(idx - 1, 1, newSeg, oldSeg);
            } else if (idx === 0) {
                // Inserting at beginning — new segment before first
                this.segments.unshift(newSeg);
            } else {
                // Inserting at end — new segment after last
                this.segments.push(newSeg);
            }
        }
    }

    /**
     * Removes a point and merges adjacent segments.
     */
    removePoint(index) {
        if (index < 0 || index >= this.points.length) return;

        this.points.splice(index, 1);
        const newLen = this.points.length;

        // Manage segments
        if (newLen < 2) {
            this.segments = [];
        } else if (index === 0) {
            // Removed first point — remove first segment
            this.segments.shift();
        } else if (index >= newLen) {
            // Removed last or second-to-last point — remove segment at index-1
            this.segments.splice(index - 1, 1);
        } else {
            // Removed a middle point — merge two segments into one
            // Keep the segment AFTER the removed point
            this.segments.splice(index - 1, 2, this.segments[index]);
        }
    }

    clear() {
        this.points = [];
        this.segments = [];
    }

    /**
     * Loads a complete array of {x, y} points as the terrain profile.
     * Replaces all existing points and segments.
     * @param {Array<{x: number, y: number}>} pointsArray
     * @param {string} segmentType - Terrain segment type to use (default: first preset)
     */
    setPoints(pointsArray, segmentType = 'roca-suave') {
        this.clear();
        if (!pointsArray || pointsArray.length === 0) return;
        for (const p of pointsArray) {
            this.addPoint(p.x, p.y, segmentType);
        }
    }

    /**
     * Returns the number of segments.
     */
    get segmentCount() {
        return this.segments.length;
    }

    /**
     * Updates properties of a specific segment.
     */
    setSegmentProperties(index, props) {
        if (index >= 0 && index < this.segments.length) {
            if (props.type !== undefined) {
                const preset = TerrainPresets[props.type];
                if (preset) {
                    this.segments[index].type = props.type;
                    this.segments[index].cn = preset.cn;
                    this.segments[index].ct = preset.ct;
                    this.segments[index].color = preset.color;
                    this.segments[index].roughness = preset.roughness !== undefined ? preset.roughness : 0;
                }
            }
            if (props.cn !== undefined) this.segments[index].cn = props.cn;
            if (props.ct !== undefined) this.segments[index].ct = props.ct;
            if (props.color !== undefined) this.segments[index].color = props.color;
            if (props.roughness !== undefined) this.segments[index].roughness = props.roughness;
        }
    }

    /**
     * Applies a preset type to a range of segments.
     */
    applyPresetToRange(type, fromIdx, toIdx) {
        const preset = TerrainPresets[type];
        if (!preset) return;
        fromIdx = Math.max(0, fromIdx);
        toIdx = Math.min(this.segments.length - 1, toIdx);
        for (let i = fromIdx; i <= toIdx; i++) {
            this.segments[i] = { 
                type: type, 
                cn: preset.cn, 
                ct: preset.ct, 
                color: preset.color, 
                roughness: preset.roughness !== undefined ? preset.roughness : 0 
            };
        }
    }

    /**
     * Returns segment properties at a given X coordinate.
     * Falls back to global defaults if X is outside terrain bounds.
     */
    getSegmentPropertiesAt(x, defaultCn, defaultCt) {
        if (this.points.length < 2) return { cn: defaultCn, ct: defaultCt, type: '', color: '', roughness: 0 };

        const idx = this._findSegmentIndexCached(x);
        if (idx < 0 || idx >= this.segments.length) {
            return { cn: defaultCn, ct: defaultCt, type: '', color: '', roughness: 0 };
        }

        const seg = this.segments[idx];
        return {
            cn: seg.cn,
            ct: seg.ct,
            type: seg.type,
            color: seg.color,
            roughness: seg.roughness !== undefined ? seg.roughness : 0
        };
    }

    worldToCanvas(wx, wy) {
        return {
            cx: wx * this.scale + this.offsetX,
            cy: this.canvas.height - (wy * this.scale + this.offsetY)
        };
    }

    canvasToWorld(cx, cy) {
        return {
            wx: (cx - this.offsetX) / this.scale,
            wy: (this.canvas.height - cy - this.offsetY) / this.scale
        };
    }

    /**
     * Cached segment lookup — checks last found segment first (O(1) hit),
     * then falls back to binary search (O(log n)).
     * Rocks move gradually so cache hit rate is very high.
     */
    _findSegmentIndexCached(x) {
        // Fast path: check cached segment and its neighbours
        const last = this._lastSegIdx;
        const n = this.points.length - 1;
        if (last >= 0 && last < n) {
            if (x >= this.points[last].x && x <= this.points[last + 1].x) {
                return last;
            }
            // Check adjacent segments
            if (last > 0 && x >= this.points[last - 1].x && x <= this.points[last].x) {
                this._lastSegIdx = last - 1;
                return last - 1;
            }
            if (last + 1 < n && x >= this.points[last + 1].x && x <= this.points[last + 2].x) {
                this._lastSegIdx = last + 1;
                return last + 1;
            }
        }
        // Fall back to binary search
        const idx = this._findSegmentIndex(x);
        if (idx >= 0) this._lastSegIdx = idx;
        return idx;
    }

    /**
     * Finds the insertion index for a new point with given X.
     */
    _findInsertIndex(x) {
        let lo = 0;
        let hi = this.points.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.points[mid].x < x) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    /**
     * Binary search for the segment index whose X range contains the given value.
     * Returns the index i such that points[i].x <= x <= points[i+1].x,
     * or -1 if x is outside the terrain bounds.
     */
    _findSegmentIndex(x) {
        let lo = 0;
        let hi = this.points.length - 2;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.points[mid].x > x) {
                hi = mid - 1;
            } else if (this.points[mid + 1].x < x) {
                lo = mid + 1;
            } else {
                return mid;
            }
        }
        return -1;
    }

    getHeightAt(x) {
        if (this.points.length < 2) return 0;

        if (x <= this.points[0].x) {
            return this.points[0].y;
        }
        if (x >= this.points[this.points.length - 1].x) {
            return this.points[this.points.length - 1].y;
        }

        const idx = this._findSegmentIndexCached(x);
        if (idx < 0) return 0;

        const p1 = this.points[idx];
        const p2 = this.points[idx + 1];
        if (p2.x === p1.x) return p1.y;
        const t = (x - p1.x) / (p2.x - p1.x);
        return p1.y + t * (p2.y - p1.y);
    }

    getSegmentAt(x) {
        if (this.points.length < 2) return null;

        if (x < this.points[0].x || x > this.points[this.points.length - 1].x) {
            return null;
        }

        const idx = this._findSegmentIndexCached(x);
        if (idx < 0) return null;

        return {
            index: idx,
            p1: this.points[idx],
            p2: this.points[idx + 1],
            properties: this.segments[idx]
        };
    }

    getSurfaceNormalAt(x) {
        const seg = this.getSegmentAt(x);
        if (!seg) return { nx: 0, ny: 1 };

        const dx = seg.p2.x - seg.p1.x;
        const dy = seg.p2.y - seg.p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);

        if (len === 0) return { nx: 0, ny: 1 };

        const nx = -dy / len;
        const ny = dx / len;

        if (ny < 0) return { nx: -nx, ny: -ny };
        return { nx, ny };
    }

    getTerrainYAt(x) {
        return this.getHeightAt(x);
    }

    toJSON() {
        return JSON.stringify({ points: this.points, segments: this.segments, scale: this.scale });
    }

    toCSV() {
        let csv = 'X,Y,Type,Cn,Ct,Roughness\n';
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            const seg = this.segments[i] || { type: '', cn: 0, ct: 0, roughness: 0 };
            csv += `${p.x},${p.y},${seg.type},${seg.cn},${seg.ct},${seg.roughness || 0}\n`;
        }
        return csv;
    }

    fromJSON(json) {
        const data = JSON.parse(json);
        this.points = data.points || [];
        this.segments = data.segments || [];
        // Ensure each segment has a roughness parameter, defaulting to its preset's roughness if missing
        for (let i = 0; i < this.segments.length; i++) {
            const seg = this.segments[i];
            if (seg && seg.roughness === undefined) {
                const preset = TerrainPresets[seg.type] || TerrainPresets['roca-suave'];
                seg.roughness = preset.roughness || 0;
            }
        }
        // If no segments data, create defaults
        if (!data.segments && this.points.length >= 2) {
            this.segments = [];
            for (let i = 0; i < this.points.length - 1; i++) {
                const preset = TerrainPresets['roca-suave'];
                this.segments.push({ type: 'roca-suave', cn: preset.cn, ct: preset.ct, color: preset.color, roughness: preset.roughness || 0 });
            }
        }
        this.scale = data.scale || this.scale;
    }

    fromCSV(text) {
        this.points = [];
        this.segments = [];
        const lines = text.trim().split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            // Skip header row if present
            if (i === 0 && /^\s*[xXyY]/.test(line)) continue;
            // Support comma, semicolon, tab, or space as delimiter
            const parts = line.split(/[,\t;]+|\s+/);
            if (parts.length >= 2) {
                const x = parseFloat(parts[0]);
                const y = parseFloat(parts[1]);
                if (!isNaN(x) && !isNaN(y)) {
                    this.points.push({ x, y });
                }
                // Optional: type, cn, ct, roughness
                if (parts.length >= 5) {
                    const type = parts[2] || 'roca-suave';
                    const cn = parseFloat(parts[3]) || 0.6;
                    const ct = parseFloat(parts[4]) || 0.4;
                    const roughness = parts[5] !== undefined ? (parseFloat(parts[5]) || 0) : null;
                    const preset = TerrainPresets[type] || TerrainPresets['roca-suave'];
                    this.segments.push({
                        type: type,
                        cn: cn,
                        ct: ct,
                        color: preset.color,
                        roughness: roughness !== null ? roughness : (preset.roughness || 0)
                    });
                }
            }
        }
        // Sort by X
        this.points.sort((a, b) => a.x - b.x);
        // If no segment data, create defaults
        if (this.segments.length === 0 && this.points.length >= 2) {
            for (let i = 0; i < this.points.length - 1; i++) {
                const preset = TerrainPresets['roca-suave'];
                this.segments.push({ type: 'roca-suave', cn: preset.cn, ct: preset.ct, color: preset.color, roughness: preset.roughness || 0 });
            }
        }
    }

    findNearestPoint(cx, cy, threshold = 15) {
        let minDist = threshold;
        let minIndex = -1;

        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            const c = this.worldToCanvas(p.x, p.y);
            const dist = Math.sqrt((c.cx - cx) ** 2 + (c.cy - cy) ** 2);
            if (dist < minDist) {
                minDist = dist;
                minIndex = i;
            }
        }
        return minIndex;
    }
}

SimRocas.Terrain = Terrain;
SimRocas.TerrainPresets = TerrainPresets;
