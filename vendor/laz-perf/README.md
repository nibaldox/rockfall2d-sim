# laz-perf (vendorizado)

Descompresión de nubes de puntos **LAZ** (LASzip) para SimRocas: el importador
LAS (`js/importers/las.js`) descomprime .laz punto a punto con este módulo WASM
emscriptenizado, y el worker de importación (`js/workers/import-worker.js`)
carga el glue por `importScripts`. El proyecto de origen es
[laz-perf](https://github.com/hobuinc/laz-perf) (Hobu Inc.), la implementación
alternativa de LAZ escrita en C++ que usa PDAL.

- **Versión:** 0.0.7 (npm, publicada 2025-02-19), tarball `laz-perf-0.0.7.tgz`.
- **Licencia:** Apache-2.0 (verificada: `license: "Apache-2.0"` en
  `package.json` del paquete y texto completo ACCIÓN `COPYING` del repositorio
  copiado aquí como `LICENSE`).
- **Glue JS:** `package/lib/web/laz-perf.js` del tarball, sin modificar. Es un
  script clásico (IIFE MODULARIZE de Emscripten con cola UMD neutra) que expone
  la fábrica `createLazPerf(options)` como `var` global: no requiere `exports`,
  `define` ni bundling ESM y funciona con `importScripts` dentro del Web Worker
  de importación. Se eligió el build **web** (no el de `lib/worker`) porque su
  arranque no depend de `self.location.href`: dentro del worker la detección la
  satisface la presencia de `importScripts` y el `.wasm` se resuelve con
  `locateFile` (la API es idéntica; el binario es el mismo).
- **WASM:** `package/lib/web/laz-perf.wasm` del tarball, sin modificar.
- **Archivo expuesto:** `createLazPerf({ locateFile })` → Promise del módulo con
  las clases embind `LASZip` (open/​getPoint/​getCount/​getPointLength/
  getPointFormat) y `ChunkDecoder`, más `_malloc`/​`_free`/​`HEAPU8`.
- **Tamaños:** glue 87 228 bytes (86 KB), wasm 214 351 bytes (210 KB).
- **SHA-256 del glue:** `d9a91a08979dd9f717884e33c9f61997e79122da2c02be8414a5d7e99061985e`
- **SHA-256 del wasm:** `9c1802bc31b567dd4aa1ce9ab010e7e51e095dc42af8379b474ae6f221a9327f`

## Regeneración

```sh
npm pack laz-perf@0.0.7
tar xzf laz-perf-0.0.7.tgz package/lib/web/laz-perf.js package/lib/web/laz-perf.wasm
cp package/lib/web/laz-perf.js vendor/laz-perf/laz-perf.js
cp package/lib/web/laz-perf.wasm vendor/laz-perf/laz-perf.wasm
cp COPYING vendor/laz-perf/LICENSE   # COPYING de https://github.com/hobuinc/laz-perf
sha256sum vendor/laz-perf/laz-perf.js vendor/laz-perf/laz-perf.wasm
```

Si una versión futura solo publicara ESM (tar de `lib/` con `export`), genera
una vez un bundle IIFE sin tocar el código fuente:

```sh
npx esbuild node_modules/laz-perf/lib/web/index.js --bundle \
    --format=iife --global-name=LazPerfModule \
    --outfile=vendor/laz-perf/laz-perf.js
# el global quedaría en LazPerfModule.default; ajustar los consumidores a
# globalThis.LazPerfModule en js/importers/las.js y js/workers/import-worker.js
```

Verificar tras regenerar: `node --check vendor/laz-perf/laz-perf.js` y los
SHA-256 de arriba.

## Integración

- El glue NO se invoca al cargarlo: la inicialización del WASM es perezosa y
  queda cacheada en `js/importers/las.js` (una promesa por worker). El worker
  pasa la carpeta de los recursos vía `self.SimRocas.lazPerfUrl`
  (`'../../vendor/laz-perf/'`, relativo al worker) y el glue la resuelve con
  `locateFile` — sin CDN.
- Los tests inyectan `SimRocas.lazPerfModuleOptions` (p. ej. `instantiateWasm`
  que lee el `.wasm` con `fs`) sin modificar este glue.
- Si la carga del glue o del WASM falla, el importador de LAS/XYZ sigue
  funcionando; el error solo aparece al importar un .laz, con mensaje en
  español.
- Limitación: la API WASM de laz-perf 0.0.7 solo DECOMPRIME (no tiene
  compresión); LAZ completo requiere el archivo entero en memoria (no
  streaming).
