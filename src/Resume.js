import styles from './resume.module.css';
import React from 'react';
import * as THREE from 'three';
import TechSkills from './TechSkills';
import Languages from './Languages';

function Projects() {

    function Animate() {
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.render(scene, camera);

        requestAnimationFrame(Animate);
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({
        canvas: document.querySelector('#bg'),
    })
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.position.setZ(30);

    return (
        <div>
            <Animate />
            <header className={styles.header}>

                <TechSkills />
                <div className={styles.expBar}>

                    <div style={{ display: 'flex', justifyContent: 'right', textAlign: 'right', padding: '20px' }}><p>Less Capable</p></div>
                    <div className={styles.barContainer}>
                        <div className={styles.bar}></div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'left', textAlign: 'left', padding: '20px' }}><p>More Capable</p></div>

                </div>
                <Languages/>

            </header>

        </div>

    );

}

export default Projects;
