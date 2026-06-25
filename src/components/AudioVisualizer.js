import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SlidersHorizontal, X } from 'lucide-react';
import styles from './visualizer.module.css';

// Available assets
const ASSETS = [
    { id: 'sphere', name: 'Default Sphere', path: null },
    { id: 'point_cloud', name: 'Point Cloud', path: 'assets/point_cloud.ply' },
    { id: 'pepper', name: 'Pepper', path: 'assets/pepper.ply' },
    { id: 'fairview_4a', name: 'Fairview 4A', path: 'assets/fairview_4a.ply' },
    { id: 'fairview_2b', name: 'Fairview 2B', path: 'assets/fairview_2b.ply' },
    { id: 'snow', name: 'Snow', path: 'assets/snow.ply' },
];

// Available music tracks
const MUSIC_ASSETS = [
    { id: 'test', name: 'Test Track', path: 'assets/test.mp3' },
    // Add more tracks here: { id: 'unique_id', name: 'Display Name', path: 'assets/filename.mp3' },
];

// Default values for every menu-configurable parameter.
const DEFAULT_PARAMS = {
    // Geometry (changing these rebuilds the point cloud)
    samples: 30000,
    radius: 8,
    jitter: 0.01,
    pointSize: 0.005,
    maxPoints: 150000,
    // Audio reactivity (live)
    reactivity: 0.5,
    scatter: 0.002,
    originX: 0,
    originY: 0,
    originZ: 0,
    // Post processing (live)
    bloomStrength: 0.5,
    bloomRadius: 0.6,
    bloomThreshold: 0.5,
    haze: 0.7,
    // Navigation (live)
    moveSpeed: 20,
    damping: 0.08,
};

// Menu layout: grouped sliders. `point` marks parameters tied to a location in space.
const PARAM_GROUPS = [
    {
        title: 'Geometry',
        params: [
            { key: 'samples', label: 'Points', min: 1000, max: 150000, step: 1000, sphereOnly: true },
            { key: 'radius', label: 'Radius', min: 1, max: 20, step: 0.1, sphereOnly: true },
            { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.001, sphereOnly: true },
            { key: 'pointSize', label: 'Dot Size', min: 0.001, max: 0.05, step: 0.001 },
            { key: 'maxPoints', label: 'Max Dots', min: 1000, max: 150000, step: 1000 },
        ],
    },
    {
        title: 'Audio Reactivity',
        params: [
            { key: 'reactivity', label: 'Reactivity', min: 0, max: 3, step: 0.01 },
            { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.001 },
            { key: 'originX', label: 'Pulse X', min: -20, max: 20, step: 0.1, point: 'pulse' },
            { key: 'originY', label: 'Pulse Y', min: -20, max: 20, step: 0.1, point: 'pulse' },
            { key: 'originZ', label: 'Pulse Z', min: -20, max: 20, step: 0.1, point: 'pulse' },
        ],
    },
    {
        title: 'Post FX',
        params: [
            { key: 'bloomStrength', label: 'Glow', min: 0, max: 3, step: 0.01 },
            { key: 'bloomRadius', label: 'Glow Spread', min: 0, max: 2, step: 0.01 },
            { key: 'bloomThreshold', label: 'Glow Floor', min: 0, max: 1, step: 0.01 },
            { key: 'haze', label: 'Haze', min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        title: 'Navigation',
        params: [
            { key: 'moveSpeed', label: 'Fly Speed', min: 0, max: 100, step: 1 },
            { key: 'damping', label: 'Damping', min: 0, max: 0.3, step: 0.01 },
        ],
    },
];

// Custom dream-like haze shader
const DreamHazeShader = {
    uniforms: {
        tDiffuse: { value: null },
        time: { value: 0 },
        intensity: { value: 0.5 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float intensity;
        varying vec2 vUv;
        
        void main() {
            vec2 uv = vUv;
            
            // Soft glow effect
            vec4 color = texture2D(tDiffuse, uv);
            
            // Subtle chromatic aberration for dream-like quality
            float offset = 0.002 * intensity;
            vec4 r = texture2D(tDiffuse, uv + vec2(offset, 0.0));
            vec4 b = texture2D(tDiffuse, uv - vec2(offset, 0.0));
            color.r = mix(color.r, r.r, 0.3);
            color.b = mix(color.b, b.b, 0.3);
            
            // Subtle color shift for dreamy atmosphere
            color.rgb *= vec3(1.05, 0.98, 1.1);
            
            gl_FragColor = color;
        }
    `
};

// Text field that lets you type freely (decimals, minus sign) while still
// staying in sync with its slider. Commits only valid numbers.
function NumberField({ value, min, max, step, disabled, onCommit }) {
    const [text, setText] = useState(String(value));
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!focused) setText(String(value));
    }, [value, focused]);

    return (
        <input
            className={styles.av_num}
            type="number"
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); setText(String(value)); }}
            onChange={(e) => {
                setText(e.target.value);
                const n = parseFloat(e.target.value);
                if (!Number.isNaN(n)) onCommit(n);
            }}
        />
    );
}

function getR(x, y, z) {
    const r = Math.abs(x) ** 2 + Math.abs(y) ** 2 + Math.abs(z) ** 2;
    return r ** 0.5;
}

// Fibonacci sphere generation
function fibonacciSphere(samples = 1000, radius = 10, randomOffset = 0.1) {
    const points = [];
    const phi = Math.PI * (Math.sqrt(5) - 1);

    for (let i = 0; i < samples; i++) {
        let y = 1 - (i / (samples - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = phi * i;

        let x = Math.cos(theta) * r;
        let z = Math.sin(theta) * r;

        x += (Math.random() - 0.5) * randomOffset;
        y += (Math.random() - 0.5) * randomOffset;
        z += (Math.random() - 0.5) * randomOffset;

        points.push({ x: x * radius, y: y * radius, z: z * radius });
    }

    return points;
}

function AudioVisualizer() {
    const [isPlaying, setIsPlaying] = useState(false);
    const [selectedAsset, setSelectedAsset] = useState('fairview_4a');
    const [isLoading, setIsLoading] = useState(false);
    const [selectedMusic, setSelectedMusic] = useState('test');
    const [params, setParams] = useState(DEFAULT_PARAMS);
    const [menuOpen, setMenuOpen] = useState(false);
    const [showHelpers, setShowHelpers] = useState(false);
    const [cursorActive, setCursorActive] = useState(true);

    const audioRef = useRef(null);
    const canvasRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const sceneRef = useRef(null);
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const composerRef = useRef(null);
    const controlsRef = useRef(null);
    const bloomPassRef = useRef(null);
    const dreamHazePassRef = useRef(null);
    const pointsObjectRef = useRef(null);
    const pointsDataRef = useRef([]);
    const rawPointsRef = useRef(null); // cached PLY points so rebuilds don't re-fetch
    const animationFrameRef = useRef(null);

    // Spatial helpers
    const axesHelperRef = useRef(null);
    const pulseMarkerRef = useRef(null);
    const targetMarkerRef = useRef(null);

    // Navigation
    const keysRef = useRef({});
    const desiredTargetRef = useRef(null);

    // Mirrors of state for the animation loop / event handlers (avoids stale closures)
    const paramsRef = useRef(params);
    const selectedAssetRef = useRef(selectedAsset);
    const showHelpersRef = useRef(showHelpers);

    const hideTimerRef = useRef(null);

    // ---- Point cloud building -------------------------------------------------

    const clearPoints = useCallback(() => {
        if (pointsObjectRef.current && sceneRef.current) {
            sceneRef.current.remove(pointsObjectRef.current);
            if (pointsObjectRef.current.geometry) pointsObjectRef.current.geometry.dispose();
            if (pointsObjectRef.current.material) pointsObjectRef.current.material.dispose();
            pointsObjectRef.current = null;
        }
        pointsDataRef.current = [];
    }, []);

    const createPointsObject = useCallback((pointsData, config) => {
        if (!sceneRef.current) return;
        clearPoints();

        const shuffledPoints = pointsData.sort(() => Math.random() - 0.5);
        const limitedPoints = shuffledPoints.slice(0, config.maxPoints);

        const hasOriginalColors = limitedPoints.length > 0 && limitedPoints[0].color;

        const pointGeometry = new THREE.SphereGeometry(config.pointSize * 1.2, 8, 8);
        const pointMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.95
        });

        const instancedMesh = new THREE.InstancedMesh(pointGeometry, pointMaterial, limitedPoints.length);
        const dummy = new THREE.Object3D();
        const colors = new Float32Array(limitedPoints.length * 3);

        limitedPoints.forEach((point, index) => {
            dummy.position.set(point.x, point.y, point.z);
            dummy.updateMatrix();
            instancedMesh.setMatrixAt(index, dummy.matrix);

            let color;
            if (point.color) {
                color = new THREE.Color(point.color.r, point.color.g, point.color.b);
            } else {
                const r = getR(point.x, point.y, point.z);
                const hue = (r - (config.radius - config.jitter / 2)) / config.jitter / 100;
                color = new THREE.Color().setHSL(hue, 0.7, 0.7);
            }

            colors[index * 3] = color.r;
            colors[index * 3 + 1] = color.g;
            colors[index * 3 + 2] = color.b;

            limitedPoints[index] = {
                ...point,
                originalPosition: { x: point.x, y: point.y, z: point.z },
                originalColor: point.color ? { r: color.r, g: color.g, b: color.b } : null,
                index: index
            };
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
        instancedMesh.userData.hasOriginalColors = hasOriginalColors;

        sceneRef.current.add(instancedMesh);
        pointsObjectRef.current = instancedMesh;
        pointsDataRef.current = limitedPoints;
    }, [clearPoints]);

    const loadPLYFile = useCallback((path) => {
        return new Promise((resolve, reject) => {
            const loader = new PLYLoader();
            loader.load(
                path,
                (geometry) => {
                    const positions = geometry.attributes.position;
                    const colors = geometry.attributes.color;
                    const points = [];

                    geometry.computeBoundingBox();
                    const bbox = geometry.boundingBox;
                    const center = new THREE.Vector3();
                    bbox.getCenter(center);
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const maxDim = Math.max(size.x, size.y, size.z);
                    const scale = 24 / maxDim;

                    for (let i = 0; i < positions.count; i++) {
                        const point = {
                            x: (positions.getX(i) - center.x) * scale,
                            y: (positions.getY(i) - center.y) * scale,
                            z: (positions.getZ(i) - center.z) * scale
                        };
                        if (colors) {
                            point.color = {
                                r: colors.getX(i),
                                g: colors.getY(i),
                                b: colors.getZ(i)
                            };
                        }
                        points.push(point);
                    }
                    resolve(points);
                },
                undefined,
                (error) => reject(error)
            );
        });
    }, []);

    // Rebuild the point object from cached/regenerated raw data (no re-fetch).
    const buildPoints = useCallback((asset) => {
        if (!sceneRef.current || !asset) return;
        const cfg = paramsRef.current;
        let raw;
        if (asset.path === null) {
            raw = fibonacciSphere(cfg.samples, cfg.radius, cfg.jitter);
        } else {
            if (!rawPointsRef.current) return;
            raw = rawPointsRef.current.map((p) => ({ ...p }));
        }
        createPointsObject(raw, cfg);
    }, [createPointsObject]);

    const loadAsset = useCallback(async (assetId) => {
        const asset = ASSETS.find((a) => a.id === assetId);
        if (!asset) return;
        setIsLoading(true);
        try {
            if (asset.path === null) {
                rawPointsRef.current = null;
            } else {
                rawPointsRef.current = await loadPLYFile(asset.path);
            }
            buildPoints(asset);
        } catch (error) {
            console.error('Failed to load asset:', error);
        } finally {
            setIsLoading(false);
        }
    }, [loadPLYFile, buildPoints]);

    const rebuildPoints = useCallback(() => {
        const asset = ASSETS.find((a) => a.id === selectedAssetRef.current);
        buildPoints(asset);
    }, [buildPoints]);

    // ---- Scene initialization (runs once) ------------------------------------

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.position.set(0, 0, 30);

        sceneRef.current = scene;
        cameraRef.current = camera;
        rendererRef.current = renderer;

        // Orbit controls (rotate / zoom / pan around a target)
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = paramsRef.current.damping;
        controls.minDistance = 2;
        controls.maxDistance = 200;
        controls.target.set(0, 0, 0);
        controlsRef.current = controls;

        // Post-processing
        const composer = new EffectComposer(renderer);
        composer.setPixelRatio(window.devicePixelRatio);
        composer.setSize(window.innerWidth, window.innerHeight);

        composer.addPass(new RenderPass(scene, camera));

        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            paramsRef.current.bloomStrength,
            paramsRef.current.bloomRadius,
            paramsRef.current.bloomThreshold
        );
        composer.addPass(bloomPass);

        const dreamHazePass = new ShaderPass(DreamHazeShader);
        dreamHazePass.uniforms.intensity.value = paramsRef.current.haze;
        composer.addPass(dreamHazePass);

        composerRef.current = composer;
        bloomPassRef.current = bloomPass;
        dreamHazePassRef.current = dreamHazePass;

        // Spatial helpers (hidden until toggled)
        const axes = new THREE.AxesHelper(6);
        axes.visible = false;
        scene.add(axes);
        axesHelperRef.current = axes;

        const pulseMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.35, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xd4d4d4, wireframe: true })
        );
        pulseMarker.visible = false;
        scene.add(pulseMarker);
        pulseMarkerRef.current = pulseMarker;

        const targetMarker = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.5, 0.5),
            new THREE.MeshBasicMaterial({ color: 0xd4d4d4, wireframe: true })
        );
        targetMarker.visible = false;
        scene.add(targetMarker);
        targetMarkerRef.current = targetMarker;

        // Click (not drag) to set a new orbit focus point.
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const pointerDown = { x: 0, y: 0, t: 0 };

        const onPointerDown = (e) => {
            pointerDown.x = e.clientX;
            pointerDown.y = e.clientY;
            pointerDown.t = Date.now();
        };

        const onPointerUp = (e) => {
            const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
            const elapsed = Date.now() - pointerDown.t;
            if (moved > 5 || elapsed > 300) return; // it was a drag, not a click

            const rect = canvas.getBoundingClientRect();
            ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, camera);

            let focus = null;
            if (pointsObjectRef.current) {
                const hits = raycaster.intersectObject(pointsObjectRef.current, false);
                if (hits.length > 0) focus = hits[0].point.clone();
            }
            if (!focus) {
                // Fallback: point along the ray at the current orbit distance.
                const dist = camera.position.distanceTo(controls.target);
                focus = raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(dist));
            }
            desiredTargetRef.current = focus;
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);

        // Keyboard fly controls (WASD + space / shift)
        const onKeyDown = (e) => {
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            keysRef.current[e.code] = true;
            if (e.code === 'Space') e.preventDefault();
        };
        const onKeyUp = (e) => { keysRef.current[e.code] = false; };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(window.innerWidth, window.innerHeight);
            composer.setPixelRatio(window.devicePixelRatio);
            composer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        // Animation loop
        const dummy = new THREE.Object3D();
        const clock = new THREE.Clock();
        const forward = new THREE.Vector3();
        const right = new THREE.Vector3();
        const move = new THREE.Vector3();

        const animate = () => {
            const time = Date.now() * 0.001;
            const dt = clock.getDelta();
            const cfg = paramsRef.current;

            // --- Keyboard fly movement ---
            const keys = keysRef.current;
            const moving = keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD ||
                keys.Space || keys.ShiftLeft || keys.ShiftRight;
            if (moving) {
                camera.getWorldDirection(forward);
                forward.normalize();
                right.crossVectors(forward, camera.up).normalize();
                move.set(0, 0, 0);
                if (keys.KeyW) move.add(forward);
                if (keys.KeyS) move.sub(forward);
                if (keys.KeyD) move.add(right);
                if (keys.KeyA) move.sub(right);
                if (keys.Space) move.add(camera.up);
                if (keys.ShiftLeft || keys.ShiftRight) move.sub(camera.up);
                if (move.lengthSq() > 0) {
                    move.normalize().multiplyScalar(cfg.moveSpeed * dt);
                    camera.position.add(move);
                    controls.target.add(move);
                    desiredTargetRef.current = null; // cancel focus glide on manual move
                }
            }

            // --- Glide toward a clicked focus point ---
            if (desiredTargetRef.current) {
                controls.target.lerp(desiredTargetRef.current, 0.12);
                if (controls.target.distanceTo(desiredTargetRef.current) < 0.01) {
                    desiredTargetRef.current = null;
                }
            }

            controls.update();

            // --- Audio data ---
            let frequencyData = null;
            if (analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);
                frequencyData = dataArrayRef.current;
            }

            const instancedMesh = pointsObjectRef.current;
            const pointsData = pointsDataRef.current;

            if (instancedMesh && pointsData.length > 0) {
                const colors = instancedMesh.instanceColor ? instancedMesh.instanceColor.array : null;
                const hasOriginalColors = instancedMesh.userData.hasOriginalColors;
                const ox = cfg.originX, oy = cfg.originY, oz = cfg.originZ;

                pointsData.forEach((point, index) => {
                    const o = point.originalPosition;
                    let fx = o.x, fy = o.y, fz = o.z;

                    if (frequencyData) {
                        const freqIndex = Math.floor((Math.abs(pointsData.length / 2 - index) / pointsData.length / 16) * frequencyData.length);
                        const frequency = frequencyData[freqIndex] / 255;
                        const randomFactor = 0.5 + (Math.random() - 0.5) * cfg.scatter;
                        const scale = 1 + cfg.reactivity * (frequency * randomFactor);

                        const dx = o.x - ox, dy = o.y - oy, dz = o.z - oz;
                        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        if (dist > 0) {
                            fx = ox + dx * scale;
                            fy = oy + dy * scale;
                            fz = oz + dz * scale;
                        }

                        if (colors && !hasOriginalColors) {
                            const r = getR(fx, fy, fz);
                            const hue = (r - (cfg.radius - cfg.jitter / 2)) / cfg.jitter / 100;
                            const pointColor = new THREE.Color().setHSL(hue, 0.7, 0.6);
                            colors[index * 3] = pointColor.r;
                            colors[index * 3 + 1] = pointColor.g;
                            colors[index * 3 + 2] = pointColor.b;
                        }
                    }

                    dummy.position.set(fx, fy, fz);
                    dummy.updateMatrix();
                    instancedMesh.setMatrixAt(index, dummy.matrix);
                });

                instancedMesh.instanceMatrix.needsUpdate = true;
                if (instancedMesh.instanceColor && !hasOriginalColors) {
                    instancedMesh.instanceColor.needsUpdate = true;
                }
            }

            // --- Helper markers ---
            if (showHelpersRef.current) {
                if (pulseMarkerRef.current) pulseMarkerRef.current.position.set(cfg.originX, cfg.originY, cfg.originZ);
                if (targetMarkerRef.current) targetMarkerRef.current.position.copy(controls.target);
            }

            if (dreamHazePassRef.current) {
                dreamHazePassRef.current.uniforms.time.value = time;
            }
            if (composerRef.current) composerRef.current.render();

            animationFrameRef.current = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('resize', handleResize);
            controls.dispose();
            clearPoints();
        };
    }, [clearPoints]);

    // Load asset whenever the selection changes.
    useEffect(() => {
        selectedAssetRef.current = selectedAsset;
        if (sceneRef.current) loadAsset(selectedAsset);
    }, [selectedAsset, loadAsset]);

    // Push live params to three.js objects + keep the loop's ref in sync.
    useEffect(() => {
        paramsRef.current = params;
        if (bloomPassRef.current) {
            bloomPassRef.current.strength = params.bloomStrength;
            bloomPassRef.current.radius = params.bloomRadius;
            bloomPassRef.current.threshold = params.bloomThreshold;
        }
        if (dreamHazePassRef.current) dreamHazePassRef.current.uniforms.intensity.value = params.haze;
        if (controlsRef.current) controlsRef.current.dampingFactor = params.damping;
    }, [params]);

    // Rebuild the point cloud (debounced) when geometry params change.
    useEffect(() => {
        if (!sceneRef.current) return;
        const t = setTimeout(() => rebuildPoints(), 140);
        return () => clearTimeout(t);
    }, [params.samples, params.radius, params.jitter, params.pointSize, params.maxPoints, rebuildPoints]);

    // Toggle helper visibility.
    useEffect(() => {
        showHelpersRef.current = showHelpers;
        if (axesHelperRef.current) axesHelperRef.current.visible = showHelpers;
        if (pulseMarkerRef.current) pulseMarkerRef.current.visible = showHelpers;
        if (targetMarkerRef.current) targetMarkerRef.current.visible = showHelpers;
    }, [showHelpers]);

    // Reveal the menu toggle on cursor movement; hide after inactivity.
    useEffect(() => {
        const onMove = () => {
            setCursorActive(true);
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = setTimeout(() => setCursorActive(false), 2500);
        };
        window.addEventListener('mousemove', onMove);
        hideTimerRef.current = setTimeout(() => setCursorActive(false), 2500);
        return () => {
            window.removeEventListener('mousemove', onMove);
            clearTimeout(hideTimerRef.current);
        };
    }, []);

    // ---- Audio ---------------------------------------------------------------

    const initAudio = () => {
        if (!audioRef.current || analyserRef.current) return;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        const source = audioContext.createMediaElementSource(audioRef.current);
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        analyserRef.current = analyser;
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    };

    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            if (!analyserRef.current) initAudio();
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    const handleMusicSelect = (musicId) => {
        const wasPlaying = isPlaying;
        if (audioRef.current && isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        }
        setSelectedMusic(musicId);
        analyserRef.current = null;
        dataArrayRef.current = null;
        if (wasPlaying) {
            setTimeout(() => {
                if (audioRef.current) {
                    initAudio();
                    audioRef.current.play();
                    setIsPlaying(true);
                }
            }, 100);
        }
    };

    // ---- Param handling ------------------------------------------------------

    const updateParam = (key, value) => {
        if (Number.isNaN(value)) return;
        setParams((prev) => ({ ...prev, [key]: value }));
    };

    const resetParams = () => setParams(DEFAULT_PARAMS);

    const selectedMusicPath = MUSIC_ASSETS.find((m) => m.id === selectedMusic)?.path || 'assets/test.mp3';
    const currentAsset = ASSETS.find((a) => a.id === selectedAsset);
    const isSphere = currentAsset?.path === null;

    const renderRow = (def) => {
        const disabled = def.sphereOnly && !isSphere;
        const value = params[def.key];
        return (
            <div className={styles.av_row} key={def.key} style={disabled ? { opacity: 0.35 } : undefined}>
                <span className={styles.av_label} title={def.label}>
                    {def.point ? `◇ ${def.label}` : def.label}
                </span>
                <input
                    className={styles.av_slider}
                    type="range"
                    min={def.min}
                    max={def.max}
                    step={def.step}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => updateParam(def.key, parseFloat(e.target.value))}
                />
                <NumberField
                    value={value}
                    min={def.min}
                    max={def.max}
                    step={def.step}
                    disabled={disabled}
                    onCommit={(n) => updateParam(def.key, n)}
                />
            </div>
        );
    };

    return (
        <div className={styles.av} style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000', position: 'relative' }}>
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    touchAction: 'none',
                    cursor: 'grab',
                    zIndex: 2
                }}
            />

            <audio
                ref={audioRef}
                src={selectedMusicPath}
                onEnded={() => setIsPlaying(false)}
                style={{ display: 'none' }}
            />

            {isLoading && <div className={styles.av_loading}>Loading</div>}

            {/* Menu reveal button (auto-hides when the cursor is idle) */}
            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    className={`${styles.av_toggle} ${cursorActive ? styles.av_visible : styles.av_hidden}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {/* Control panel */}
            {menuOpen && (
                <div className={styles.av_panel}>
                    <div className={styles.av_head}>
                        <span className={styles.av_title}>Visualizer</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.av_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Playback */}
                    <div className={styles.av_section}>
                        <div className={styles.av_sectionTitle}>Playback</div>
                        <div className={styles.av_playRow}>
                            <button
                                type="button"
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                className={styles.av_iconBtn}
                                onClick={togglePlay}
                                style={{ width: 34, height: 34, flex: '0 0 auto' }}
                            >
                                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <select
                                className={styles.av_select}
                                value={selectedMusic}
                                onChange={(e) => handleMusicSelect(e.target.value)}
                            >
                                {MUSIC_ASSETS.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Scene */}
                    <div className={styles.av_section}>
                        <div className={styles.av_sectionTitle}>Scene</div>
                        <select
                            className={styles.av_select}
                            value={selectedAsset}
                            onChange={(e) => setSelectedAsset(e.target.value)}
                            style={{ marginBottom: 10 }}
                        >
                            {ASSETS.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                        </select>
                        <div
                            className={styles.av_checkRow}
                            onClick={() => setShowHelpers((v) => !v)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') setShowHelpers((v) => !v); }}
                        >
                            <span>Show Helpers</span>
                            <span className={`${styles.av_switch} ${showHelpers ? styles.av_switchOn : ''}`}>
                                <span className={styles.av_knob} />
                            </span>
                        </div>
                    </div>

                    {/* Parameter groups */}
                    {PARAM_GROUPS.map((group) => (
                        <div className={styles.av_section} key={group.title}>
                            <div className={styles.av_sectionTitle}>{group.title}</div>
                            {group.params.map(renderRow)}
                        </div>
                    ))}

                    {/* Footer */}
                    <div className={styles.av_section} style={{ borderBottom: 'none' }}>
                        <button
                            type="button"
                            className={styles.av_select}
                            onClick={resetParams}
                            style={{ textAlign: 'center', cursor: 'pointer' }}
                        >
                            Reset Defaults
                        </button>
                        <div className={styles.av_hint} style={{ marginTop: 10 }}>
                            Drag to orbit · Scroll to zoom · Click a point to refocus<br />
                            WASD to fly · Space / Shift up &amp; down · ◇ = point in space
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default AudioVisualizer;
