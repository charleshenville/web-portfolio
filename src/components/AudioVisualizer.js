import styles from './visualizer.module.css';
import * as THREE from 'three';
import React, { useState } from 'react';
import { useEffect, useRef } from 'react';
import Footer from './Footer';
import ScrollPrompt from './ScrollPrompt';

function AudioVisualizer() {

    const ogHeight = window.innerHeight;
    const ogWidth = window.innerWidth;

    const navigateAndReload = (path) => {
        window.location.href = path;
        window.scrollTo(0, 0);
        window.location.reload();
    };

    // Fibonacci sphere generation
    function fibonacciSphere(samples = 1000, radius = 10, randomOffset = 0.1) {
        const points = [];
        const phi = Math.PI * (Math.sqrt(5) - 1); // golden angle in radians

        for (let i = 0; i < samples; i++) {
            let y = 1 - (i / (samples - 1)) * 2; // y goes from 1 to -1
            const r = Math.sqrt(1 - y * y); // radius at y

            const theta = phi * i; // golden angle increment

            let x = Math.cos(theta) * r;
            let z = Math.sin(theta) * r;

            // Apply random offset
            x += (Math.random() - 0.5) * randomOffset;
            y += (Math.random() - 0.5) * randomOffset;
            z += (Math.random() - 0.5) * randomOffset;

            // Scale by radius
            points.push({
                x: x * radius,
                y: y * radius,
                z: z * radius
            });
        }

        return points;
    }

    let scene = new THREE.Scene();
    let camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    let renderer = new THREE.WebGLRenderer({
        canvas: document.querySelector('#bg'),
        antialias: true
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.position.setZ(30);

    // Create sphere points
    const sphereConfig = {
        samples: 10000,
        radius: 12,
        randomOffset: 0.05,
        pointSize: 0.05
    };

    const pointsData = fibonacciSphere(
        sphereConfig.samples,
        sphereConfig.radius,
        sphereConfig.randomOffset
    );

    // Create individual point meshes for full control
    const pointMeshes = [];
    const pointGeometry = new THREE.SphereGeometry(sphereConfig.pointSize, 8, 8);

    pointsData.forEach((point, index) => {
        // Create unique material for each point (allows individual color control)
        let r = Math.abs(point.x) ** 3 + Math.abs(point.y) ** 3 + Math.abs(point.z) ** 3;
        r = r ** 0.3333333;

        // Max would be radius + randomOffset/2 and min would be radius - randomOffset/2
        const hue = (r - (sphereConfig.radius - sphereConfig.randomOffset / 2)) / sphereConfig.randomOffset / 50;
        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(hue , 0.7, 0.5)
        });

        const mesh = new THREE.Mesh(pointGeometry, material);
        mesh.position.set(point.x, point.y, point.z);

        // Store original position for animations
        mesh.userData = {
            originalPosition: { x: point.x, y: point.y, z: point.z },
            index: index
        };

        pointMeshes.push(mesh);
        scene.add(mesh);
    });

    // Orbit controls (simplified implementation)
    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };
    let rotation = { x: 0, y: 0 };

    const canvas = document.querySelector('#bg');

    canvas.addEventListener('mousedown', (e) => {
        isDragging = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const deltaX = e.clientX - previousMousePosition.x;
            const deltaY = e.clientY - previousMousePosition.y;

            rotation.y += deltaX * 0.005;
            rotation.x += deltaY * 0.005;

            previousMousePosition = { x: e.clientX, y: e.clientY };
        }
    });

    canvas.addEventListener('mouseup', () => {
        isDragging = false;
    });

    canvas.addEventListener('mouseleave', () => {
        isDragging = false;
    });

    // Zoom with mouse wheel
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        camera.position.z += e.deltaY * 0.01;
        camera.position.z = Math.max(10, Math.min(100, camera.position.z));
    });

    // Animation function with point control
    function Animate() {
        renderer.render(scene, camera);

        const time = Date.now() * 0.001;

        // Rotate entire point cloud
        pointMeshes.forEach((mesh, index) => {
            const originalPos = mesh.userData.originalPosition;

            // Apply rotation from orbit controls
            const rotatedX = originalPos.x * Math.cos(rotation.y) - originalPos.z * Math.sin(rotation.y);
            const rotatedZ = originalPos.x * Math.sin(rotation.y) + originalPos.z * Math.cos(rotation.y);
            const rotatedY = originalPos.y * Math.cos(rotation.x) - rotatedZ * Math.sin(rotation.x);
            const finalZ = originalPos.y * Math.sin(rotation.x) + rotatedZ * Math.cos(rotation.x);

            mesh.position.set(rotatedX, rotatedY, finalZ);

            // Example animation: wave effect
            // const wave = Math.sin(time + index * 0.01) * 0.5;
            // mesh.position.y += wave;

            // Example color animation
            // const hue = (index / pointMeshes.length + time * 0.1) % 1;
            // mesh.material.color.setHSL(hue, 0.7, 0.5);
        });

        // Auto-rotation (optional, can be removed)
        rotation.y += 0.001;

        requestAnimationFrame(Animate);
    }

    function ScrollAudioVisualizer() {

    }

    window.addEventListener('resize', onWindowResize);
    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        ScrollAudioVisualizer();
    }

    const observe = styles.observe

    const observer = useRef(null);
    useEffect(() => {
        observer.current = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add(observe);
                    entry.target.style.opacity = '1';
                    entry.target.style.transition = 'opacity 1s ease-out';
                } else {
                    entry.target.classList.remove(observe);
                    entry.target.style.opacity = '0';
                }
            });
        });

        const elementsCollection = document.getElementsByClassName(observe);
        const elements = Array.from(elementsCollection);
        elements.forEach((element) => {
            observer.current.observe(element);
        });

        return () => {
            observer.current.disconnect();
        };
    }, []);

    document.body.onscroll = ScrollAudioVisualizer;

    return (
        <div>
            <Animate />
            <header className={styles.header}>
                <div className={styles.gridContainer}>
                    <div className={styles.mainGrid}>
                    </div>
                </div>
                <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }} className={observe}>
                    <Footer />
                </div>
            </header>
        </div>
    );
}

export default AudioVisualizer;