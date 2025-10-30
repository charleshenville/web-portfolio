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

    let scene = new THREE.Scene();
    let camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    let renderer = new THREE.WebGLRenderer({
        canvas: document.querySelector('#bg'),
    })
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.position.setZ(30);

    const materials = new THREE.MeshBasicMaterial({ color: 0x999999, wireframe: true });

    const mainTorusGeometry = new THREE.TorusGeometry(12, 11, 24, 100);
    const torus = new THREE.Mesh(mainTorusGeometry, materials);
    let torusX = 0.01 * window.innerWidth;

    torus.rotation.x = 1.7;
    torus.rotation.y = 1.1;
    torus.rotation.z = 0.5;

    torus.position.x = torusX;
    scene.add(torus);


    function Animate() {
        renderer.render(scene, camera);
        torus.rotation.x += 0.00065;
        torus.rotation.y += 0.000125;
        torus.rotation.z += 0.0004;

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
                    // Element is intersecting with the viewport
                    entry.target.classList.add(observe);
                    entry.target.style.opacity = '1';
                    entry.target.style.transition = 'opacity 1s ease-out';

                }
                else {
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

        // Cleanup the observer when the component unmounts
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
