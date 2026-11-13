> Archivo histórico del plan local del 17/oct/2026, preservado para continuar en otro PC.
> Sus autorizaciones, estados y mediciones son históricos; el estado verificado al transferir está en [HANDOFF.md](HANDOFF.md).
> La autorización posterior del usuario del 24/oct/2026 permite los commits y la subida del checkpoint.

# SimRocas 3D + Escritorio — Plan de implementación

> **Para Hermes (orquestador):** ejecutar por oleadas con `delegate_task`, una tarea corta por subagente, propiedad de archivos disjunta, TDD (RED → GREEN) y verificación central del coordinador al cierre de cada oleada. Usar skills `rockfall2d-sim` y `parallel-coding-workflows`.

**Objetivo:** convertir SimRocas en una aplicación con módulo principal 3D (topografía de dron importada desde formatos libres) y el módulo 2D actual como vista de detalle de perfiles, distribuida como instalador para Windows, Linux y macOS, sin perder la versión web estática.

**Arquitectura:** el cálculo se queda en el cliente (JS + Web Workers; WASM solo si el perfilado lo exige). Todo terreno importado se convierte a un DEM regular (grilla de alturas Float32 con origen local en Float64) que es la única representación usada por la física 3D; la malla se usa solo para dibujar. El 2D recibe perfiles extraídos del DEM. La versión de escritorio es un envoltorio Electron sobre los mismos archivos web.

**Stack:** JavaScript vanilla (scripts clásicos + namespace `SimRocas`), Canvas 2D, Three.js vendorizado (módulo ES con puente a `window.THREE`), Web Workers, `node:test` para pruebas headless (sin dependencias), Electron + electron-builder solo dentro de `desktop/`.

---

## 0. Decisiones registradas y pendientes

| Id | Decisión | Estado |
|----|----------|--------|
| D1 | Three.js vendorizado (rompe "cero dependencias" solo para el visor 3D) | **Aceptado** |
| D2 | Versiones de escritorio Windows / Linux / macOS | **Aceptado** — tecnología recomendada: Electron (ver §1); confirmar en G1 |
| D3 | Orden de formatos: STL, OBJ, ASC/XYZ → luego DXF/GeoTIFF | **Aceptado** — ver G3 (propuesta de adelantar GeoTIFF por datos de dron) |
| D4 | Escala máxima (rocas, tamaño DEM) | **Diferido** — se fija con el benchmark T4.8 (G5) |
| D5 | Topografías de dron > 100 MB | **Requisito** — importación en Worker con streaming, remuestreo a DEM, malla de visualización decimada |

### Puertas de decisión (bloquean solo las tareas indicadas)

- **G1 — Electron vs Tauri.** Bloquea F1. Recomendación: Electron.
- **G2 — Librerías vendorizadas adicionales:** `geotiff.js` (MIT, GeoTIFF comprimido), `delaunator` (ISC, triangulación para DXF/curvas), `laz-perf` (WASM, LAZ; verificar licencia). Bloquea T6.x correspondientes.
- **G3 — Adelantar GeoTIFF a F2.** Los vuelos de dron (Pix4D, Metashape, WebODM, DroneDeploy) exportan nativamente DTM/DSM en GeoTIFF; es probablemente el formato de mayor valor para el usuario. Bloquea T2.9.
- **G4 — Certificados de firma** (Apple Developer ID, certificado Windows). Bloquea T1.5.
- **G5 — Límites de escala** tras T4.8.
- **G6 — Destino de `js/structural-failure.js`** (no cargado en `index.html`): integrar, mover a `js/experimental/` o eliminar. Bloquea solo su limpieza.

---

## 0.1 Estado de ejecución (cola autorizada)

- Autorización del usuario (17/Oct/2026): ejecutar TODAS las fases en orden, avanzando solo tras verificación del coordinador. Sin commits ni push.
- Puertas resueltas por defecto recomendado: G1 = Electron, G2 = vendorizar geotiff.js / delaunator / laz-perf (verificar licencias), G3 = GeoTIFF en F2. Bloqueadas: G4 (certificados de firma — T1.5 no se ejecuta), G5 (se informa tras T4.8), G6 (`structural-failure.js` no se toca). Nueva: G7 = criterio de reposo en pendiente (`slopeFactor`), se informa tras T0.7.
- Hecho y verificado: T0.1–T0.10, T0.7b, T0.11 (README/TODO; AGENTS.md BLOQUEADO por protección de archivos de instrucciones — requiere aprobación explícita del usuario), T1.1+T1.2 (smoke Electron exit 0: crossOriginIsolated, worker, simulación, traversal 403), T2.1 (Dem), T2.6 (OBJ 51–74 MB/s), T2.8 (XYZ 46 MB/s). Suite 98/98.
- En curso: revisores F0 (spec + calidad/física), T1.3+T1.4 (electron-builder + CI), T2.3+T2.4 (DemBuilder), T2.5+T2.11+T2.7 (STL/PLY/ASC), T2.9 (GeoTIFF vendorizado). Siguiente: T2.10 (worker de importación) → F3.
- Hecho y verificado (lote 4): revisores F0 (spec PASS; física: 1 bloqueante tunneling confirmado), T1.3+T1.4 (AppImage 120 MB + deb 95 MB, smoke AppImage exit 0, CI desktop.yml), T2.3+T2.4 DemBuilder (2M triángulos 1,3 s), T2.5 STL (23 MB/s), T2.11 PLY (92 MB/s), T2.7 ASC, T2.9 GeoTIFF (geotiff.js 3.0.5 MIT vendorizado, SHA-256 verificado). Suite 163/163.
- En curso (lote 5): T0.12 (tunneling, NaN, diámetro de fragmentos, CSV, paridad nonsmooth), T2.10 (worker de importación), T3.1–T3.3 (Three.js r186 + Viewer3D + malla de terreno en dev/viewer3d.html). Coordinador al integrar: subir ?v de physics.js/terrain.js en index.html y WORKER_VERSION.
- Hecho y verificado (lote 5): T0.12 (tunneling corregido: pared 0,3 m con dt 0,02 a 60 m/s ahora choca; métricas de referencia idénticas), T2.10 (worker de importación, OBJ 45 MB en 1,85 s), T3.1–T3.3 (Three.js r186 vendorizado, Viewer3D, captura verificada). Coordinador: ?v terrain 8, physics 8, app-worker 2, WORKER_VERSION 3; smoke web OK. Suite 205/205. T4.0: contrato C7 escrito en docs/contracts-3d.md.
- En curso (lote 6): T3.4+T3.6 (modo 3D/2D, importmap, CSP, panel de importación), T4.1+T4.2 (math3d + física 3D masa concentrada), T4.5+T4.9 (zonas fuente + rásteres de resultados), T6.1+T6.2 (DXF + delaunator), T6.3 (LAS). Coordinador al integrar: registrar dxf y las en js/workers/import-worker.js y en el accept del input.
- Hecho y verificado (lote 6): T3.4+T3.6 (modo 3D/2D, CSP con hash del importmap, panel de importación; smoke 3D sin errores ni violaciones CSP; perfil 2D intacto), T4.1+T4.2 (física 3D LM: rebote −1,8 %, paridad 2D↔3D 2,0 %, 318k pasos/s), T4.5+T4.9 (zonas fuente, rásteres), T6.1+T6.2 (DXF + delaunator 5.1.0 ISC), T6.3 (LAS). Coordinador: registró dxf/las en el worker de importación, corrigió detect DXF demasiado laxo, test tests/import-worker.formats.test.js. Suite 285/285; smoke web, 3D y Electron OK.
- En curso (lote 7): T3.5+T3.7 (perfil 3D→2D, planta con curvas), T4.3+T4.4+T4.8 (Simulation3D, pool de workers, benchmark → G5), T5.1+T5.2 (formas convexas, inercia, cuerpo rígido libre), T6.4 (LAZ con laz-perf WASM).
- Hecho y verificado (lote 7): T3.5+T3.7 (perfil 3D→2D maxErr 0 m, planta + curvas), T4.3+T4.4+T4.8 (Simulation3D, pool con paridad exacta, benchmark Chrome: 1229 rocas/s 1 hilo, 4444 con 8, saturación en 8), T5.1+T5.2 (Quat/Mat3, casco convexo, inercia exacta, rotación libre: deriva 6e-10 %), T6.4 (LAZ laz-perf 0.0.7 Apache-2.0, idéntico a LAS). Coordinador: IMPORT_WORKER_VERSION 3, app-import ?v=4; smokes 2D, 3D (con perfil) y Electron OK. Suite 351/351. Defecto detectado: punto de liberación bajo el terreno al cargar perfil desde 3D (asignado al lote 8).
- Propuesta G5 (pendiente de confirmar): ≤ 2000 rocas interactivo, ≤ 10 000 por corrida, pool min(8, núcleos−1), DEM sin límite práctico para el tiempo (memoria de trayectorias es el límite).
- En curso (lote 8): UI de simulación 3D (zonas, parámetros, pool, trayectorias, mapas, exportación, fix liberación), T4.7 (corredor 3D→2D; el coordinador integra el bloque HTML y scripts), T5.3–T5.5 (contacto rígido 3D, método 'rigid-body').
- Siguiente: integración corredor + método rígido en la UI → revisión independiente final (spec + física + seguridad) → F7 (README/manual, AGENTS.md si se aprueba, limpieza worktree/servidores).
- Nueva decisión informada: G8 = masa de formas no esféricas con espesor 4r/3 (antes 0.5r → energía ~5.7× menor que esfera del mismo diámetro).
- Limpieza pendiente al final: `git worktree remove $TMPDIR/head-tree` y detener servidores http 8765/8766.
- Defecto adicional hallado por el coordinador: `applyRollingFriction` aplica fricción en vuelo (condición `onGround` invertida) — incluido en T0.7.

---

## 1. Recomendación de escritorio (D2)

**Recomendado: Electron**, con el código web intacto en la raíz y el envoltorio en `desktop/`.

| Criterio | Electron | Tauri | Python (PyInstaller/pywebview) |
|---|---|---|---|
| Motor web | Chromium idéntico en los 3 SO | WebView del sistema: WebView2 (Win), WKWebView (mac), **WebKitGTK (Linux)** | WebView del sistema |
| WebGL2 / WebGPU / SharedArrayBuffer | Consistentes | Varían por SO; WebKitGTK es el punto débil en rendimiento WebGL y sin WebGPU | Igual que Tauri |
| Archivos > 100 MB | `File`/`Blob.stream()` en renderer + `fs` en Node si se necesita | Igual en web + Rust nativo | Python nativo |
| Tamaño instalador | ~90–130 MB | ~5–15 MB | ~30–80 MB |
| Cálculo nativo pesado | Node/WASM | Rust nativo (excelente) | Lento salvo Numba/C |
| Experiencia previa del usuario | Sí (conciliacion-geo) | No | Parcial |
| Pruebas | 1 motor | 3 motores distintos | 3 motores |

Razón principal: una herramienta de cálculo con visor 3D pesado y archivos grandes necesita **el mismo motor en los tres sistemas**; Tauri obliga a probar y depurar tres WebViews y en Linux WebKitGTK rinde peor en WebGL. Tauri sería preferible solo si el tamaño del instalador fuera crítico o si se decidiera mover la física a Rust nativo.

Puntos técnicos obligatorios del envoltorio:
- Servir la app por protocolo propio (`app://simrocas/`), **no `file://`**: los Workers y los `<script type="module">` (Three.js) fallan o se restringen bajo `file://`.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; `preload.js` expone una API mínima (`window.simrocasHost`).
- Enviar cabeceras COOP/COEP desde el protocolo → `crossOriginIsolated === true` → `SharedArrayBuffer` disponible para compartir el DEM entre Workers sin copiarlo. En GitHub Pages no se pueden fijar cabeceras; la web usa copia por Worker (o `coi-serviceworker`).
- Misma ruta de código para web y escritorio: la importación usa `<input type=file>` + Worker en ambos; el escritorio añade luego diálogos nativos, archivos recientes y guardado de proyecto.
- Empaquetado: electron-builder → Linux AppImage + .deb, Windows NSIS (.exe), macOS .dmg (x64 + arm64). CI con matriz `ubuntu-latest / windows-latest / macos-latest` al crear tag `v*`.
- Firma: macOS sin Developer ID + notarización es bloqueado por Gatekeeper (Apple Developer, 99 USD/año); Windows sin firma muestra SmartScreen (alternativa económica: Azure Trusted Signing). Linux no requiere firma.
- Actualización automática: `electron-updater` contra GitHub Releases (requiere firma en macOS).

## 2. Datos de dron: implicancias técnicas (D5)

- **DSM vs DTM:** el DSM incluye vegetación y estructuras; para caída de rocas se necesita DTM (terreno desnudo) o el usuario debe saber que árboles serán "terreno". La UI debe advertirlo al importar.
- **Precisión:** STL binario guarda Float32. Con coordenadas UTM (Norte ≈ 6.300.000 m) la resolución Float32 es **0,5 m** — la topografía ya llega degradada en el archivo. Recomendar exportar STL con origen local, o usar OBJ/ASC/XYZ/GeoTIFF (texto o Float64). Internamente: origen local en Float64 y alturas/coordenadas locales en Float32.
- **Memoria:** 100 MB de STL binario ≈ 2 M triángulos; OBJ de 100 MB ≈ 1,5–2 M triángulos. Se parsea en Worker por bloques, se rasteriza a DEM y se libera el buffer original. DEM de física por defecto 0,5 m (configurable 0,25–2 m): 1 km × 1 km a 0,5 m = 4 M celdas = 16 MB. Malla de visualización decimada (≤ ~2 M triángulos).
- **Rendimiento esperado:** física 3D ≈ 5–10× más costosa por paso que 2D (estimación; se mide en T4.8).

---

## 3. Contratos compartidos (congelar antes de paralelizar)

**C1 — Harness de pruebas.** `tests/helpers/load.js` exporta `loadScripts(files, { env, seed })`. `env`: `'browser'` (window = self = sandbox), `'worker'` (solo self), `'node'` (ninguno). `seed` reemplaza `Math.random` por mulberry32 determinista. Ejecutar: `node --test tests/`.

**C2 — Namespace.** Todo archivo núcleo usa `globalThis.SimRocas = globalThis.SimRocas || {};`. Prohibido declarar `const _global` u otros nombres de nivel superior repetidos (los scripts clásicos comparten el entorno léxico global).

**C3 — `SimRocas.Dem`** (`js/dem.js`):
```js
// Coordenadas locales: worldX = originX + x ; worldY = originY + y ; worldZ = originZ + z
new Dem({ cols, rows, cellSize, originX, originY, originZ, heights /* Float32Array, NaN = sin dato */, crs = null })
dem.heightAt(x, y)            // bilineal, NaN fuera o sin dato
dem.normalAt(x, y)            // { nx, ny, nz } unitario, nz > 0
dem.contains(x, y)            // boolean
dem.bounds()                  // { minX, maxX, minY, maxY, minZ, maxZ } locales
dem.sampleProfile(x1, y1, x2, y2, spacing)  // [{ x: distancia, y: cota }] compatible con Terrain 2D
dem.toTransferable() / Dem.fromTransferable(obj)  // para postMessage
```

**C4 — Importadores** (`js/importers/<fmt>.js`, registrados en `SimRocas.importers[fmt]`):
```js
{ id: 'obj', extensions: ['.obj'], detect(name, headBytes) -> boolean,
  parse(input /* ArrayBuffer | AsyncIterable<Uint8Array> */, options, onProgress) -> Promise<
    { kind: 'mesh', positions: Float32Array /* locales */, indices: Uint32Array|null, origin: {x,y,z} /* Float64 */, upAxis: 'Z' }
  | { kind: 'grid', dem: Dem }
  | { kind: 'points', positions: Float32Array, origin: {x,y,z} } > }
```
Conversión común: `SimRocas.DemBuilder.fromMesh(mesh, cellSize)` (envolvente de altura máxima, igual criterio que `StlContour.buildHeightmap` en `js/stl.js:457`) y `DemBuilder.fromPoints(points, cellSize, 'min'|'mean')` + relleno de huecos pequeños.

**C5 — Protocolo del Worker de importación** (`js/workers/import-worker.js`):
IN `{ type: 'import', file /* File */, options: { cellSize, upAxis } }` · OUT `{ type: 'progress', phase: 'read'|'parse'|'raster', progress }`, `{ type: 'done', dem: <transferable>, displayMesh: { positions, indices, origin } }`, `{ type: 'error', message }` (mensaje en español).

**C6 — Límites de terreno.** `terrain.getBounds()` → `{ minX, maxX, minY, maxY }`; la física termina rocas fuera de `[minX - 50, maxX + 50]` o con `y < minY - 100`; si el terreno no implementa `getBounds`, se usan los valores actuales `[-50, 500]` / `-100`.

Contratos de física 3D (C7, `Rock3D`, `PhysicsEngine3D`, pool de Workers) se congelan en T4.0 antes de F4.

---

## 4. Fases y tareas

Formato de cada tarea: **Objetivo · Archivos propios (escritura) · Contexto (solo lectura) · Pasos · Verificación · Depende de.**
Todas las rutas son relativas a `/home/xod/Documentos/Code/rockfall2d-sim`. Ninguna tarea hace commit.

### F0 — Base (lote ejecutable inmediato)

#### T0.1 — Harness de pruebas headless
- **Objetivo:** pruebas en Node sin dependencias que cargan los scripts clásicos.
- **Propios:** `tests/helpers/load.js`, `tests/physics.roughness.test.js`.
- **Contexto:** `scratch/verify_roughness.js`, `js/physics.js`.
- **Pasos:**
  1. Crear `tests/helpers/load.js`:
     ```js
     'use strict';
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

     function loadScripts(files, { env = 'browser', seed = null, extra = {} } = {}) {
         const sandbox = { console, performance, ...extra };
         if (env === 'browser') { sandbox.window = sandbox; sandbox.self = sandbox; }
         if (env === 'worker') { sandbox.self = sandbox; }
         const context = vm.createContext(sandbox);
         if (seed !== null) vm.runInContext(`Math.random = ${MULBERRY32}(${seed});`, context);
         for (const f of files) {
             vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f });
         }
         return context;
     }

     module.exports = { ROOT, loadScripts };
     ```
  2. Portar las aserciones de `scratch/verify_roughness.js` a `tests/physics.roughness.test.js` con `node:test` + `node:assert/strict`.
- **Verificación:** `node --test tests/` → todas pasan.
- **Depende de:** —

#### T0.2 — Namespace portable (`globalThis`)
- **Objetivo:** que `terrain.js`, `stl.js` y `physics.js` carguen en ventana, Worker y Node.
- **Propios:** `js/terrain.js` (línea 5), `js/stl.js` (líneas 9 y 662), `js/physics.js` (líneas 21–23, 95), `tests/namespace.test.js`.
- **Pasos:**
  1. RED: test que carga `['js/terrain.js', 'js/physics.js']` con `env: 'worker'` y espera `SimRocas.Terrain`, `SimRocas.Rock`, `SimRocas.PhysicsEngine` definidos. Debe fallar con `ReferenceError: window is not defined`.
  2. Reemplazar `window.SimRocas = window.SimRocas || {};` por `globalThis.SimRocas = globalThis.SimRocas || {};` (terrain.js, stl.js; en stl.js el IIFE recibe `globalThis.SimRocas`).
  3. En physics.js eliminar `const _global` y usar `globalThis.SimRocas` (incluido `nextRockId` en línea 95).
  4. Agregar al test el caso `env: 'browser'` y `env: 'node'`.
- **Verificación:** `node --test tests/`; `node --check js/*.js`.
- **Depende de:** T0.1.

#### T0.3 — Límites de terreno derivados (C6)
- **Objetivo:** eliminar los límites fijos `[-50, 500]` / `-100`.
- **Propios:** `js/terrain.js` (nuevo método `getBounds()`), `js/physics.js:1056`, `tests/physics.bounds.test.js`.
- **Pasos:** RED con terreno de 0–2000 m: una roca en x = 800 no debe terminar por límites (hoy termina). Implementar `getBounds()` y el uso en `simulateStep` con fallback.
- **Verificación:** `node --test tests/`.
- **Depende de:** T0.2 (mismos archivos; ejecutar en serie, mismo subagente si es posible).

#### T0.4 — Prueba de fragmentación actualizada + diagnóstico de rebote
- **Objetivo:** reemplazar `scratch/verify_fragmentation.js` (obsoleto frente al modelo progresivo de `c1fdbd7`) y diagnosticar por qué la roca no rebota (`vy` queda en −50 tras `handleCollision` lumped-mass).
- **Propios:** `tests/physics.fragmentation.test.js`. **Solo lectura:** `js/physics.js`.
- **Pasos:**
  1. Tests del contrato vigente: `_fragmentRockProgressive` conserva masa (`Σ m_hijos (+ núcleo) == m_padre` ± 1e-6), energía no aumenta, `generation` = padre + 1, modo abrasión (ratio < 3) devuelve núcleo, modo ruptura (ratio ≥ 3) no.
  2. Test: roca esférica d = 0,5 m en y = 0,2 sobre plano y = 0, `vx = 0, vy = −10`; tras `handleCollision(..., 'lumped-mass', 0.6, 0.4)` se espera `vy > 0`. Si falla, registrar causa exacta con `path:línea` (no corregir).
- **Salida obligatoria:** tests en verde para lo correcto; tests del defecto marcados `{ todo: 'T0.7' }`; informe de causa raíz.
- **Depende de:** T0.1.

#### T0.5 — Diagnóstico del criterio de reposo
- **Objetivo:** explicar por qué con lumped-mass y rigid-body ninguna roca se detiene en 30 s sobre el tramo plano del benchmark.
- **Propios:** `tests/physics.resting.test.js`. **Solo lectura:** `js/physics.js` (`_checkResting` en 323, `applyRollingFriction` en 871), `js/terrain.js`.
- **Pasos:** test con el perfil del benchmark (`/home/xod/.hermes/profiles/caida-rocas/skills/software-development/rockfall2d-sim/scripts/headless_bench.js`), semilla fija, 50 rocas, 6000 pasos; medir fracción en reposo y registrar `speed`, `angularVelocity`, `bounces`, `_restCheckCount` de rocas no detenidas. Observación a revisar: `this.angularVelocity < 0.5` sin `Math.abs` en línea 332 (una rotación negativa rápida cuenta como "quieta").
- **Salida obligatoria:** informe de causa raíz con evidencia numérica; test marcado `todo` con la expectativa correcta (≥ 90 % en reposo).
- **Depende de:** T0.1.

#### T0.6 — Higiene de documentación y repo
- **Objetivo:** que la documentación refleje el código actual.
- **Propios:** `TODO.md`, `AGENTS.md`, `README.md`, `.gitignore`, `.github/workflows/deploy.yml`.
- **Pasos:** marcar como completadas en `TODO.md` las funciones ya implementadas (múltiples puntos de liberación, mapa de probabilidad, barreras, atajos, Web Worker, GitHub Pages, copiar/pegar); actualizar arquitectura en `AGENTS.md` (incluir `stl.js`, `tests/`, comando `node --test tests/`) y quitar "Known Issues" ya corregidos; README: umbrales de fragmentación según `physics.js` (generación < 3, diámetro > 0,10 m, modelo progresivo); `.gitignore`: quitar `openspec/` y `scratch/` (están versionados) y añadir `desktop/node_modules/`, `desktop/dist/`; deploy: publicar solo `index.html`, `css/`, `js/`, `vendor/` (paso de copia a `_site/`).
- **Verificación:** revisión del coordinador; `git diff --stat`.
- **Depende de:** —

#### T0.7 — Correcciones de física según T0.4 / T0.5
- **Objetivo:** corregir las causas raíz confirmadas; quitar `todo` de los tests.
- **Propios:** `js/physics.js` (solo las funciones señaladas por los informes).
- **Verificación:** `node --test tests/` sin `todo` pendientes de F0; re-ejecutar benchmark y reportar pasos/s y fracción en reposo.
- **Depende de:** T0.3, T0.4, T0.5. (El coordinador redacta el detalle con los informes.)

#### T0.8 — Worker sin física duplicada
- **Objetivo:** que el Worker use `physics.js` y `terrain.js` reales.
- **Propios:** `js/worker.js`, `js/app.js` (solo `runSimulationWithWorker`, 1703–1842), `tests/worker.parity.test.js`.
- **Pasos:**
  1. RED: test que carga `js/worker.js` con `env: 'worker'`, un `importScripts` simulado que carga archivos vía `loadScripts`, captura `postMessage` y ejecuta una simulación con semilla fija; compara posiciones finales con `Simulation`/`PhysicsEngine` en hilo principal con la misma semilla y parámetros (fragmentación desactivada, variabilidad 0). Debe fallar hoy.
  2. En `worker.js`: `importScripts('terrain.js', 'physics.js')`; eliminar `WorkerTerrain`, `WorkerRock`, `workerFragmentRock`; construir `Terrain` con `fromJSON` y `PhysicsEngine` con todos los parámetros; bucle con `engine.simulateStep` (recoge hijos de fragmentación). Mantener el protocolo de mensajes actual.
  3. En `app.js`: enviar `terrain.toJSON()` y el set completo de parámetros del `PhysicsEngine` (incluidas variabilidades, rodadura, fragmentación).
- **Verificación:** `node --test tests/`; smoke en navegador por el coordinador (modo Worker activado, sin errores de consola, resultados comparables).
- **Depende de:** T0.2, T0.3.

#### T0.9 — Partir `app.js`
- **Objetivo:** preparar la convivencia 2D/3D.
- **Propios:** `js/app.js`, nuevos `js/app-stl.js` (`_buildContours`, `setupStlControls`, 1954–2298), `js/app-worker.js` (`runSimulationWithWorker`, `_renderWorkerFrame`), `index.html` (tags `<script>` y `?v=`).
- **Patrón:** archivos nuevos con `Object.assign(SimRocas.App.prototype, { ... })`, cargados tras `app.js` y antes de `DOMContentLoaded`.
- **Verificación:** `node --check`; smoke del coordinador: importar STL, cortar perfil, simular normal y con Worker.
- **Depende de:** T0.8.

**Oleadas F0:** W0 = T0.1 → W1 = {T0.2→T0.3 (serie), T0.4, T0.5, T0.6} en paralelo → W2 = {T0.7, T0.8} en paralelo (archivos disjuntos) → W3 = T0.9.
**Puerta de cierre F0 (coordinador):** `node --test tests/` verde, `node --check js/*.js`, `git diff --check`, smoke en navegador (modo normal y Worker), revisión de cumplimiento y de calidad en contextos nuevos.

### F1 — Envoltorio de escritorio (Electron) — paralelo a F0 desde W1; requiere G1

| Id | Objetivo | Propios | Verificación | Depende |
|---|---|---|---|---|
| T1.1 | Scaffold `desktop/`: `package.json` (electron, electron-builder), `main.js` con protocolo `app://` que sirve la raíz web (lista blanca: `index.html`, `css/`, `js/`, `vendor/`), ventana segura, `preload.js` con `simrocasHost = { platform, version }`; flag `--smoke` que sale con código 0 tras `did-finish-load` si `document.title` es correcto | `desktop/*` | `npm --prefix desktop ci && xvfb-run npm --prefix desktop run smoke` | G1 |
| T1.2 | Cabeceras COOP/COEP en el protocolo; smoke verifica `crossOriginIsolated === true` y que un Worker arranca | `desktop/main.js` | smoke | T1.1 |
| T1.3 | `desktop/scripts/copy-web.js` (Node puro) copia la app web a `desktop/app-web/`; config electron-builder: AppImage + deb, NSIS, dmg x64 + arm64 | `desktop/scripts/*`, `desktop/package.json` | `npm --prefix desktop run dist -- --linux` genera AppImage que ejecuta smoke | T1.1 |
| T1.4 | CI `.github/workflows/desktop.yml`: matriz 3 SO, disparo por tag `v*`, artefactos en Release (sin firma) | `.github/workflows/desktop.yml` | ejecución en GitHub (verificar el run real) | T1.3 |
| T1.5 | Firma + notarización + `electron-updater` | `desktop/*`, workflow | instalación limpia en cada SO | G4, T1.4 |
| T1.6 | Diálogo nativo abrir/guardar proyecto (`.simrocas` JSON + DEM binario), archivos recientes, con fallback web | `desktop/preload.js`, `js/host.js` | prueba manual + unit de `js/host.js` | T1.2 |

### F2 — DEM e importadores

| Id | Objetivo | Propios | Verificación | Depende |
|---|---|---|---|---|
| T2.1 | `SimRocas.Dem` según C3 (bilineal, normal por diferencias centrales, NaN, bounds, transferible) | `js/dem.js`, `tests/dem.test.js` | plano inclinado: altura y normal exactas ± 1e-6; NaN fuera | T0.2 |
| T2.2 | `Dem.sampleProfile` → puntos compatibles con `Terrain.setPoints` (descarta tramos sin dato, reduce a N puntos reutilizando el criterio de `StlSlicer.compileProfile`, `js/stl.js:371`) | `js/dem.js`, `tests/dem.profile.test.js` | perfil de plano inclinado = recta; con hueco NaN se corta | T2.1 |
| T2.3 | `DemBuilder.fromMesh(mesh, cellSize)` (generaliza `StlContour.buildHeightmap`, `js/stl.js:457`, pero con `cellSize` en metros, origen Float64 y NaN como sin dato) | `js/dem-builder.js`, `tests/dem-builder.mesh.test.js` | 2 triángulos de un plano → DEM igual al plano; envolvente máxima en superposición | T2.1 |
| T2.4 | `DemBuilder.fromPoints(points, cellSize, mode)` + relleno de huecos ≤ 3 celdas (IDW) | `js/dem-builder.js` (sección propia; serie tras T2.3), `tests/dem-builder.points.test.js` | nube regular reproduce plano; hueco aislado rellenado; huecos grandes quedan NaN | T2.3 |
| T2.5 | Importador STL según C4: reutiliza `StlParser`, resta origen en Float64 al leer, advierte si \|coord\| > 1e5 en Float32 (mensaje español) | `js/importers/stl.js`, `tests/importers.stl.test.js` | ASCII y binario de `scratch/test_slope.stl`; advertencia con coordenadas UTM sintéticas | T2.1 |
| T2.6 | Importador OBJ por streaming (`v`, `f` con n-gonos triangulados en abanico, índices negativos; ignora `vt`, `vn`, `mtllib`) | `js/importers/obj.js`, `tests/importers.obj.test.js` | cubo/plano sintético; archivo cortado en bloques arbitrarios produce el mismo resultado | T2.1 |
| T2.7 | Importador ESRI ASCII Grid (`ncols`, `nrows`, `xllcorner`/`xllcenter`, `cellsize`, `NODATA_value`) → `kind: 'grid'` | `js/importers/asc.js`, `tests/importers.asc.test.js` | grilla 3×3 conocida; NODATA → NaN; orientación filas norte→sur correcta | T2.1 |
| T2.8 | Importador XYZ/CSV (separador espacio, coma, punto y coma o tab; cabecera opcional) → `kind: 'points'` | `js/importers/xyz.js`, `tests/importers.xyz.test.js` | variantes de separador; streaming por bloques | T2.1 |
| T2.9 | Importador GeoTIFF con `geotiff.js` vendorizado (DTM de dron) | `vendor/geotiff/*`, `js/importers/geotiff.js` | archivo de prueba pequeño generado con GDAL | G2, G3 |
| T2.10 | Worker de importación según C5: detección por extensión + cabecera, lectura `file.stream()` por bloques, progreso, `DemBuilder`, malla de visualización decimada (≤ 2 M triángulos), transferencia sin copia | `js/workers/import-worker.js`, `tests/import-worker.test.js` | OBJ sintético de 150 MB generado en el test (no versionado): memoria pico registrada, sin bloqueo, DEM correcto | T2.3–T2.8 |
| T2.11 | Importador PLY (ASCII y binario little-endian) | `js/importers/ply.js` + test | malla sintética | T2.1 |

**Oleadas F2:** T2.1 → {T2.2, T2.3, T2.5, T2.6, T2.7, T2.8, T2.11} en paralelo (T2.2 y T2.3 en archivos distintos) → T2.4 → T2.10 → (T2.9 si G2/G3).

### F3 — Visor 3D y paso 3D → 2D

| Id | Objetivo | Propios | Verificación | Depende |
|---|---|---|---|---|
| T3.1 | Vendorizar Three.js (versión estable fijada) + `OrbitControls`; `importmap` en `index.html`; `js/three-bridge.js` (módulo) asigna `window.THREE`, `THREE.OrbitControls` y emite evento `simrocas:three-ready` | `vendor/three/*` (+ LICENSE), `js/three-bridge.js`, `index.html` | smoke navegador: evento recibido, `THREE.REVISION` registrado | D1 |
| T3.2 | `SimRocas.Viewer3D`: escena, cámara, luces, controles orbitales, redimensionado, `dispose()` | `js/view3d.js` | smoke: canvas WebGL2 visible sin errores | T3.1 |
| T3.3 | Malla de terreno desde DEM/malla decimada con origen local, color por cota y por pendiente, exageración vertical | `js/view3d-terrain.js` | smoke con DEM sintético 1000×1000 a ≥ 30 fps | T3.2, T2.1 |
| T3.4 | Conmutador de modo 3D / 2D (pestañas, etiquetas en español), el 2D intacto | `index.html`, `css/style.css`, `js/app-modes.js` | smoke: alternar sin perder estado 2D | T0.9, T3.2 |
| T3.5 | Trazado de línea de perfil (clic sobre terreno por raycast; polilínea), `Dem.sampleProfile` → `Terrain` 2D → cambia a modo 2D | `js/view3d-profile.js`, `js/app-modes.js` (sección propia) | smoke: perfil en 2D coincide con `sampleProfile` | T3.3, T3.4, T2.2 |
| T3.6 | Panel de importación 3D: selector de archivo, `cellSize`, eje vertical, progreso del Worker, advertencia DSM/DTM y de precisión | `index.html` (sección), `js/app-import.js` | smoke con OBJ y ASC de prueba | T2.10, T3.4 |
| T3.7 | Vista en planta con curvas de nivel (reutilizar `StlContour.generateContours` sobre `Dem`) | `js/view3d-plan.js` | smoke | T3.3 |

### F4 — Física 3D (masa concentrada) y resultados

| Id | Objetivo | Propios | Verificación | Depende |
|---|---|---|---|---|
| T4.0 | Congelar C7: `Rock3D`, `PhysicsEngine3D.simulateStep(rock, dem, dt)`, formato de trayectorias (Float32 xyz+v), protocolo del pool de Workers | `docs/contracts-3d.md` | revisión del coordinador | F2 |
| T4.1 | `SimRocas.Vec3`/`Quat` (operaciones sin asignación de memoria) | `js/math3d.js`, `tests/math3d.test.js` | identidades, normalización, rotación de vectores | T0.1 |
| T4.2 | `Rock3D` masa concentrada: gravedad, contacto con DEM, restitución normal/tangencial por celda, rodadura, reposo | `js/physics3d.js`, `tests/physics3d.lm.test.js` | caída sobre plano: altura de rebote = Cn²·h ± 1 %; plano inclinado sin fricción: a = g·sinθ ± 1 %; roca en reposo en plano | T4.0, T4.1, T2.1 |
| T4.3 | Paridad 2D↔3D: DEM extruido de un perfil 2D produce el mismo alcance que lumped-mass 2D (mismos parámetros, variabilidad 0) | `tests/physics3d.parity.test.js` | diferencia de alcance medio < 2 % | T4.2, T0.7 |
| T4.4 | Pool de Workers (`navigator.hardwareConcurrency - 1`), DEM compartido por `SharedArrayBuffer` si `crossOriginIsolated`, si no copia | `js/workers/sim3d-worker.js`, `js/sim3d-pool.js` | test headless con 2 workers simulados; smoke en navegador y Electron | T4.2 |
| T4.5 | Zonas fuente: polígono en planta → puntos aleatorios; fuentes puntuales | `js/source-zones.js` + test | distribución uniforme dentro del polígono (test estadístico) | T4.0 |
| T4.6 | Render de trayectorias 3D (límite configurable de trayectorias dibujadas) y puntos de detención | `js/view3d-trajectories.js` | smoke con 1000 rocas | T4.4, T3.3 |
| T4.7 | Proyección de trayectorias 3D al perfil 2D dentro de un corredor de ancho configurable; superposición en el renderer 2D | `js/profile-corridor.js` + test, `js/renderer.js` (sección propia) | test geométrico; smoke | T4.4, T3.5 |
| T4.8 | Benchmark 3D headless (pasos/s por hilo, escalamiento con N workers) → propuesta de límites | `tests/bench/physics3d.bench.js` | informe numérico | T4.2 → **G5** |
| T4.9 | Rásteres de resultados: frecuencia de paso, energía máx., altura de rebote máx., alcance; exportación ASC | `js/results3d.js` + test, overlay en visor | test con trayectorias sintéticas | T4.4 |

### F5 — Cuerpo rígido 3D / dinámica no suave

| Id | Objetivo | Verificación | Depende |
|---|---|---|---|
| T5.1 | Generador de poliedros convexos (bloque, elipsoide, irregular) + tensor de inercia por tetraedros | cubo y esfera: tensor analítico ± 0,5 % | T4.1 |
| T5.2 | Integración de cuerpo rígido con cuaterniones (ecuaciones de Euler) | rotación libre conserva energía y momento angular ± 0,1 % en 10 s | T5.1 |
| T5.3 | Detección de contacto vértices del poliedro vs DEM | casos sintéticos de penetración | T5.2, T2.1 |
| T5.4 | Impulso no suave: Poisson/Newton normal + cono de Coulomb 3D (Leine 2013 / Caviezel 2019) | bloque en plano: desliza si tanθ > μ, se detiene si no; la energía nunca aumenta | T5.3 |
| T5.5 | Rugosidad y material por celda (ráster de material importable/pintable) | normal perturbada acotada ±θr; estadística como en `tests/physics.roughness.test.js` | T5.4 |
| T5.6 | Validación contra casos publicados (opcional: arnés Python fuera de la app) | informe | T5.4 |
| T5.7 | Fragmentación 3D (modelo progresivo de 2D) | conservación de masa/energía | T5.4 |

### F6 — Formatos restantes (requiere G2)

| Id | Objetivo | Depende |
|---|---|---|
| T6.1 | DXF: `LWPOLYLINE`/`POLYLINE` con elevación y `3DFACE` (parser propio de pares código/valor) | T2.1 |
| T6.2 | Triangulación de curvas de nivel con `delaunator` → `DemBuilder.fromMesh` | T6.1 |
| T6.3 | LAS sin compresión (puntos clase 2 = suelo si existe clasificación) | T2.4 |
| T6.4 | LAZ con `laz-perf` WASM | T6.3 |

### F7 — Publicación y documentación

T7.1 README/AGENTS/manual de usuario en español (flujo 3D → perfil 2D, preparación de datos de dron). T7.2 versión web: deploy con `vendor/`. T7.3 primer release de escritorio (tag) y verificación de instaladores en los 3 SO.

---

## 5. Plantilla de delegación (cada subagente)

```
Repositorio: /home/xod/Documentos/Code/rockfall2d-sim (cwd obligatorio). JS vanilla, scripts clásicos,
namespace globalThis.SimRocas, 4 espacios, comillas simples, punto y coma, identificadores en inglés,
textos de UI en español. Sin npm en la raíz. Pruebas: node --test tests/ (helper tests/helpers/load.js).
Tarea <Id>: <objetivo>.
Archivos que PUEDES modificar: <lista absoluta>. Solo lectura: <lista>. Otros agentes editan otros
archivos en paralelo: no toques nada más. No hagas commit.
Contrato: <C# pertinente, copiado literal>.
Proceso: 1) escribe un test que falle por el comportamiento (no por módulo faltante); 2) ejecútalo y
copia el fallo; 3) implementación mínima; 4) node --test tests/ y node --check de los archivos tocados.
Detente al alcanzar GREEN. Responde con: archivos cambiados, comando y salida RED, comando y salida
GREEN, advertencias.
```

## 6. Verificación del coordinador (cada oleada)

1. `git status --short`, `git diff --stat`, revisión del diff real y de la propiedad de archivos.
2. `git diff --check`; `node --check js/*.js`; `node --test tests/` sobre el árbol integrado.
3. Smoke en navegador (servidor `python3 -m http.server 8080`) cuando la oleada toca UI o Worker; bump de `?v=` en `index.html` para cada script editado.
4. Revisores en contexto nuevo (cumplimiento del plan y calidad) al cierre de cada fase.
5. Informe: tareas cerradas, resultados reales de pruebas, hallazgos diferidos.

## 7. Riesgos

- **Rendimiento 3D en datos de dron:** mitigado por DEM remuestreado, malla decimada y pool de Workers; WASM como plan B tras T4.8.
- **Precisión de coordenadas:** origen Float64 obligatorio desde el importador (C3/C4).
- **Divergencia web/escritorio:** una sola base de código; el escritorio solo agrega `simrocasHost`.
- **Realismo:** la validación (T4.3, T5.6) es parte del plan, no un extra; sin calibración los resultados 3D no deben presentarse como definitivos.
- **Alcance:** F5 es la fase más incierta; se re-planifica con detalle al cerrar F4.
