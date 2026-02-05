import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, ChevronDown } from 'lucide-react';

// Maximum number of points to render (for performance)
const MAX_POINTS = 50000;

// Available assets
const ASSETS = [
    { id: 'sphere', name: 'Default Sphere', path: null },
    { id: 'point_cloud', name: 'Point Cloud', path: 'assets/point_cloud.ply' },
    { id: 'snow', name: 'Snow', path: 'assets/snow.ply' },
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
            
            // Soft haze/bloom effect
            // float dist = distance(uv, vec2(0.5));
            // float haze = smoothstep(0.0, 0.8, dist) * 0.3 * intensity;
            // color.rgb = mix(color.rgb, vec3(0.8, 0.7, 1.0), haze);
            
            // Subtle color shift for dreamy atmosphere
            color.rgb *= vec3(1.05, 0.98, 1.1);
            
            gl_FragColor = color;
        }
    `
};

function AudioVisualizer() {
    const [isPlaying, setIsPlaying] = useState(false);
    const [selectedAsset, setSelectedAsset] = useState('sphere');
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const audioRef = useRef(null);
    const canvasRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const sceneRef = useRef(null);
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const composerRef = useRef(null);
    const dreamHazePassRef = useRef(null);
    const pointsObjectRef = useRef(null); // Single points object
    const pointsDataRef = useRef([]); // Store points data for animation
    const rotationRef = useRef({ x: 0, y: 0 });
    const isDraggingRef = useRef(false);
    const previousMousePositionRef = useRef({ x: 0, y: 0 });
    const animationFrameRef = useRef(null);
    const sphereConfigRef = useRef({
        samples: 10000,
        radius: 12,
        randomOffset: 0.1,
        pointSize: 0.05
    });

    function getR(x,y,z) {
        // let r = Math.abs(x) ** 3 + Math.abs(y) ** 3 + Math.abs(z) ** 3;
        // return r ** 0.3333333;

        let r = Math.abs(x) ** 2 + Math.abs(y) ** 2 + Math.abs(z) ** 2;
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

            points.push({
                x: x * radius,
                y: y * radius,
                z: z * radius
            });
        }

        return points;
    }

    // Clear existing points from scene
    const clearPoints = useCallback(() => {
        if (pointsObjectRef.current && sceneRef.current) {
            sceneRef.current.remove(pointsObjectRef.current);
            if (pointsObjectRef.current.geometry) {
                pointsObjectRef.current.geometry.dispose();
            }
            if (pointsObjectRef.current.material) {
                pointsObjectRef.current.material.dispose();
            }
            pointsObjectRef.current = null;
        }
        pointsDataRef.current = [];
    }, []);

    // Create points object using InstancedMesh for efficient single draw call
    const createPointsObject = useCallback((pointsData, config) => {
        if (!sceneRef.current) return;

        // Clear existing points first
        clearPoints();

        // Limit points to MAX_POINTS
        const limitedPoints = pointsData.slice(0, MAX_POINTS);
        
        // Check if points have original colors from PLY
        const hasOriginalColors = limitedPoints.length > 0 && limitedPoints[0].color;
        
        const pointGeometry = new THREE.SphereGeometry(config.pointSize * 1.2, 8, 8);
        const pointMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.95
        });

        // Use InstancedMesh for single draw call
        const instancedMesh = new THREE.InstancedMesh(pointGeometry, pointMaterial, limitedPoints.length);
        const dummy = new THREE.Object3D();
        const colors = new Float32Array(limitedPoints.length * 3);

        limitedPoints.forEach((point, index) => {
            dummy.position.set(point.x, point.y, point.z);
            dummy.updateMatrix();
            instancedMesh.setMatrixAt(index, dummy.matrix);

            let color;
            if (point.color) {
                // Use original PLY color
                color = new THREE.Color(point.color.r, point.color.g, point.color.b);
            } else {
                // Calculate color based on radius (for generated sphere)
                const r = getR(point.x, point.y, point.z);
                const hue = (r - (config.radius - config.randomOffset / 2)) / config.randomOffset / 100;
                color = new THREE.Color().setHSL(hue, 0.7, 0.7);
            }
            
            colors[index * 3] = color.r;
            colors[index * 3 + 1] = color.g;
            colors[index * 3 + 2] = color.b;

            // Store original position and color info in pointsData
            limitedPoints[index] = {
                ...point,
                originalPosition: { x: point.x, y: point.y, z: point.z },
                originalColor: point.color ? { r: color.r, g: color.g, b: color.b } : null,
                index: index
            };
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        
        // Store instance colors as attribute
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
        
        // Store whether this mesh has original colors (to skip color animation)
        instancedMesh.userData.hasOriginalColors = hasOriginalColors;
        
        sceneRef.current.add(instancedMesh);
        pointsObjectRef.current = instancedMesh;
        pointsDataRef.current = limitedPoints;

        console.log(`Created ${limitedPoints.length} points (limited from ${pointsData.length}), original colors: ${hasOriginalColors}`);
    }, [clearPoints]);

    // Load PLY file and return points data with colors
    const loadPLYFile = useCallback((path) => {
        return new Promise((resolve, reject) => {
            const loader = new PLYLoader();
            loader.load(
                path,
                (geometry) => {
                    const positions = geometry.attributes.position;
                    const colors = geometry.attributes.color; // PLY color attribute
                    const points = [];
                    
                    // Calculate bounding box to normalize/scale
                    geometry.computeBoundingBox();
                    const bbox = geometry.boundingBox;
                    const center = new THREE.Vector3();
                    bbox.getCenter(center);
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const maxDim = Math.max(size.x, size.y, size.z);
                    const scale = 24 / maxDim; // Scale to fit roughly in view

                    for (let i = 0; i < positions.count; i++) {
                        const point = {
                            x: (positions.getX(i) - center.x) * scale,
                            y: (positions.getY(i) - center.y) * scale,
                            z: (positions.getZ(i) - center.z) * scale
                        };
                        
                        // Include original color if available
                        if (colors) {
                            point.color = {
                                r: colors.getX(i),
                                g: colors.getY(i),
                                b: colors.getZ(i)
                            };
                        }
                        
                        points.push(point);
                    }
                    
                    console.log(`Loaded PLY with ${points.length} points, colors: ${colors ? 'yes' : 'no'}`);
                    resolve(points);
                },
                (progress) => {
                    console.log('Loading PLY:', (progress.loaded / progress.total * 100).toFixed(1) + '%');
                },
                (error) => {
                    console.error('Error loading PLY:', error);
                    reject(error);
                }
            );
        });
    }, []);

    // Load and create points for selected asset
    const loadAsset = useCallback(async (assetId) => {
        const asset = ASSETS.find(a => a.id === assetId);
        if (!asset) return;

        setIsLoading(true);

        try {
            let pointsData;
            const config = sphereConfigRef.current;

            if (asset.path === null) {
                // Generate fibonacci sphere
                pointsData = fibonacciSphere(config.samples, config.radius, config.randomOffset);
            } else {
                // Load PLY file
                pointsData = await loadPLYFile(asset.path);
            }

            createPointsObject(pointsData, config);
        } catch (error) {
            console.error('Failed to load asset:', error);
        } finally {
            setIsLoading(false);
        }
    }, [createPointsObject, loadPLYFile]);

    // Initialize Three.js scene (runs once)
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            console.log("Canvas not found!");
            return;
        }
        console.log("Canvas found, initializing...");

        // Initialize Three.js
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true
        });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.position.setZ(30);

        sceneRef.current = scene;
        cameraRef.current = camera;
        rendererRef.current = renderer;

        // Set up post-processing pipeline
        const composer = new EffectComposer(renderer);
        composer.setPixelRatio(window.devicePixelRatio);
        composer.setSize(window.innerWidth, window.innerHeight);

        // Render pass - renders the scene
        const renderPass = new RenderPass(scene, camera);
        composer.addPass(renderPass);

        // Bloom pass for dream-like glow
        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            2.0,  // strength - increased for better glow
            0.6,  // radius - increased for more spread
            0.5   // threshold - lowered to capture more of the glowing points
        );
        composer.addPass(bloomPass);

        // Custom dream haze pass
        const dreamHazePass = new ShaderPass(DreamHazeShader);
        dreamHazePass.uniforms.intensity.value = 0.6;
        composer.addPass(dreamHazePass);

        composerRef.current = composer;
        dreamHazePassRef.current = dreamHazePass;

        // Mouse controls
        const handleMouseDown = (e) => {
            e.preventDefault();
            isDraggingRef.current = true;
            previousMousePositionRef.current = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
        };

        const handleMouseMove = (e) => {
            if (isDraggingRef.current) {
                const deltaX = e.clientX - previousMousePositionRef.current.x;
                const deltaY = e.clientY - previousMousePositionRef.current.y;

                rotationRef.current.y += deltaX * 0.005;
                rotationRef.current.x += deltaY * 0.005;

                previousMousePositionRef.current = { x: e.clientX, y: e.clientY };
            }
        };

        const handleMouseUp = () => {
            isDraggingRef.current = false;
            canvas.style.cursor = 'grab';
        };

        const handleWheel = (e) => {
            e.preventDefault();
            camera.position.z += e.deltaY * 0.01;
            camera.position.z = Math.max(10, Math.min(100, camera.position.z));
        };

        canvas.addEventListener('mousedown', handleMouseDown);
        canvas.addEventListener('mousemove', handleMouseMove);
        canvas.addEventListener('mouseup', handleMouseUp);
        canvas.addEventListener('mouseleave', handleMouseUp);
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        
        console.log("Event listeners attached to canvas");

        // Window resize
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
        const config = sphereConfigRef.current;

        const animate = () => {
            const time = Date.now() * 0.001;
            const rotation = rotationRef.current;

            // Get frequency data if available
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

                pointsData.forEach((point, index) => {
                    const originalPos = point.originalPosition;

                    // Apply rotation from orbit controls
                    const rotatedX = originalPos.x * Math.cos(rotation.y) - originalPos.z * Math.sin(rotation.y);
                    const rotatedZ = originalPos.x * Math.sin(rotation.y) + originalPos.z * Math.cos(rotation.y);
                    const rotatedY = originalPos.y * Math.cos(rotation.x) - rotatedZ * Math.sin(rotation.x);
                    const finalZ = originalPos.y * Math.sin(rotation.x) + rotatedZ * Math.cos(rotation.x);

                    let finalX = rotatedX;
                    let finalY = rotatedY;
                    let finalZPos = finalZ;

                    // Audio-reactive animation
                    if (frequencyData) {
                        // Map point index to frequency bin
                        const freqIndex = Math.floor((Math.abs(pointsData.length / 2 - index) / pointsData.length / 16) * frequencyData.length);
                        const frequency = frequencyData[freqIndex] / 255; // Normalize to 0-1

                        // Scale points based on frequency
                        const randomFactor = (Math.random() - 0.5) * 0.2;
                        const scale = 1 + frequency * (0.5 + randomFactor);
                        const distance = Math.sqrt(rotatedX * rotatedX + rotatedY * rotatedY + finalZ * finalZ);
                        
                        if (distance > 0) {
                            const normalizedX = rotatedX / distance;
                            const normalizedY = rotatedY / distance;
                            const normalizedZ = finalZ / distance;

                            finalX = normalizedX * distance * scale;
                            finalY = normalizedY * distance * scale;
                            finalZPos = normalizedZ * distance * scale;
                        }

                        // Color animation based on radius - only for generated points (not PLY with colors)
                        if (colors && !hasOriginalColors) {
                            const r = getR(finalX, finalY, finalZPos);
                            const hue = (r - (config.radius - config.randomOffset / 2)) / config.randomOffset / 100;
                            const pointColor = new THREE.Color().setHSL(hue, 0.7, 0.6);
                            colors[index * 3] = pointColor.r;
                            colors[index * 3 + 1] = pointColor.g;
                            colors[index * 3 + 2] = pointColor.b;
                        }
                    }

                    // Update instance matrix
                    dummy.position.set(finalX, finalY, finalZPos);
                    dummy.updateMatrix();
                    instancedMesh.setMatrixAt(index, dummy.matrix);
                });

                instancedMesh.instanceMatrix.needsUpdate = true;
                if (instancedMesh.instanceColor && !hasOriginalColors) {
                    instancedMesh.instanceColor.needsUpdate = true;
                }
            }

            // Auto-rotation
            rotationRef.current.y += 0.001;

            // Update dream haze shader time for subtle animation
            if (dreamHazePassRef.current) {
                dreamHazePassRef.current.uniforms.time.value = time;
            }

            // Render with post-processing
            if (composerRef.current) {
                composerRef.current.render();
            }

            animationFrameRef.current = requestAnimationFrame(animate);
        };

        animate();

        // Cleanup
        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            canvas.removeEventListener('mousedown', handleMouseDown);
            canvas.removeEventListener('mousemove', handleMouseMove);
            canvas.removeEventListener('mouseup', handleMouseUp);
            canvas.removeEventListener('mouseleave', handleMouseUp);
            canvas.removeEventListener('wheel', handleWheel);
            window.removeEventListener('resize', handleResize);

            clearPoints();
        };
    }, [clearPoints]);

    // Load asset when selectedAsset changes
    useEffect(() => {
        if (sceneRef.current) {
            loadAsset(selectedAsset);
        }
    }, [selectedAsset, loadAsset]);

    // Initialize audio context and analyser
    const initAudio = () => {
        if (!audioRef.current || analyserRef.current) return;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;

        const source = audioContext.createMediaElementSource(audioRef.current);
        source.connect(analyser);
        analyser.connect(audioContext.destination);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        analyserRef.current = analyser;
        dataArrayRef.current = dataArray;
    };

    const togglePlay = () => {
        if (!audioRef.current) return;

        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            if (!analyserRef.current) {
                initAudio();
            }
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    const handleAssetSelect = (assetId) => {
        setSelectedAsset(assetId);
        setIsDropdownOpen(false);
    };

    const selectedAssetName = ASSETS.find(a => a.id === selectedAsset)?.name || 'Select Asset';

    return (
        <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000000', position: 'relative' }}>
            <canvas ref={canvasRef} style={{ 
                display: 'block', 
                position: 'absolute', 
                top: 0, 
                left: 0, 
                width: '100%', 
                height: '100%',
                touchAction: 'none',
                cursor: 'grab',
                zIndex: 2
            }} />
            
            {/* Audio element - hidden */}
            <audio
                ref={audioRef}
                src="assets/test.mp3"
                onEnded={() => setIsPlaying(false)}
                style={{ display: 'none' }}
            />

            {/* Loading indicator */}
            {isLoading && (
                <div style={{
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    color: 'white',
                    fontSize: '18px',
                    zIndex: 1001,
                    background: 'rgba(0, 0, 0, 0.7)',
                    padding: '20px 40px',
                    borderRadius: '10px',
                    backdropFilter: 'blur(10px)'
                }}>
                    Loading...
                </div>
            )}

            {/* Asset selector dropdown */}
            <div style={{
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                zIndex: 1000
            }}>
                <button
                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                    style={{
                        padding: '12px 20px',
                        borderRadius: '30px',
                        border: 'none',
                        background: 'rgba(255, 255, 255, 0.1)',
                        backdropFilter: 'blur(10px)',
                        color: 'white',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        transition: 'all 0.3s ease',
                        minWidth: '150px',
                        justifyContent: 'space-between'
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                    }}
                >
                    <span>{selectedAssetName}</span>
                    <ChevronDown 
                        size={18} 
                        style={{ 
                            transform: isDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.3s ease'
                        }} 
                    />
                </button>

                {isDropdownOpen && (
                    <div style={{
                        position: 'absolute',
                        bottom: '100%',
                        right: 0,
                        marginBottom: '8px',
                        background: 'rgba(30, 30, 30, 0.95)',
                        backdropFilter: 'blur(10px)',
                        borderRadius: '12px',
                        overflow: 'hidden',
                        minWidth: '150px',
                        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)'
                    }}>
                        {ASSETS.map((asset) => (
                            <button
                                key={asset.id}
                                onClick={() => handleAssetSelect(asset.id)}
                                style={{
                                    display: 'block',
                                    width: '100%',
                                    padding: '12px 20px',
                                    border: 'none',
                                    background: selectedAsset === asset.id 
                                        ? 'rgba(255, 255, 255, 0.15)' 
                                        : 'transparent',
                                    color: 'white',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                    fontSize: '14px',
                                    transition: 'background 0.2s ease'
                                }}
                                onMouseEnter={(e) => {
                                    if (selectedAsset !== asset.id) {
                                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (selectedAsset !== asset.id) {
                                        e.currentTarget.style.background = 'transparent';
                                    }
                                }}
                            >
                                {asset.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Play/Pause button */}
            <button
                onClick={togglePlay}
                style={{
                    position: 'fixed',
                    bottom: '20px',
                    left: '20px',
                    width: '60px',
                    height: '60px',
                    borderRadius: '50%',
                    border: 'none',
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(10px)',
                    color: 'white',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.3s ease',
                    zIndex: 1000
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                    e.currentTarget.style.transform = 'scale(1.1)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                    e.currentTarget.style.transform = 'scale(1)';
                }}
            >
                {isPlaying ? <Pause size={28} /> : <Play size={28} />}
            </button>
        </div>
    );
}

export default AudioVisualizer;