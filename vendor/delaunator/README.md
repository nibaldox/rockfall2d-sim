# delaunator (vendorizado)

Triangulación de Delaunay 2D de [delaunator](https://github.com/mapbox/delaunator)
para SimRocas: triangulación de curvas de nivel en el importador DXF
(`js/importers/dxf.js`). Bundle **UMD** tal cual del tarball de npm, compatible
con script clásico y `importScripts` en Web Worker (expone
`globalThis.Delaunator` / `self.Delaunator`).

- **Versión:** 5.1.0 (npm), `package/delaunator.js` tal cual (UMD, sin minificar,
  sin modificaciones).
- **Licencia:** ISC (ver `LICENSE`, © 2026 Mapbox / Vladimir Agafonkin).
- **Origen:** tarball `delaunator-5.1.0.tgz` de npm (`npm pack delaunator@5.1.0`).
  El bundle ya incluye `robust-predicates` embebido (rollup), no requiere dependencias.
- **Tamaño:** 27 051 bytes (26 KB), bundle minificado-grado-UMD sin minificar
  (880 líneas).
- **SHA-256 de `delaunator.js`:**
  `33db0578d3d651c5bcc31f7b4939e50f353c1281608ea79020eacbb121b66ba1`

## Regeneración

```sh
npm pack delaunator@5.1.0
tar xzf delaunator-5.1.0.tgz package/delaunator.js package/LICENSE
cp package/delaunator.js vendor/delaunator/delaunator.js
cp package/LICENSE vendor/delaunator/LICENSE
sha256sum vendor/delaunator/delaunator.js
```

Si una versión futura dejara de publicar el build UMD `delaunator.js`, se puede
regenerar un bundle IIFE equivalente una sola vez con esbuild (exponiendo la
clase por defecto como global `Delaunator`):

```sh
npx esbuild package/index.js --bundle --format=iife \
    --global-name=Delaunator --outfile=vendor/delaunator/delaunator.js
```

Nota: `--format=iife --global-name=Delaunator` asigna la exportación por
defecto de `index.js` a `globalThis.Delaunator`; verificar después con
`node -e "require('./vendor/delaunator/delaunator.js'); console.log(typeof Delaunator)"`.

## Globals requeridos por el bundle (sandbox de tests / Web Worker)

Ninguno especial: solo los primordiales estándar (`Math`, typed arrays). En el
sandbox de `tests/helpers/load.js` funciona con `env: 'node'` y con el shim de
`importScripts` en worker, y en un Web Worker real los provee el entorno.
