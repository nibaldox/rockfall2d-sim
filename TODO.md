# TODO — SimRocas 2D

**Última actualización:** 17/Oct/2026

---

## ✅ COMPLETADO

- [x] Editor de perfil topográfico interactivo
- [x] Motor de física poligonal real (colisiones por vértice, torque, momento de inercia)
- [x] Parámetros configurables (Cn, Ct, fricción, densidad, etc.)
- [x] Variabilidad Monte Carlo
- [x] Visualización de trayectorias y puntos de impacto
- [x] Estadísticas completas (min, mean, max, P50, P83, P95)
- [x] Histograma de energía
- [x] Zoom con scroll y pan con mouse
- [x] Exportar PNG, CSV, reporte texto
- [x] Guardar/cargar perfiles JSON
- [x] Formas poligonales irregulares con colores realistas
- [x] Rotación real de rocas por impacto asimétrico
- [x] Zonas de vegetación/refuerzo — segmentos con Cn/Ct por tramo y 7 tipos de terreno
- [x] Importar perfil desde CSV — coordenadas X,Y desde datos reales
- [x] Perfil con múltiples segmentos de material — editor con preset por rango
- [x] Tema claro/oscuro — toggle con persistencia en localStorage
- [x] Animación frame por frame — timeline con prev/next/scrubber/play
- [x] 3 métodos de cálculo — Cuerpo Rígido (impulso/energy-ratio), Lumped Mass, Nonsmooth Dynamics
- [x] 4 formas de roca — polígono irregular, esfera, elipse, bloque angular
- [x] Reproducción timeline — grabación y playback de toda la simulación
- [x] Optimización profunda — vertex cache, flat array trajectories, render throttle, zero-alloc step
- [x] Modo Desprendimiento — release de roca sobre la superficie del terreno (simulación de caída por desprendimiento)
- [x] Múltiples puntos de liberación — orígenes con velocidad y ángulo independientes, rocas distribuidas equitativamente
- [x] Mapa de probabilidad — bandas P10/P50/P83/P95 dibujadas sobre el perfil
- [x] Barreras de contención — segmentos con Cn/Ct propios y colisión física real
- [x] Copiar/pegar coordenadas — desde Excel en formato tabular X(tab)Y
- [x] Atajos de teclado — Ctrl+E/Ctrl+Enter, Escape, Espacio, Ctrl+Z, Ctrl+S, R
- [x] Web Workers — simulación en hilo separado con streaming de frames en tiempo real
- [x] GitHub Pages — despliegue automático con .github/workflows/deploy.yml
- [x] Importación STL 2.5D — parser ASCII/Binario, vista en planta con líneas de corte y curvas de nivel
- [x] Rugosidad geológica — ángulo de rugosidad por tramo con rotación estocástica de la normal de contacto
- [x] Fragmentación progresiva por abrasión — esquirlas entre 1× y 3× el umbral con núcleo superviviente; ruptura total sobre 3×
- [x] Generador de terreno aleatorio — perfiles aleatorios listos para simular
- [x] Dashboard de resultados — panel de resumen con métricas de la simulación

---

## 🚧 EN CURSO

- **F0 cerrando (base web)** — pruebas headless, unificación de la física del Worker, límites derivados del terreno, correcciones de reposo/fricción/penetración.
- **F1 (escritorio Electron) y F2 (DEM e importadores) — iniciadas** en paralelo.

---

## 📋 POR HACER

### Prioridad ALTA (funcionalidad profesional)

- [ ] **Unidades configurables** - Cambiar entre metros y pies
- [ ] **Decisión G7: criterio de reposo en pendientes (slopeFactor)** - La definición de "en reposo" depende de la pendiente (`slopeFactor` en `js/physics.js:_checkResting`); definir y documentar el estándar del proyecto.
- [ ] **Revisar visualización de trayectorias al terminar la simulación** - Con el timeline activo en el cuadro 1 no se ven trayectorias; revisar qué se dibuja al finalizar.

### Prioridad MEDIA (mejoras de trabajo)

- [ ] **Comparación de escenarios** - Ejecutar dos simulaciones lado a lado
- [ ] **Reporte PDF** - Generar reporte profesional con gráficos y perfil
- [ ] **Barra de escala gráfica** - Escala visual tipo barra en el canvas
- [ ] **Norte/orientación** - Indicador de dirección del perfil

### Prioridad BAJA (nice to have)

- [ ] **Modo 3D básico** - Vista isométrica del perfil
- [ ] **Sonido de impacto** - Feedback auditativo opcional
- [ ] **PWA** - Instalar como app en móvil/tablet
- [ ] **Tutorial interactivo** - Guía paso a paso para primer uso

### Performance

- [ ] **Spatial hashing** - Optimizar detección de colisiones con muchos puntos
- [ ] **Canvas offscreen** - Renderizado en segundo plano

### Deploy

- [ ] **Docker** - Contenedor para despliegue en servidor
- [ ] **Traducción EN/ES** - Selector de idioma

---

## 🐛 BUGS CONOCIDOS

- ~~**Física del Worker divergente**~~ — **CORREGIDO en F0**: `js/worker.js` ya no tiene física propia; carga `terrain.js`/`physics.js`/`simulation.js` con `importScripts` y ejecuta la misma clase `Simulation` (paridad exacta en `tests/worker.parity.test.js`).
- ~~**Rocas que no alcanzan el reposo (lumped-mass y rigid-body)**~~ — **CORREGIDO en F0**: el contador `_restCheckCount` ya no se reinicia en los impactos; el reposo ahora incluye |ω| y contacto sostenido (`js/physics.js:_checkResting`). Cubierto en `tests/physics.resting.test.js`.
- **Código sin uso** — `js/structural-failure.js` no está cargado en `index.html`; decisión pendiente (cargar o eliminar).

**Fixes aplicados (histórico 25/Abr/2026):**
- Caché de segmento anterior en lookups (O(1) hit rate) → perfiles >50 puntos fluidos
- Validación post-jitter en Simulation.start() → rocas nunca embebidas
- Límite de 200 rocas terminadas dibujadas, Math.max/min seguro → sin saturación visual
- Orden del constructor Rock corregido → computePolygonArea() ya no usa `this.shape` undefined
- Clamping consistente entre rigid-body y nonsmooth → comportamiento uniforme

**Optimizaciones aplicadas:**
- Vertex caching en getShapeVertices() → 1 cálculo en vez de 6-9 por step
- Trayectorias como flat array (x,y,v triplets) → 3× menos objetos, sin allocations en downsampling
- Render throttling con requestAnimationFrame → pan/scroll fluido sin renders duplicados
- In-place compaction en step() → sin filter() allocations por frame
- Color strings pre-computados → sin template literals en hot loop
- drawTerrain unificado en 1 loop → 50% menos iteraciones
- _hexToRgba cacheado → sin re-parseo por frame

---

## 📝 NOTAS DE DESARROLLO

- Servidor local: `python3 -m http.server 8080` dentro de `rockfall2d-sim/`
- Siempre recargar con Ctrl+Shift+R para evitar caché de JS
- El motor de física usa sub-steps (3 por paso) para estabilidad
- Las rocas usan polígonos convexos aleatorios, no cóncavos
- Sistema de coordenadas: Y crece hacia arriba (como en topografía real)
