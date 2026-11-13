globalThis.SimRocas = globalThis.SimRocas || {};
/**
 * Puente ES → clásico para Three.js vendido.
 *
 * Este es el ÚNICO módulo ES de la app (los demás scripts son clásicos).
 * Expone el namespace completo de Three.js más OrbitControls en
 * globalThis.THREE para que los scripts clásicos lo consuman en tiempo de
 * ejecución, marca SimRocas.threeReady y dispara 'simrocas:three-ready'.
 *
 * Requiere el importmap en la página que lo carga:
 * <script type="importmap">
 * {"imports":{"three":"./vendor/three/three.module.min.js","three/addons/":"./vendor/three/addons/"}}
 * </script>
 * <script type="module" src="js/three-bridge.js"></script>
 */
import * as THREE_NS from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

globalThis.THREE = Object.assign({}, THREE_NS, { OrbitControls });
globalThis.SimRocas.threeReady = true;
globalThis.dispatchEvent(new Event('simrocas:three-ready'));
