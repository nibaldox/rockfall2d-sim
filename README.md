# SimRocas 2D

Simulador de caída de rocas en 2D. Aplicación web gratuita y open-source para análisis de trayectorias, evaluación de alcance probabilístico y diseño de medidas de protección.

## Demo en vivo

**👉 https://nibaldox.github.io/rockfall2d-sim**

## Cómo ejecutar localmente

```bash
cd rockfall2d-sim
python3 -m http.server 8080
```

Abrir: `http://localhost:8080`

## Pruebas

```bash
node --test tests/
```

Pruebas headless con el runner nativo `node:test` (requiere Node >= 20). Sin dependencias: los scripts se cargan en un contexto `vm` de Node y ejercitan la física sin navegador.

## Cambios del motor (versión F0, oct-2026)

> **⚠️ Advertencia:** Los alcances y energías calculados con versiones anteriores **no son comparables** con esta versión. Recalcule los escenarios antes de extraer conclusiones.

Correcciones de física (todas verificadas en `js/physics.js`):

- **Reposo alcanzable**: el contador de comprobaciones de reposo ya no se reinicia, por lo que el estado de reposo ahora se alcanza en todos los métodos de cálculo (`_checkResting`, sin reinicio de `_restCheckCount` en los casos de colisión).
- **Criterio de reposo con |ω|**: la velocidad angular absoluta participa del criterio (`|ω| < 0.5`), evitando rocas "detenidas" que siguen girando (`physics.js`, `_checkResting`).
- **Fricción de Nonsmooth**: se corrigió el signo del impulso de fricción — antes la fricción agregaba energía en lugar de disiparla.
- **Corrección de posición energéticamente neutra** (`Rock._penetrationCorrection`): la penetración se resuelve sin fugar energía por posicionamiento; antes se fijaba el centro a 1 cm del suelo.
- **Contacto sostenido en Lumped Mass (tipo RocFall "minimum velocity")**: cuando la velocidad normal es baja (|vn| < 0.5 m/s, `Rock.slideVelocityThreshold`), el contacto se trata como deslizamiento/rodadura y no como impulso de impacto en cada sub-paso. El contacto se evalúa con el cuerpo de la roca (centro − radio), no con el punto de masa.
- **Acoplamiento de rodadura en Lumped Mass**: la velocidad angular sí se actualiza por contacto (solo visual; la dinámica sigue siendo de masa puntual) — ya NO es "sin rotación".
- **Fricción de rodadura con contacto real** (`applyRollingFriction`): solo actúa cuando hay contacto efectivo con el terreno; antes frenaba rocas en el aire.
- **Culling derivado del terreno** (`Terrain.getBounds()`): los límites de terminación ya no son fijos; se derivan del perfil actual con margen (típicamente X: ±50 m de los extremos, Y: −100 m por debajo).
- **Masa de formas no esféricas** (polígono, elipse, bloque): área del polígono × espesor equivalente 4r/3 (`Rock.equivalentThickness`), de modo que una roca circular pesa lo mismo que la esfera del mismo diámetro. Antes el espesor era 0,5r y la energía cinética de estas formas quedaba unas 2,7 veces por debajo de lo correcto (5,7 veces frente a la esfera).
- **massLossRatio** es ahora una fracción de masa (0–1), de uso directo para la conservación en fragmentación.

Fragmentación (`_fragmentRockProgressive`):

- La masa se **conserva** salvo el polvo (fragmentos < 0.05 m), que se descarta.
- La disipación de fractura configurada se aplica **exactamente solo a los fragmentos principales en ruptura** — en abrasión, las esquirlas tienen dispersión aleatoria ±30 % en su velocidad de eyección.

## Funcionalidades

### Editor de terreno
- Agregar puntos con clic izquierdo
- Eliminar puntos con clic derecho
- Perfiles precargados (ladera 200m, talud simple, canal en V, acantilado)
- Guardar/cargar perfiles JSON y CSV
- Copiar/pegar coordenadas desde Excel (formato tabular X↹Y)
- Zoom con scroll del mouse
- Pan con botón central o Shift+clic
- Botón "Reset Vista" para ajustar automáticamente
- Editor de segmentos: asignar material (roca, suelo, vegetación, relleno, concreto, asfalto) por tramo y calibrar su rugosidad geológica
- **Topografía 3D (STL)**: Importar archivos STL (ASCII y Binario) con proyección interactiva en planta 2D. Permite trazar planos de sección transversal y generar perfiles 2D optimizados de exactamente N puntos (envolvente de altura máxima y suavizado por interpolación lineal).

### Motor de física

Tres métodos de cálculo:

| Método | Descripción | Referencia |
|--------|-------------|------------|
| **Cuerpos Rígidos** (default) | Colisión poligonal con impulso, torque y momento de inercia | Leine et al. (2013) |
| **Lumped Mass (2DLM)** | Masa puntual con Kn/Kt, contacto sostenido (deslizamiento/rodadura) y acoplamiento de rodadura visual | GeoRock, CRSP |
| **Nonsmooth Dynamics** | Contacto duro, ley de impacto Poisson, cono de fricción Coulomb | Moreau (1988) |

Características del motor:
- Colisiones poligonales reales: cada roca es un polígono convexo irregular (5-9 vértices)
- Detección de impacto por vértice más profundo
- Cálculo de velocidad del punto de contacto: `v_c = v_cm + ω × r`
- Impulso normal con restitución Cn
- Impulso tangencial con fricción Ct
- Torque real: impactos asimétricos generan rotación
- Momento de inercia calculado por forma poligonal
- Dos modelos de fricción de rodadura: simple y Davis & McInnes (1991)
- Dos modelos de disipación de energía: impulso clásico y energy ratio
- Variabilidad Monte Carlo en coeficientes de restitución
- 3 sub-steps por timestep para estabilidad numérica
- **Rugosidad Geológica Estocástica (tipo CRSP)**: Permite asignar a cada tramo del talud un ángulo de rugosidad en grados ($\theta_r$, de $0^\circ$ a $30^\circ$). Al colisionar, el vector normal de contacto se rota estocásticamente de forma acotada por $\pm\theta_r$. La normal real se mantiene pura en cálculos estáticos para evitar vibraciones artificiales de rocas en reposo.
- **Fragmentación Progresiva por Abrasión**: Al ocurrir impactos de alta energía normal ($E_{k,n} > E_{crit}$), la energía de impacto se compara con el umbral de fractura y el bloque responde según su intensidad:
  - **Abrasión ($1\times$–$3\times$ el umbral)**: se desprenden $1$–$3$ esquirlas pequeñas (5%–15% de la masa del padre cada una, con tope acumulado de 40%) y el **núcleo sobrevive**, apenas reducido, continuando su trayectoria de rebotes.
  - **Ruptura ($> 3\times$ el umbral)**: el núcleo se rompe en $2$ fragmentos principales (40%–60% de la masa remanente cada uno) más esquirlas menores.
  - La masa se conserva estrictamente salvo el polvo (los fragmentos menores a $0.05\text{ m}$ se descartan): las velocidades de salida se escalan para cumplir la disipación de fractura configurada. En **ruptura**, esa disipación configurada se aplica con exactitud solo a los fragmentos principales; en **abrasión**, las esquirlas tienen una dispersión aleatoria de ±30 % en su velocidad de eyección.
  - Protección contra explosión de memoria: máximo $3$ generaciones y diámetro mínimo de $0.10\text{ m}$.

### Modos de liberación
- **Caída libre**: la roca se suelta desde una altura definida por el usuario
- **Desprendimiento**: la roca inicia sobre la superficie del terreno y cae por gravedad

### Múltiples puntos de liberación
- Activar/desactivar con checkbox
- Agregar puntos con coordenadas, velocidad y ángulo independientes
- Las rocas se distribuyen equitativamente entre todos los orígenes
- Marcadores visuales (diamantes rojos) sobre el canvas

### Barreras de contención
- Segmentos de línea con coeficientes Cn/Ct propios
- Colisión física real: la roca rebota al impactar la barrera
- Interfaz para agregar, eliminar y configurar cada barrera
- Renderizado visual en rojo con etiquetas

### Formas de roca
- **Polígono irregular** (default): 5-9 vértices aleatorios
- **Esfera**: polígono regular de 24 lados
- **Elipse**: forma ovalada con relación de aspecto configurable
- **Bloque**: forma rectangular

### Mapa de probabilidad
- Bandas de probabilidad de alcance: P10, P50, P83, P95
- Líneas punteadas con etiquetas y distancias
- Zonas coloreadas desde el punto de liberación hasta cada percentil
- Se calcula automáticamente al finalizar la simulación

### Timeline y playback
- Grabación de frames durante la simulación
- Barra de timeline para reproducir la simulación cuadro a cuadro
- Controles: reproducir, pausar, saltar a cuadro específico

### Resultados y estadísticas
- Energía cinética máxima/media (kJ)
- Altura máxima de rebote
- Distancia de runout máxima
- Velocidad máxima de impacto
- Cantidad de rebotes
- Percentiles P50, P83, P95
- Ángulo de energía de Savigny (H/L)
- Histograma de distribución de energía
- Zonas de impacto (>50% energía)
- Estadísticas completas con min, media, max, desviación estándar

### Exportar
- Captura PNG del canvas
- Datos CSV con estadísticas completas
- Reporte de texto formateado
- Perfil de terreno como JSON o CSV

### Web Worker
- Opcional: ejecutar simulación en hilo separado
- Evita congelar la interfaz en simulaciones pesadas (+500 rocas)
- Streaming de frames para visualización en tiempo real
- **Paridad exacta con el hilo principal**: el Worker (`js/worker.js`) no tiene física propia; carga `terrain.js`, `physics.js` y `simulation.js` con `importScripts` y ejecuta la misma clase `Simulation` (verificado en `tests/worker.parity.test.js`)
- Cache-busting en dos niveles: `js/app-worker.js` abre el Worker con `js/worker.js?v=WORKER_VERSION`, y el Worker propaga ese `?v` a cada `importScripts`; al editar `terrain.js`, `physics.js` o `simulation.js` hay que subir `WORKER_VERSION` (en `js/app-worker.js`) y el `?v=` de los `<script>` de `index.html`

### Atajos de teclado

| Atajo | Acción |
|-------|--------|
| Ctrl+E / Ctrl+Enter | Ejecutar simulación |
| Escape | Detener simulación |
| Espacio | Pausar/Reanudar |
| Ctrl+Z | Deshacer último punto del terreno |
| Ctrl+S | Guardar perfil JSON |
| R | Reset simulación |

## Arquitectura

```
rockfall2d-sim/
├── index.html              # Estructura y UI (controles en español)
├── css/
│   └── style.css           # Tema oscuro con CSS variables
├── js/
│   ├── terrain.js          # Perfil topográfico (polilínea 2D, materiales por segmento, rugosidad, getBounds())
│   ├── stl.js              # Parser de mallas STL 3D (ASCII/Binario) y algoritmo de corte 2.5D
│   ├── physics.js          # Motor de física (Rock + PhysicsEngine, 3 métodos, fragmentación, rugosidad, culling derivado del terreno)
│   ├── simulation.js       # Controlador de simulación (bucle dinámico, lifecycle, frames variable)
│   ├── renderer.js         # Render Canvas 2D (terreno, rocas, barreras, mapa prob., árboles de trayectoria)
│   ├── stats.js            # Estadísticas, percentiles, exportación CSV/texto
│   ├── worker.js           # Web Worker: SIN física propia — importScripts de terrain/physics/simulation y ejecuta Simulation
│   ├── app.js              # Aplicación principal (UI, eventos, wiring, timeline variable)
│   ├── app-stl.js          # Mixin de App: importación STL y curvas (Object.assign sobre SimRocas.App.prototype)
│   └── app-worker.js       # Mixin de App: ejecución en Worker (WORKER_VERSION + cache-busting ?v)
├── tests/
│   ├── helpers/
│   │   └── load.js                 # Cargador de scripts para Node (contexto vm)
│   └── physics.roughness.test.js
│       # (~50 pruebas headless: energía, reposo, pendiente, fragmentación, límites,
│       #  namespace, paridad worker, split de app — listadas en tests/*.test.js)
└── .github/
    └── workflows/
        └── deploy.yml      # GitHub Pages auto-deploy
```

## Fórmulas de física

```
Momento de inercia:    I = (ρ/24) × Σ(r₁² + r₁·r₂ + r₂²)(r₁ × r₂)
Velocidad contacto:    v_c = v_cm + ω × r_contacto
Impulso normal:        j = -(1+cn)(v·n) / (1/m + (r×n)²/I)
Impulso fricción:      j_t = (1-ct)(v·t) / (1/m + (r×t)²/I)
Δv = j × n / m
Δω = (r × j) / I

Perturbación de normales (Rugosidad):
  φ = random(-1, 1) × θ_r × (π / 180)
  rn_x = n_x cos φ - n_y sin φ
  rn_y = n_x sin φ + n_y cos φ  (se valida que rn_y > 0)

Conservación de energía en fragmentación:
  E_target = E_reflected × (1 - β_dissipation)
  S_scale = sqrt( E_target / Σ( 0.5 × m_hijo_i × v_hijo_base_i² ) )
  v_hijo_i = S_scale × v_hijo_base_i
```

## Parámetros por defecto

| Parámetro | Valor | Unidad |
|-----------|-------|--------|
| Gravedad | 9.81 | m/s² |
| Paso de tiempo | 0.005 | s |
| Cn (Cuerpos Rígidos) | 0.6 | — |
| Ct (Cuerpos Rígidos) | 0.4 | — |
| Kn (Lumped Mass) | 0.35 | — |
| Kt (Lumped Mass) | 0.75 | — |
| Fricción rodadura | 0.15 | — |
| Diámetro roca | 0.5 | m |
| Densidad roca | 2700 | kg/m³ |
| Duración máxima | 30 | s |
| Sub-steps | 3 | — |

## Sin dependencias

100% vanilla JavaScript + HTML Canvas. Funciona en cualquier navegador moderno. Sin npm, sin bundler, sin framework.

## Referencias técnicas

- Hungr & Evans (2004) "Rockfall analysis and modelling"
- Corominas (2000) "Use of runout models"
- Davis & McInnes (1991) "Rolling resistance of spheres"
- Savigny (1983) "Rockfall prediction by the angle of reach"
- Leine et al. (2013) "Simulation of rockfall trajectories with consideration of rock shape"
- Moreau (1988) "Numerical analysis of the unilateral contact problem"
- Pierson et al. (2000) "Colorado Rockfall Simulation Program (CRSP)"

## Licencia

MIT — Libre uso para profesionales, educación e investigación.
