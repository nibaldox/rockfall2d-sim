# Fixtures LAZ/LAS point10 —— provenencia

Par equivalente (mismos puntos) LAS sin comprimir y LAZ comprimido para los
tests `tests/importers.laz.test.js` (T6.4: descompresión LAZ con laz-perf
vendored en `vendor/laz-perf/`).

- **Origen:** repositorio [hobuinc/laz-perf](https://github.com/hobuinc/laz-perf),
  carpeta `cpp/test/raw-sets/`, commit
  `f2e7491902dc06bf4ce0a4577d3af3b98f280b2a` (main, octubre 2025).
  Éstos son los mismos conjuntos que usa el propio proyecto para sus tests
  (`js/src/test/file.test.ts` descomprime `autzen_trim.laz` y
  `point-time-1.4.las.laz` de esa carpeta).
- **Licencia:** Apache-2.0 (el código y los datos de test del repositorio laz-perf;
  text completo en `vendor/laz-perf/LICENSE`).
- **Archivos y SHA-256:**
  - `point10.las` 22 507 bytes
    `7c6468f132fe4b9ff4416549ff642ad9bde29c57b05b2ea4917aed6a8afc120b`
  - `point10.las.laz` 10 988 bytes
    `5cd4cfd110cf6dd642107d08f3797ba4e971ec123a19df671f4b11aaebb7b54e`
  Cada uno está muy por debajo del límite de 1 MB pedido.
- **Contenido:** LAS 1.2, punto formato 0 (20 bytes/registro), 1 065 puntos
  clasificados: 789 de clase 1 (no suelo) y 276 de clase 2 (suelo) — permite
  validar el filtro de suelo y `decimate` sobre datos descomprimidos.
- **Nota sobre la alternativa propuesta (PDAL `test/data/simple.las/.laz`):**
  el repositorio actual https://github.com/PDAL/data (donde PDAL movió sus
  datos de test) no contiene `simple.las`/`simple.laz`; las rutas históricas
  `PDAL/PDAL@<tag>/test/data/las/simple.las` son enlaces simbólicos al repo de
  datos. Se eligieron los fixtures equivalentes de laz-perf (mismo licenciamiento
  editable y más ligados a la librería vendored). Si hiciera falta el par de
  PDAL, está disponible en versión previa al traslado (p. ej. tarball
  PDAL 1.9.x) bajo licencia BSD-3 de PDAL.

Cada fixture es la versión comprimida/expandida del mismo conjunto de puntos:
los tests verifican que descomprimir el LAZ produce exactamente los mismos
positions que parsear el LAS equivalente.
