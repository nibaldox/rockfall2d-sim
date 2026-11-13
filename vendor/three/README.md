# Three.js vendorizado (r186) — SimRocas

Three.js r186.1 vendido para el visor 3D. Toda la app usa el **importmap**
declarado en la página que lo consume (ver más abajo); ningún archivo del repo
importa `three` por rutas relativas internas de vendor/.

## Origen

Tarball oficial de npm: <https://registry.npmjs.org/three/-/three-0.186.1.tgz>
(versión `0.186.1`, `REVISION = '186'`).

El paquete npm de r≥171 ya **no incluye** los artefactos minificados
(`build/*.min.js`); tanto `three.module.js` como `three.core.min.js` de este
directorio se obtuvieron minificando los build ESM oficiales del tarball con
terser (`--ecma 2020 --module --compress passes=2 --mangle`). En
`three.module.min.js` se reescribió el especificador de import
`"./three.core.js"` a `"./three.core.min.js"` para mantener la misma estructura
de archivos que publica el CDN oficial de three.js. Sin código fuente alterado.

## Archivos y SHA-256

| Archivo | Tamaño | Origen | SHA-256 |
|---|---|---|---|
| `three.module.min.js` | 375 089 B | build/three.module.js (tarball, minificado aquí) | `8ec0d61c2c28d1ba7a494dd8233da2ee7e7bb189de7b65630e1d37eb5437ddec` |
| `three.core.min.js` | 389 036 B | build/three.core.js (tarball, minificado aquí) | `c81141efe98c5a1efc154fde7a685206c491e01fb46eb308a512331abb62e0f4` |
| `addons/controls/OrbitControls.js` | 40 755 B | examples/jsm/controls/OrbitControls.js (tarball, copia idéntica) | `3d79d07ecb686b4e5d93232eedab255331c1beef711e13164eaa1f68655a5f2b` |
| `LICENSE` | 1 081 B | package/LICENSE (tarball, copia idéntica) | `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc` |

Nota: DIM ya consultado en r186: `three.module.js` importa `./three.core.js`
(así lo hacía r171+), y `examples/jsm/controls/OrbitControls.js` importa solo
`'three'`. No se empaquetan otros addons.

## Integración (módulo ES + script clásico)

En la página HTML, antes de cualquier script que use `THREE`:

```html
<script type="importmap">
{"imports":{"three":"./vendor/three/three.module.min.js","three/addons/":"./vendor/three/addons/"}}
</script>
<script type="module" src="js/three-bridge.js"></script>
<!-- luego los scripts clásicos existentes, p.ej. -->
<script src="js/dem.js"></script>
<script src="js/view3d.js"></script>
```

`js/three-bridge.js` expone todo el namespace de Three.js + `OrbitControls` en
`globalThis.THREE`, marca `SimRocas.threeReady = true` y dispara el evento
`simrocas:three-ready` cuando termina de cargar. Los scripts clásicos NO deben
importar nada ES: usan `globalThis.THREE` en tiempo de ejecución (ver
`js/view3d.js`).

## Actualización

1. Descarga el tarball de la versión objetivo:
   `curl -O https://registry.npmjs.org/three/-/three-X.Y.Z.tgz`
2. Extrae `package/build/three.module.js`, `package/build/three.core.js`,
   `package/examples/jsm/controls/OrbitControls.js` y `package/LICENSE`.
3. Minifica cada build ESM con terser, como arriba; en el minificado del módulo
   reescribe `"./three.core.js"` a `"./three.core.min.js"`.
4. Copia los resultado reemplazando los existentes (nombres idénticos).
5. Verifica con un `grep "REVISION"` de `three.core.min.js` y repite esta
   verificación de rutas/imports si `three-core` cambió de estructura entre
   versiones (revisa todos los `from '...'` de los build ESM).
6. Recalcula SHA-256 y actualiza la tabla, y repite las pruebas del
   visor con la página dev.

## Licencia

MIT — Copyright © 2010-2026 Three.js Authors (ver `LICENSE`).
