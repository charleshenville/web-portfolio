import styles from './home.module.css';
import * as THREE from 'three';
import React, { useState } from 'react';
import { useEffect, useRef } from 'react';
import Footer from './Footer';
import ScrollPrompt from './ScrollPrompt';

function Home() {

    const ogHeight = window.innerHeight;
    const ogWidth = window.innerWidth;

    const fonts = ['SF Mono', 'Helvetica'];

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
    const lines = new THREE.LineBasicMaterial({ color: 0xD9D9D9, linewidth: 2 });

    const mainTorusGeometry = new THREE.TorusGeometry(12, 11, 24, 100);
    const torus = new THREE.Mesh(mainTorusGeometry, materials);
    let torusX = 0.01 * window.innerWidth;

    torus.rotation.x = 1.7;
    torus.rotation.y = 1.1;
    torus.rotation.z = 0.5;

    torus.position.x = torusX;
    scene.add(torus);

    const icosRadius = 15;
    const icosahedronGeometry = new THREE.IcosahedronGeometry(icosRadius);
    const icosahedron = new THREE.Mesh(icosahedronGeometry, materials);
    const icosX = 10;
    let icosY = -0.163 * window.innerHeight;
    const icosZ = -15;
    icosahedron.position.x = icosX;
    icosahedron.position.y = icosY;
    icosahedron.position.z = icosZ;
    scene.add(icosahedron);

    const ddcRadius = 15;
    const dodecahedronGeometry = new THREE.DodecahedronGeometry(ddcRadius);
    const dodecEdges = new THREE.EdgesGeometry(dodecahedronGeometry);
    const dodecahedron = new THREE.LineSegments(dodecEdges, lines);
    let ddcX = -0.23 * window.innerHeight;
    const ddcY = -2;
    const ddcZ = 0;
    dodecahedron.position.x = ddcX;
    dodecahedron.position.y = ddcY;
    dodecahedron.position.z = ddcZ;
    scene.add(dodecahedron);

    let lU = Date.now();

    function Animate() {
        renderer.render(scene, camera);
        torus.rotation.x += 0.00065;
        torus.rotation.y += 0.000125;
        torus.rotation.z += 0.0004;

        icosahedron.rotation.x += 0.001;
        icosahedron.rotation.y += 0.0008;

        dodecahedron.rotation.x += 0.001;
        dodecahedron.rotation.y += 0.0008;

        requestAnimationFrame(Animate);
    }

    function ScrollHome() {

        const toTop = document.body.getBoundingClientRect().top;
        // const toTop = -window.pageYOffset;

        if ((0.05 * toTop + torusX) >= -torusX) {
            torus.position.x = 0.05 * toTop + torusX;
            torus.position.y = 0.01 * toTop;
        }
        else if ((0.07 * toTop + torusX) <= -torusX - 20000 / window.innerWidth - 15) {

            torus.position.x = 0.07 * toTop + torusX + 20000 / window.innerWidth + 15;
        }

        icosahedron.position.y = icosY - 0.07 * toTop;
        dodecahedron.position.x = ddcX - 0.06 * toTop;

    }

    window.addEventListener('resize', onWindowResize);
    function onWindowResize() {

        camera.aspect = window.innerWidth / window.innerHeight;

        console.log(ogWidth)
        console.log(ogHeight)


        torusX = 0.01 * window.innerWidth
        torus.position.x = torusX;
        icosY = -0.163 * window.innerHeight;
        icosahedron.position.y = icosY;
        ddcX = -0.23 * window.innerHeight;
        dodecahedron.position.x = ddcX;


        camera.updateProjectionMatrix();
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        ScrollHome();

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

        const elements = document.querySelectorAll(`.${observe}`);
        elements.forEach((element) => {
            observer.current.observe(element);
        });

        // Cleanup the observer when the component unmounts
        return () => {
            observer.current.disconnect();
        };
    }, []);

    document.body.onscroll = ScrollHome;

    return (
        <div>
            <Animate />
            <header className={styles.header}>
                <div className={styles.gridContainer}>
                    <div className={styles.mainGrid}>

                        <div className={observe}>
                            <h1 className={styles.txt} style={{ fontFamily: fonts[0] }}>
                                CHARLES HENVILLE
                            </h1>
                        </div>

                        <ScrollPrompt/>

                        <div className={styles.aboutContainer}>
                            <img className={styles.bwImage} style={{position:'relative', top:'15px', right:'15px', maxHeight:'50svw', padding: '5%', boxSizing:'border-box'}} alt="my headshot" src="assets/headshot.jpg"/>
                            <div className={observe}>
                                <div className={styles.aboutTxt}>about</div>
                                <div className={styles.aboutSubTxt}>
                                    Hello! I’m Charles, a 20 year-old computer
                                    engineer at the University of Toronto in Canada.
                                    I’m passionate about all things relating to data,
                                    automation, design, and more recently, machine learning.
                                    While I am busy with my studies, I enjoy creating
                                    things that I think are cool and sharing them with
                                    people! See my <a className={styles.projLink} href='/#/projects' onClick={() => navigateAndReload('/#/projects')}>projects</a> to check out what I’ve been
                                    up to!
                                </div>
                            </div>
                        </div>

                        <div className={styles.adjs}>
                            <h1 style={{ margin: '2%' }} className={observe}>I'm a Developer.</h1>
                            <h1 style={{ margin: '2%' }} className={observe}>I'm an Engineer.</h1>
                            <h1 style={{ margin: '2%' }} className={observe}>I'm a Creator.</h1>
                        </div>

                        <div className={styles.directory}>
                            <div className={observe}>
                                <div className={styles.tmt}>
                                    <h1>Take me to...</h1>
                                </div>
                                <div className={styles.tmtContent}>

                                    <a className={styles.projLink2} href='/#/projects' onClick={() => navigateAndReload('/#/projects')}>
                                        <div className={styles.buttonContainer}>
                                            <div className={styles.highlighter}></div>
                                            <div className={styles.buttonText}>Project Spotlight</div>
                                        </div>
                                    </a>
                                    <a className={styles.projLink2} href='/#/resume' onClick={() => navigateAndReload('/#/resume')}>
                                        <div className={styles.buttonContainer}>
                                            <div className={styles.highlighter}></div>
                                            <div className={styles.buttonText}>Skills & Stacks</div>
                                        </div>
                                    </a>
                                    <a className={styles.projLink2} href='/#/resume' onClick={() => navigateAndReload('/#/resume')}>
                                        <div className={styles.buttonContainer}>
                                            <div className={styles.highlighter}></div>
                                            <div className={styles.buttonText}>Career Experience</div>
                                        </div>
                                    </a>
                                    <a className={styles.projLink2} href="https://github.com/charleshenville/web-portfolio" target="_blank">
                                        <div className={styles.buttonContainer}>
                                            <div className={styles.highlighter}></div>
                                            <div className={styles.buttonText}>Page Repository</div>
                                        </div>
                                    </a>
                                    <a className={styles.projLink2} href='/#/contact' onClick={() => navigateAndReload('/#/contact')}>
                                        <div className={styles.buttonContainer}>
                                            <div className={styles.highlighter}></div>
                                            <div className={styles.buttonText}>Contact Information</div>
                                        </div>
                                    </a>
                                </div>
                            </div>
                        </div>



                    </div>
                </div>
                <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }} className={observe}>
                    <Footer />
                </div>
            </header>

        </div>
    );
}

export default Home;
