# RockFall 2D Simulator

Simulador de caída de rocas en 2D inspirado en RocFall2. Aplicación web gratuita y open-source para análisis de trayectorias de rockfall, evaluación de alcance probabilístico y diseño de medidas de protección.

## Demo en vivo

**👉 https://nibaldox.github.io/rockfall2d-sim**

## Cómo ejecutar localmente

```bash
cd rockfall2d-sim
python3 -m http.server 8080
```

Abrir: `http://localhost:8080`

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
- Editor de segmentos: asignar material (roca, suelo, vegetación, relleno, concreto, asfalto) por tramo

### Motor de física

Tres métodos de cálculo:

| Método | Descripción | Referencia |
|--------|-------------|------------|
| **Cuerpos Rígidos** (default) | Colisión poligonal con impulso, torque y momento de inercia | Leine et al. (2013) |
| **Lumped Mass (2DLM)** | Masa puntual con Kn/Kt, sin rotación | RocFall2, CRSP, GeoRock |
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
│   ├── terrain.js          # Perfil topográfico (polilínea 2D, materiales por segmento)
│   ├── physics.js          # Motor de física (Rock + PhysicsEngine, 3 métodos)
│   ├── simulation.js       # Controlador de simulación (bucle, lifecycle, frames)
│   ├── renderer.js         # Renderizado Canvas 2D (terreno, rocas, barreras, mapa prob.)
│   ├── stats.js            # Estadísticas, percentiles, exportación CSV/texto
│   ├── worker.js           # Web Worker para simulación en hilo separado
│   └── app.js              # Aplicación principal (UI, eventos, wiring)
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
```

## Parámetros por defecto

| Parámetro | Valor | Unidad |
|-----------|-------|--------|
| Gravedad | 9.81 | m/s² |
| Paso de tiempo | 0.005 | s |
| Cn (Rigid Body) | 0.6 | — |
| Ct (Rigid Body) | 0.4 | — |
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
- Lenoir et al. (2009) "RocFall2 verification manual"
- Leine et al. (2013) "Simulation of rockfall trajectories with consideration of rock shape"
- Moreau (1988) "Numerical analysis of the unilateral contact problem"
- Pierson et al. (2000) "Colorado Rockfall Simulation Program (CRSP)"

## Licencia

MIT — Libre uso para profesionales, educación e investigación.
