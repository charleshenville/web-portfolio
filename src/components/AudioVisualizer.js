import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause } from 'lucide-react';

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
    const audioRef = useRef(null);
    const canvasRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const sceneRef = useRef(null);
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const composerRef = useRef(null);
    const dreamHazePassRef = useRef(null);
    const pointMeshesRef = useRef([]);
    const rotationRef = useRef({ x: 0, y: 0 });
    const isDraggingRef = useRef(false);
    const previousMousePositionRef = useRef({ x: 0, y: 0 });
    const animationFrameRef = useRef(null);

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

        // Create sphere points
        const sphereConfig = {
            samples: 10000,
            radius: 12,
            randomOffset: 0.1,
            pointSize: 0.05
        };

        const pointsData = fibonacciSphere(
            sphereConfig.samples,
            sphereConfig.radius,
            sphereConfig.randomOffset
        );

        const pointGeometry = new THREE.SphereGeometry(sphereConfig.pointSize * 1.2, 8, 8);
        const pointMeshes = [];

        pointsData.forEach((point, index) => {
            const r = getR(point.x, point.y, point.z);

            const hue = (r - (sphereConfig.radius - sphereConfig.randomOffset / 2)) / sphereConfig.randomOffset / 100;
            const pointColor = new THREE.Color().setHSL(hue, 0.7, 0.7); // Brighter base color
            
            // Create emissive material for glowing light effect
            const material = new THREE.MeshBasicMaterial({
                color: pointColor,
                emissive: pointColor.clone().multiplyScalar(2.0), // Bright emissive glow
                emissiveIntensity: 1.5,
                transparent: true,
                opacity: 0.95
            });

            const mesh = new THREE.Mesh(pointGeometry, material);
            mesh.position.set(point.x, point.y, point.z);

            mesh.userData = {
                originalPosition: { x: point.x, y: point.y, z: point.z },
                index: index,
                baseHue: hue,
                baseColor: pointColor.clone()
            };

            pointMeshes.push(mesh);
            scene.add(mesh);
        });

        pointMeshesRef.current = pointMeshes;

        // Mouse controls
        const handleMouseDown = (e) => {
            console.log("Mouse down detected!", e.target);
            e.preventDefault();
            isDraggingRef.current = true;
            previousMousePositionRef.current = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
        };

        const handleMouseMove = (e) => {
            if (isDraggingRef.current) {
                console.log("Dragging...");
                const deltaX = e.clientX - previousMousePositionRef.current.x;
                const deltaY = e.clientY - previousMousePositionRef.current.y;

                rotationRef.current.y += deltaX * 0.005;
                rotationRef.current.x += deltaY * 0.005;

                previousMousePositionRef.current = { x: e.clientX, y: e.clientY };
            }
        };

        const handleMouseUp = () => {
            console.log("Mouse up");
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
        const animate = () => {
            const time = Date.now() * 0.001;
            const rotation = rotationRef.current;

            // Get frequency data if available
            let frequencyData = null;
            if (analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);
                frequencyData = dataArrayRef.current;
            }

            pointMeshes.forEach((mesh, index) => {
                const originalPos = mesh.userData.originalPosition;

                // Apply rotation from orbit controls
                const rotatedX = originalPos.x * Math.cos(rotation.y) - originalPos.z * Math.sin(rotation.y);
                const rotatedZ = originalPos.x * Math.sin(rotation.y) + originalPos.z * Math.cos(rotation.y);
                const rotatedY = originalPos.y * Math.cos(rotation.x) - rotatedZ * Math.sin(rotation.x);
                const finalZ = originalPos.y * Math.sin(rotation.x) + rotatedZ * Math.cos(rotation.x);

                // Audio-reactive animation
                if (frequencyData) {
                    // Map point index to frequency bin
                    const freqIndex = Math.floor((Math.abs(pointMeshes.length / 2 - index) / pointMeshes.length / 16) * frequencyData.length);
                    const frequency = frequencyData[freqIndex] / 255; // Normalize to 0-1

                    // Scale points based on frequency
                    const randomFactor = (Math.random() - 0.5) * 0.2;
                    const scale = 1 + frequency * (0.5 + randomFactor); 
                    // const scale = 1 + frequency * (0.5);
                    const distance = Math.sqrt(rotatedX * rotatedX + rotatedY * rotatedY + finalZ * finalZ);
                    const normalizedX = rotatedX / distance;
                    const normalizedY = rotatedY / distance;
                    const normalizedZ = finalZ / distance;

                    mesh.position.set(
                        normalizedX * distance * scale,
                        normalizedY * distance * scale,
                        normalizedZ * distance * scale
                    );

                    // Color animation based on radius like initialized
                    const r = getR(mesh.position.x, mesh.position.y, mesh.position.z);

                    const hue = (r - (sphereConfig.radius - sphereConfig.randomOffset / 2)) / sphereConfig.randomOffset / 100;
                    const pointColor = new THREE.Color().setHSL(hue, 0.7, 0.6); // Brighter for light source
                    
                    // Update both color and emissive for glowing effect
                    if (mesh.material && mesh.material.color) {
                        mesh.material.color.copy(pointColor);
                    }
                    if (mesh.material && mesh.material.emissive) {
                        mesh.material.emissive.copy(pointColor).multiplyScalar(2);
                    }

                } else {
                    mesh.position.set(rotatedX, rotatedY, finalZ);
                }
            });

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

            pointMeshes.forEach(mesh => {
                mesh.geometry.dispose();
                mesh.material.dispose();
                scene.remove(mesh);
            });
        };
    }, []);

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