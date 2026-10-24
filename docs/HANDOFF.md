# Continuación en otro PC — 24 de octubre de 2026

## Rama de trabajo

`wip/pc-handoff-2026-10-24` conserva el estado local de desarrollo: base 2D, módulos 3D, importadores, pruebas, bibliotecas vendorizadas y envoltorio Electron.

Es un checkpoint de trabajo, no una versión estable. No se ha mezclado con `main` ni se ha publicado como release.

- Base local anterior al checkpoint: `c1fdbd70f76dd0de3908230d33537a929ae332a7`.
- `origin/main` al preparar el checkpoint: `39ef91c819f9bd3c8c9379f5c1274257fee65686`.
- Hay cuatro commits remotos pendientes de integrar, entre ellos correcciones de duplicación de núcleo y conservación de masa durante fragmentación. Los cambios remotos y locales coinciden en `index.html` y `js/physics.js`; revisar la integración, no sobrescribir ninguno de los dos lados.

## Recuperar el proyecto

Para un clon nuevo:

```bash
git clone --branch wip/pc-handoff-2026-10-24 https://github.com/nibaldox/rockfall2d-sim.git
cd rockfall2d-sim
```

En un clon existente, primero guardar cualquier trabajo propio y después:

```bash
git fetch origin
git switch --track origin/wip/pc-handoff-2026-10-24
```

Si esa rama local ya existe, usar `git switch wip/pc-handoff-2026-10-24` en lugar de crearla otra vez.

## Ejecutar

Web (Python 3):

```bash
python3 -m http.server 8080
```

Abrir `http://localhost:8080`.

Escritorio (Node.js y npm; el CI usa Node 22):

```bash
npm --prefix desktop ci
npm --prefix desktop start
npm --prefix desktop run smoke
```

Las dependencias instaladas, `desktop/app-web/`, compilados de `desktop/dist/` y el estado local de `.hermes/` no forman parte del checkpoint. Las dependencias se regeneran desde `desktop/package-lock.json`; el empaquetado genera la copia web.

## Verificación previa al checkpoint

Medida en el PC de origen con Node 26.11.1:

- Sintaxis: 86 archivos JavaScript de aplicación, pruebas y Electron comprobados sin errores.
- `git diff --check` antes de añadir archivos nuevos: sin errores en los cambios ya versionados. La comprobación posterior del índice detectó espacios finales en `js/app-stl.js` y `vendor/laz-perf/laz-perf.js`, y una línea vacía final en `vendor/geotiff/LICENSE`. Se preservan sin modificar en este checkpoint; son incidencias de formato, no validaciones funcionales.
- `node --test tests/`: 382 pruebas, 376 pasan, 6 fallan, ninguna omitida/TODO; duración aproximada 60,7 s.
- `npm --prefix desktop run smoke`: correcto con Electron 44.9.0; carga, aislamiento, Worker, simulación de 10 rocas y bloqueo de rutas indebidas. Sin errores de consola ni de carga.

### Fallos conocidos que deben conservarse visibles

Tres pruebas de comportamiento/integración del cuerpo rígido 3D:

1. `tests/physics3d-rigid.test.js`: deslizamiento Coulomb a 35 grados fuera de tolerancia.
2. `tests/physics3d-rigid.test.js`: plausibilidad ladera y llano; 18 de 30 rocas alcanzan el llano, por debajo del criterio exigido.
3. `tests/physics3d-rigid.test.js`: paridad del pool, transporte de orientaciones.

Tres umbrales de rendimiento incumplidos en la última ejecución:

1. `tests/physics3d.test.js`: 141341 pasos/s frente al mínimo 150000.
2. `tests/profile-corridor.test.js`: proyección 2481 ms frente al límite 2000.
3. `tests/results3d.test.js`: construcción 5536 ms frente al límite 5000.

Los tiempos dependen del equipo y de la carga; no se han diagnosticado ni corregido como parte de la transferencia.

## Próximos pasos

1. Integrar de forma controlada `origin/main`, preservando los avances de esta rama y sus correcciones remotas.
2. Diagnosticar los fallos del motor rígido 3D y medir los tests de rendimiento aisladamente.
3. Completar la integración en UI de los módulos pendientes (cuerpo rígido 3D y corredor); no confundir código existente con funcionalidad habilitada.
4. Actualizar README/TODO y documentación de arquitectura, que aún describen parcialmente un estado anterior.
5. Repetir pruebas y verificaciones antes de incorporar el trabajo a `main` o crear una release.
