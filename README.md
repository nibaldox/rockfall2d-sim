# RockFall 2D Simulator

Simulador de caída de rocas en 2D inspirado en ROCKFALL2D. Aplicación web gratuita y open-source para profesionales jóvenes.

## Estado actual: 23/Abr/2026

**Versión:** 1.0 - Funcional y probada

## Cómo ejecutar

```bash
cd rockfall2d-sim
python3 -m http.server 8080
```

Abrir: `http://localhost:8080`

## Funcionalidades implementadas

### Editor de terreno
- Agregar puntos con clic izquierdo
- Eliminar puntos con clic derecho
- Guardar/cargar perfiles JSON
- Zoom con scroll del mouse
- Pan con botón central o Shift+clic
- Botón "Reset Vista" para ajustar automáticamente
- Perfil de ejemplo precargado (ladera 200m)

### Motor de física poligonal
- **Colisiones poligonales reales**: cada roca es un polígono irregular (5-9 vértices)
- Detección de impacto por vértice más profundo
- Cálculo de velocidad del punto de contacto: `v_c = v_cm + ω × r`
- Impulso normal con coeficiente de restitución Cn
- Impulso tangencial con coeficiente Ct (fricción)
- Torque real: impactos asimétricos generan rotación
- Momento de inercia calculado para cada forma poligonal
- Fricción de rodadura
- Condición de reposo por velocidad y pendiente
- Variabilidad Monte Carlo en Cn/Ct

### Parámetros configurables
- Punto de liberación (X, Y)
- Velocidad inicial y ángulo
- Diámetro y densidad de roca
- Coeficientes Cn, Ct, fricción rodadura
- Número de rocas (1-10,000)
- Gravedad
- Variabilidad Cn/Ct (%)
- Paso de tiempo
- Velocidad de animación

### Resultados
- Energía cinética máxima/media (kJ)
- Altura máxima de rebote
- Distancia de runout máxima
- Velocidad máxima de impacto
- Rebotes máximos
- Percentiles P50, P83, P95
- Histograma de distribución de energía
- Zonas de impacto

### Exportar
- Captura PNG del canvas
- Datos CSV con estadísticas
- Reporte de texto completo

## Arquitectura

```
rockfall2d-sim/
├── index.html          # Estructura y UI
├── css/
│   └── style.css       # Estilos tema oscuro profesional
└── js/
    ├── terrain.js      # Perfil topográfico (polilínea 2D)
    ├── physics.js      # Motor de física (Rock + PhysicsEngine)
    ├── simulation.js   # Controlador de simulación (bucle principal)
    ├── renderer.js     # Renderizado Canvas 2D
    ├── stats.js        # Estadísticas y exportación
    └── app.js          # Aplicación principal (conecta todo)
```

## Física implementada

```
Momento de inercia:    I = (ρ/24) × Σ(r₁² + r₁·r₂ + r₂²)(r₁ × r₂)
Velocidad contacto:    v_c = v_cm + ω × r_contacto
Impulso normal:        j = -(1+cn)(v·n) / (1/m + (r×n)²/I)
Impulso fricción:      j_t = (1-ct)(v·t) / (1/m + (r×t)²/I)
Δv = j × n / m
Δω = (r × j) / I
```

## Sin dependencias externas

100% vanilla JavaScript + HTML Canvas. Funciona en cualquier navegador moderno.

## Licencia

MIT - Libre uso para profesionales y educación.
