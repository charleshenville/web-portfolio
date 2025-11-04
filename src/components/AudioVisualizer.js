import * as THREE from 'three';
import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause } from 'lucide-react';

function AudioVisualizer() {
    const [isPlaying, setIsPlaying] = useState(false);
    const audioRef = useRef(null);
    const canvasRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const sceneRef = useRef(null);
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
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

        // Create sphere points
        const sphereConfig = {
            samples: 5000,
            radius: 10,
            randomOffset: 0.05,
            pointSize: 0.055
        };

        const pointsData = fibonacciSphere(
            sphereConfig.samples,
            sphereConfig.radius,
            sphereConfig.randomOffset
        );

        const pointGeometry = new THREE.SphereGeometry(sphereConfig.pointSize, 8, 8);
        const pointMeshes = [];

        pointsData.forEach((point, index) => {
            const r = getR(point.x, point.y, point.z);

            const hue = (r - (sphereConfig.radius - sphereConfig.randomOffset / 2)) / sphereConfig.randomOffset / 100;
            const material = new THREE.MeshBasicMaterial({
                color: new THREE.Color().setHSL(hue, 0.7, 0.5)
            });

            const mesh = new THREE.Mesh(pointGeometry, material);
            mesh.position.set(point.x, point.y, point.z);

            mesh.userData = {
                originalPosition: { x: point.x, y: point.y, z: point.z },
                index: index,
                baseHue: hue
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
        };

        window.addEventListener('resize', handleResize);

        // Animation loop
        const animate = () => {
            renderer.render(scene, camera);

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
                    mesh.material.color.setHSL(hue, 0.7, 0.5);
                } else {
                    mesh.position.set(rotatedX, rotatedY, finalZ);
                }
            });

            // Auto-rotation
            rotationRef.current.y += 0.001;

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