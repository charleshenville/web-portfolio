import styles from './home.module.css';
import * as THREE from 'three';

function Home() {

    let scene = new THREE.Scene();
    let camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    let renderer = new THREE.WebGLRenderer({
        canvas: document.querySelector('#bg'),
    })
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.position.setZ(30);

    const materials = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, wireframe: true });
    const lines = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });

    const mainTorusGeometry = new THREE.TorusGeometry(12, 7, 10, 50);
    const torus = new THREE.Mesh(mainTorusGeometry, materials);
    const torusX = 18;

    scene.add(torus);
    torus.position.x = torusX;

    const icosRadius = 15;
    const icosahedronGeometry = new THREE.IcosahedronGeometry(icosRadius);
    const icosahedron = new THREE.Mesh(icosahedronGeometry, materials);
    const icosX = 150;
    const icosY = -10;
    const icosZ = -40;
    icosahedron.position.x = icosX;
    icosahedron.position.y = icosY;
    icosahedron.position.z = icosZ;
    scene.add(icosahedron);

    const ddcRadius = 15;
    const dodecahedronGeometry = new THREE.DodecahedronGeometry(ddcRadius);
    const dodecEdges = new THREE.EdgesGeometry(dodecahedronGeometry);
    const dodecahedron = new THREE.LineSegments(dodecEdges, lines);
    const ddcX = -150;
    const ddcY = -10;
    const ddcZ = 0;
    dodecahedron.position.x = ddcX;
    dodecahedron.position.y = ddcY;
    dodecahedron.position.z = ddcZ;
    scene.add(dodecahedron);

    function Animate() {
        renderer.render(scene, camera);
        torus.rotation.x += 0.001;
        torus.rotation.y += 0.0005;
        torus.rotation.z += 0.00025;

        icosahedron.rotation.x += 0.001;
        icosahedron.rotation.y += 0.0008;

        dodecahedron.rotation.x += 0.001;
        dodecahedron.rotation.y += 0.0008;

        requestAnimationFrame(Animate);
    }

    function ScrollHome() {

        const toTop = document.body.getBoundingClientRect().top;

        if ((0.05 * toTop + torusX) >= -torusX) {
            torus.position.x = 0.05 * toTop + torusX;
            torus.position.y = 0.01 * toTop;
        }
        else if ((0.05 * toTop + torusX) <= -torusX - 19) {
            torus.position.x = 0.05 * toTop + torusX + 19;
        }

        if (1.15 * (icosX / 1250) * toTop + 2 * icosX <= 11.5) {
            icosahedron.position.y = icosY + 0.6 * (11.5 - (1.15 * (icosX / 1250) * toTop + 2 * icosX));
        }
        else if (toTop < -1250) {
            icosahedron.position.x = 1.15 * (icosX / 1250) * toTop + 2 * icosX;

            if ((icosZ / 1250) * toTop < -2 * icosZ) {
                icosahedron.position.z = (icosZ / 1250) * toTop + 2 * icosZ;
            }
        }

        if (1.11 * (ddcX / 1700) * toTop + 2 * ddcX >= 0) {
            dodecahedron.position.y = ddcY + 0.6 * (- (1.11 * (-ddcX / 1700) * toTop - 2 * ddcX));
        }
        else if (toTop < -1700) {
            dodecahedron.position.x = 1.11 * (ddcX / 1700) * toTop + 2 * ddcX;
        }

    }

    window.addEventListener('resize', onWindowResize);
    function onWindowResize() {

        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);

    }


    document.body.onscroll = ScrollHome;

    return (
        <div>
            <Animate />
            <header className={styles.header}>
                <div className={styles.gridContainer}>
                    <div className={styles.mainGrid}>
                        <h1 className={styles.txt}>CHARLES HENVILLE</h1>
                        <h1 className={styles.aboutTxt}>ABOUT</h1>
                        <p className={styles.aboutSubTxt}>
                            Hi viewer! I’m Charles Miguel, an 18-year-old computer
                            engineer at the University of Toronto in Canada.
                            I’m passionate about all things relating to data,
                            automation, and more recently, machine learning.
                            While I am busy with my studies, I enjoy creating
                            things that I think are cool and sharing them with
                            people! See my <a href='/projects'>projects</a> to check out what I’ve been
                            up to!
                        </p>
                        <div className={styles.adjs}>
                            <h1>I'm a Developer.</h1>
                            <h1>I'm an Engineer.</h1>
                            <h1>I'm a Creator.</h1>
                        </div>

                        <div className={styles.tmt}>
                            <h1>Take me to...</h1>
                        </div>
                        <div className={styles.tmtContent}>
                            <div>Project Spotlight</div>
                            <div>Skills & Stacks</div>
                            <div>Career Experience</div>
                            <div>Page Repository</div>
                            <div>Contact Information</div>
                        </div>

                    </div>
                </div>

            </header>
        </div>
    );
}

export default Home;
