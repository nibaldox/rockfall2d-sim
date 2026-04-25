# TODO - RockFall 2D Simulator

**Última actualización:** 25/Abr/2026

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

---

## 📋 POR HACER

### Prioridad ALTA (funcionalidad profesional)

- [ ] **Múltiples puntos de liberación** - Permitir definir varios puntos de origen
- [ ] **Mapa de probabilidad** - Contorno de probabilidad de llegada (P10, P50, P83, P95) dibujado sobre el perfil
- [ ] **Barreras y estructuras de contención** - Objetos en el perfil que detengan/absorban rocas
- [ ] **Unidades configurables** - Cambiar entre metros y pies

### Prioridad MEDIA (mejoras de trabajo)

- [ ] **Comparación de escenarios** - Ejecutar dos simulaciones lado a lado
- [ ] **Reporte PDF** - Generar reporte profesional con gráficos y perfil
- [ ] **Barra de escala gráfica** - Escala visual tipo barra en el canvas
- [ ] **Norte/orientación** - Indicador de dirección del perfil
- [ ] **Copiar/pegar coordenadas** - Desde Excel directamente
- [ ] **Atajos de teclado** - Ctrl+E ejecutar, Ctrl+Z deshacer punto, Espacio pausar

### Prioridad BAJA (nice to have)

- [ ] **Modo 3D básico** - Vista isométrica del perfil
- [ ] **Sonido de impacto** - Feedback auditativo opcional
- [ ] **PWA** - Instalar como app en móvil/tablet
- [ ] **Tutorial interactivo** - Guía paso a paso para primer uso

### Performance

- [ ] **Web Workers** - Mover simulación a hilo separado para no bloquear UI
- [ ] **Spatial hashing** - Optimizar detección de colisiones con muchos puntos
- [ ] **Canvas offscreen** - Renderizado en segundo plano

### Deploy

- [ ] **GitHub Pages** - Publicar versión gratuita online
- [ ] **Docker** - Contenedor para despliegue en servidor
- [ ] **Traducción EN/ES** - Selector de idioma

---

## 🐛 BUGS CONOCIDOS

_Todos los bugs conocidos han sido corregidos en la revisión del 25/Abr/2026._

**Fixes aplicados:**
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
