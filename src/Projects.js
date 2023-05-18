import styles from './projects.module.css';
import React from 'react';
import ProjectCard from './ProjectCard';
import Spotlight from './Spotlight';

import items from './projectitems.json';
import * as THREE from 'three';

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
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.position.setZ(30);
    renderer.render(scene, camera);

    return (
        <div>
            <Animate/>
            <header className={styles.header}>
                <Spotlight/>
                <ProjectCard items={items}/>
            </header>

        </div>

    );

}

export default Projects;
