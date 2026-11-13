# SimRocas Desktop

Envoltorio Electron para la app web SimRocas (vanilla JS, sin build). La app web
en la raíz del repositorio sigue funcionando igual en el navegador y en GitHub
Pages; `desktop/` solo la carga dentro de una ventana Electron.

## Ejecutar

```bash
npm --prefix desktop install     # instala electron y genera package-lock.json
npm --prefix desktop start       # abre la ventana de SimRocas
npm --prefix desktop run smoke   # prueba automatizada headless (ventana oculta)
```

## Arquitectura

- **Protocolo `app://`**: la app se sirve por un protocolo propio
  (`app://simrocas/index.html`) en lugar de `file://`. Ventajas: origen real y
  estable (permite `fetch`, Workers y APIs que `file://` bloquea), rutas relativas
  intactas, y control total de cabeceras y lista blanca de archivos.
- **COOP/COEP**: todas las respuestas incluyen
  `Cross-Origin-Opener-Policy: same-origin` y
  `Cross-Origin-Embedder-Policy: require-corp`, más
  `Cross-Origin-Resource-Policy: same-origin`. Con eso `crossOriginIsolated === true`
  y `SharedArrayBuffer` está disponible a futuro (p. ej. Workers compartidos).
  El modo smoke lo verifica y falla si deja de ser así.
- **Lista blanca**: el protocolo solo sirve `index.html` y archivos bajo `css/`,
  `js/` y `vendor/`. Cualquier otra ruta (incluyendo `desktop/main.js` o el
  `package.json`) responde 403/404; los intentos de path traversal (`..`,
  rutas absolutas, backslashes) se rechazan.

## Seguridad

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`.
- `preload.js` es mínimo: solo expone `window.simrocasHost`
  (`platform`, `isDesktop`, versión de Electron) vía `contextBridge`; no hay Node
  ni APIs de Electron expuestas a la web.
- `setWindowOpenHandler` deniega toda ventana emergente; las URLs `http(s)://`
  se abren en el navegador del sistema con `shell.openExternal`.
- `will-navigate` bloquea la navegación fuera de `app://simrocas`.
- Menú de aplicación mínimo; el `package.json` es `private`.

## Modo smoke

`npm run smoke` lanza la app con `--smoke`: ventana oculta, espera la carga,
verifica `crossOriginIsolated`, que un Worker arranque, ejecuta una simulación
corta (10 rocas) hasta ver «Completado» y prueba que las rutas prohibidas
respondan 403. Imprime un JSON en stdout (`SMOKE_RESULT:...`) y termina con
exit 0 solo si todo pasa.

## Empaquetado (Linux AppImage/deb, Windows NSIS, macOS dmg)

```bash
npm --prefix desktop install
npm --prefix desktop run dist:linux   # AppImage + .deb en desktop/dist/
npm --prefix desktop run dist:win     # instalador NSIS x64
npm --prefix desktop run dist:mac     # dmg x64 + arm64
npm --prefix desktop run dist         # empaqueta según la plataforma actual
```

- `scripts/copy-web.js` (Node puro, sin dependencias) copia `index.html`,
  `css/`, `js/` y `vendor/` desde la raíz del repo a `desktop/app-web/`
  (borra el destino antes) y falla si aparece algo no autorizado.
- `electron-builder` empaqueta `main.js` + `preload.js` y coloca `app-web/` en
  `resources/app-web` vía `extraResources`; ahí sirve la app el protocolo
  `app://` cuando `app.isPackaged`. Salida en `desktop/dist/`.
- Config en `"build"` de `desktop/package.json`: appId `cl.simrocas.app`,
  Linux con `category: Science`, Win NSIS x64 (no one-click), mac dmg x64+arm64
  con `identity: null`.

## CI multiplataforma

`.github/workflows/desktop.yml` se dispara con tags `v*` y `workflow_dispatch`:
matriz ubuntu/windows/macos, Node 22 con cache npm, smoke bajo `xvfb-run` en
Linux, `npm run dist:<os>` sin firma (`CSC_IDENTITY_AUTO_DISCOVERY=false`) y
subida de artefactos. En tags, un job separado crea un Release *draft* con los
artefactos vía `softprops/action-gh-release@v2`.

## Advertencia de firma

La firma de código NO está configurada:

- **macOS**: sin Developer ID (Apple Developer Program) el dmg/app quedará sin
  firmar y **Gatekeeper lo bloqueará** al abrirlo; el usuario tendrá que hacer
  clic derecho → Abrir o quitar la cuarentena (`xattr -d com.apple.quarantine`).
- **Windows**: el instalador NSIS sin Authenticode disparará la advertencia
  **SmartScreen** al ejecutarlo («Windows protected your PC»).

Para distribución a terceros hace falta un certificado (Apple Developer ID y
OV de firma Windows) y añadir las credenciales como secrets en CI.
