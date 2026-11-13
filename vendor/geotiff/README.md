# geotiff.js (vendorizado)

Global-clásico de [geotiff.js](https://github.com/geotiffjs/geotiff.js) para
SimRocas: lectura de GeoTIFF (incluido DTM/DSM de dron con compresión
LZW/Deflate, predictor 2/3 y tiles) como **script clásico** y también vía
`importScripts` en un Web Worker (expone `globalThis.GeoTIFF` / `self.GeoTIFF`).

- **Versión:** 3.0.5 (npm), bundle `dist-browser/geotiff.js` tal cual (UMD).
- **Licencia:** MIT (ver `LICENSE`, © EOX IT Services GmbH y contribuidores).
- **Origen:** tarball `geotiff-3.0.5.tgz` de npm (`npm pack geotiff@3.0.5`,
  `package/dist-browser/geotiff.js`, sin modificaciones).
- **Tamaño:** ~551 KB (minificado), decoders propios embebidos: sin fetch de
  `workers/` ni decoders desde CDN. El pool de decodificación usa Blob si hay
  `Worker` disponible y fallback en-hilo si no; lectura vía `fromArrayBuffer`
  no hace I/O externo.
- **SHA-256 de `geotiff.js`:** `8cfc01ffc945904766d8fb89f19da7afb799e342834454f5592fbcf0bcfe2db5`

## Regeneración

```sh
npm pack geotiff@3.0.5
tar xzf geotiff-3.0.5.tgz
cp package/dist-browser/geotiff.js vendor/geotiff/geotiff.js
sha256sum vendor/geotiff/geotiff.js
```

Si una versión futura dejara de publicar `dist-browser/` (UMD), se puede regenerar
un bundle IIFE equivalente una sola vez con esbuild:

```sh
npx esbuild package/dist-module/geotiff.js \
    --bundle --format=iife --global-name=GeoTIFF --minify \
    --outfile=vendor/geotiff/geotiff.js
```

## Globals requeridos por el bundle (sandbox de tests / Web Worker)

`TextDecoder`, `TextEncoder`, `setTimeout`, `clearTimeout` (+ `performance` y
`console`, ya presentes en el sandbox de `tests/helpers/load.js`). En un Web
Worker real los provee el propio entorno.
