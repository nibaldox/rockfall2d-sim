class Stats {
    constructor() {
        this.results = {};
    }

    compute(rocks, releasePoint = null) {
        if (!rocks || rocks.length === 0) {
            this.results = null;
            return null;
        }

        const finished = rocks.filter(r => r.isResting);

        const kineticEnergies = finished.map(r => r.maxKineticEnergy / 1000);
        const bounceHeights = finished.map(r => r.maxBounceHeight);
        const runoutDistances = finished.map(r => r.finalX);
        const impactVelocities = finished.map(r => r.maxImpactVelocity);
        const bounceCounts = finished.map(r => r.bounces);
        const impactEnergies = finished.flatMap(r => r.impactEnergies || []);

        // Savigny angle: arctan(H/L) where H is release height, L is max runout distance
        // Based on: Savigny (1983) "Rockfall prediction by the angle of reach"
        let savignyAngle = null;
        if (releasePoint && runoutDistances.length > 0) {
            let maxRunout = runoutDistances[0];
            for (let i = 1; i < runoutDistances.length; i++) {
                if (runoutDistances[i] > maxRunout) maxRunout = runoutDistances[i];
            }
            const horizontalDist = maxRunout - releasePoint.x;
            const heightDiff = releasePoint.y;
            if (horizontalDist > 0) {
                savignyAngle = Math.atan(heightDiff / horizontalDist) * 180 / Math.PI;
            }
        }

        this.results = {
            totalRocks: rocks.length,
            finishedRocks: finished.length,
            kineticEnergy: this.statsForArray(kineticEnergies),
            bounceHeight: this.statsForArray(bounceHeights),
            runoutDistance: this.statsForArray(runoutDistances),
            impactVelocity: this.statsForArray(impactVelocities),
            bounceCount: this.statsForArray(bounceCounts),
            impactEnergies: impactEnergies,
            percentile50: this.computePercentileRunout(runoutDistances, 50),
            percentile83: this.computePercentileRunout(runoutDistances, 83),
            percentile95: this.computePercentileRunout(runoutDistances, 95),
            savignyAngle: savignyAngle,
        };

        return this.results;
    }

    statsForArray(arr) {
        if (arr.length === 0) return { min: 0, max: 0, mean: 0, std: 0, p50: 0, p83: 0, p95: 0 };

        const sorted = [...arr].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const mean = sum / sorted.length;
        const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;

        return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            mean: mean,
            std: Math.sqrt(variance),
            p50: this.percentile(sorted, 50),
            p83: this.percentile(sorted, 83),
            p95: this.percentile(sorted, 95)
        };
    }

    percentile(sorted, p) {
        if (sorted.length === 0) return 0;
        const idx = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(idx);
        const upper = Math.ceil(idx);
        const frac = idx - lower;
        return sorted[lower] * (1 - frac) + sorted[upper] * frac;
    }

    computePercentileRunout(distances, p) {
        return this.percentile([...distances].sort((a, b) => a - b), p);
    }

    updateUI() {
        if (!this.results) return;

        const ke = this.results.kineticEnergy;
        const bh = this.results.bounceHeight;
        const rd = this.results.runoutDistance;
        const iv = this.results.impactVelocity;
        const bc = this.results.bounceCount;

        document.getElementById('stat-max-ke').textContent = ke.max.toFixed(1);
        document.getElementById('stat-mean-ke').textContent = ke.mean.toFixed(1);
        document.getElementById('stat-max-bounce').textContent = bh.max.toFixed(1);
        document.getElementById('stat-max-runout').textContent = rd.max.toFixed(1);
        document.getElementById('stat-max-velocity').textContent = iv.max.toFixed(1);
        document.getElementById('stat-max-bounces').textContent = bc.max;

        if (this.results.savignyAngle !== null) {
            document.getElementById('stat-savigny-angle').textContent = this.results.savignyAngle.toFixed(1);
        } else {
            document.getElementById('stat-savigny-angle').textContent = '-';
        }
    }

    generateCSV() {
        if (!this.results) return '';

        let csv = 'Parameter,Min,Mean,Max,Std,P50,P83,P95\n';
        csv += `Kinetic Energy (kJ),${this.results.kineticEnergy.min.toFixed(2)},${this.results.kineticEnergy.mean.toFixed(2)},${this.results.kineticEnergy.max.toFixed(2)},${this.results.kineticEnergy.std.toFixed(2)},${this.results.kineticEnergy.p50.toFixed(2)},${this.results.kineticEnergy.p83.toFixed(2)},${this.results.kineticEnergy.p95.toFixed(2)}\n`;
        csv += `Bounce Height (m),${this.results.bounceHeight.min.toFixed(2)},${this.results.bounceHeight.mean.toFixed(2)},${this.results.bounceHeight.max.toFixed(2)},${this.results.bounceHeight.std.toFixed(2)},${this.results.bounceHeight.p50.toFixed(2)},${this.results.bounceHeight.p83.toFixed(2)},${this.results.bounceHeight.p95.toFixed(2)}\n`;
        csv += `Runout Distance (m),${this.results.runoutDistance.min.toFixed(2)},${this.results.runoutDistance.mean.toFixed(2)},${this.results.runoutDistance.max.toFixed(2)},${this.results.runoutDistance.std.toFixed(2)},${this.results.runoutDistance.p50.toFixed(2)},${this.results.runoutDistance.p83.toFixed(2)},${this.results.runoutDistance.p95.toFixed(2)}\n`;
        csv += `Impact Velocity (m/s),${this.results.impactVelocity.min.toFixed(2)},${this.results.impactVelocity.mean.toFixed(2)},${this.results.impactVelocity.max.toFixed(2)},${this.results.impactVelocity.std.toFixed(2)},${this.results.impactVelocity.p50.toFixed(2)},${this.results.impactVelocity.p83.toFixed(2)},${this.results.impactVelocity.p95.toFixed(2)}\n`;
        csv += `Bounce Count,${this.results.bounceCount.min},${this.results.bounceCount.mean.toFixed(1)},${this.results.bounceCount.max},${this.results.bounceCount.std.toFixed(1)},${this.results.bounceCount.p50},${this.results.bounceCount.p83},${this.results.bounceCount.p95}\n`;

        return csv;
    }

    generateReport() {
        if (!this.results) return '';

        const r = this.results;
        let report = '╔══════════════════════════════════════════════════╗\n';
        report += '║       SIMROCAS 2D — REPORTE DE SIMULACIÓN       ║\n';
        report += '╚══════════════════════════════════════════════════╝\n\n';
        report += `Date: ${new Date().toLocaleString()}\n`;
        report += `Total Rocks Simulated: ${r.totalRocks}\n`;
        report += `Finished Rocks: ${r.finishedRocks}\n\n`;

        report += '── KINETIC ENERGY (kJ) ──\n';
        report += `  Min:  ${r.kineticEnergy.min.toFixed(2)}\n`;
        report += `  Mean: ${r.kineticEnergy.mean.toFixed(2)}\n`;
        report += `  Max:  ${r.kineticEnergy.max.toFixed(2)}\n`;
        report += `  P50:  ${r.kineticEnergy.p50.toFixed(2)}\n`;
        report += `  P83:  ${r.kineticEnergy.p83.toFixed(2)}\n`;
        report += `  P95:  ${r.kineticEnergy.p95.toFixed(2)}\n\n`;

        report += '── MAX BOUNCE HEIGHT (m) ──\n';
        report += `  Min:  ${r.bounceHeight.min.toFixed(2)}\n`;
        report += `  Mean: ${r.bounceHeight.mean.toFixed(2)}\n`;
        report += `  Max:  ${r.bounceHeight.max.toFixed(2)}\n`;
        report += `  P83:  ${r.bounceHeight.p83.toFixed(2)}\n`;
        report += `  P95:  ${r.bounceHeight.p95.toFixed(2)}\n\n`;

        report += '── RUNOUT DISTANCE (m) ──\n';
        report += `  Min:  ${r.runoutDistance.min.toFixed(2)}\n`;
        report += `  Mean: ${r.runoutDistance.mean.toFixed(2)}\n`;
        report += `  Max:  ${r.runoutDistance.max.toFixed(2)}\n`;
        report += `  P50:  ${r.runoutDistance.p50.toFixed(2)}\n`;
        report += `  P83:  ${r.runoutDistance.p83.toFixed(2)}\n`;
        report += `  P95:  ${r.runoutDistance.p95.toFixed(2)}\n\n`;

        report += '── IMPACT VELOCITY (m/s) ──\n';
        report += `  Min:  ${r.impactVelocity.min.toFixed(2)}\n`;
        report += `  Mean: ${r.impactVelocity.mean.toFixed(2)}\n`;
        report += `  Max:  ${r.impactVelocity.max.toFixed(2)}\n`;
        report += `  P83:  ${r.impactVelocity.p83.toFixed(2)}\n`;
        report += `  P95:  ${r.impactVelocity.p95.toFixed(2)}\n\n`;

        report += '── MAX BOUNCE COUNT ──\n';
        report += `  Min:  ${r.bounceCount.min}\n`;
        report += `  Mean: ${r.bounceCount.mean.toFixed(1)}\n`;
        report += `  Max:  ${r.bounceCount.max}\n\n`;

        report += '══════════════════════════════════════════════════\n';
        report += 'Generated by SimRocas 2D Simulator (Free & Open Source)\n';

        return report;
    }
}

SimRocas.Stats = Stats;
