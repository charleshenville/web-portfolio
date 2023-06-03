import styles from './contact.module.css';
import React from 'react';
import SocialAspect from './SocialAspect';
import items from './socials.json'
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader'

function Contact() {

    const start = Date.now();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({
        canvas: document.querySelector('#bg'),
    })
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.rotateY(-3.14/2.3)

    const material = new THREE.MeshPhysicalMaterial({ color: 0xFFFFFF })
    const materialC = new THREE.PointsMaterial({ size: 0.001, vertexColors: true })

    const loader = new PLYLoader()
    loader.load(
        'assets/point_cloud.ply',
        function (geometry) {
            geometry.computeVertexNormals()
            const mesh = new THREE.Points(geometry, materialC)
            mesh.rotateX(-Math.PI / 2)
            scene.add(mesh)
        },
        (xhr) => {
            console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
        },
        (error) => {
            console.log(error)
        }
    )

    const pointLight1 = new THREE.PointLight(0xFFFFFF);
    pointLight1.position.set(0, 0, 0);
    scene.add(pointLight1);

    window.addEventListener('resize', onWindowResize);
    function onWindowResize() {

        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);

    }
    let t;
    Animate();
    function Animate() {
        t = (Date.now()-start)*0.0003;
        camera.rotation.y -= 0.0002;
        camera.position.x = 0.1*Math.sin(t)
        camera.position.z = -0.1*Math.cos(t)
        renderer.render(scene, camera);

        requestAnimationFrame(Animate);
        
    }
    return (
        <div style={{ width: '100%', minHeight: '100svh', display: 'flex', flexWrap: 'wrap', alignItems: 'center', paddingTop: '8svh', paddingBottom: '8svh', boxSizing: 'border-box' }}>
            <header className={styles.header}>

                <div className={styles.title}>
                    <p style={{ marginTop: '0px' }}>Let's Get In Touch.</p>
                </div>

                <form style={{ width: '100%', display: 'flex', justifyContent: 'center' }} action="/submit" method="POST">
                    <div className={styles.contactFormContainer}>
                        <div className={styles.contactFormSubs}>
                            <input className={styles.textStyles} maxlength="30" type="text" id="first" name="firstname" placeholder="First Name" />
                            <input className={styles.textStyles} maxlength="30" type="text" id="last" name="lastname" placeholder="Last Name" />
                            <input className={styles.textStyles} maxlength="30" type="text" id="email" name="email" placeholder='Email Address' />

                        </div>


                        <div className={styles.contactFormSubs}>
                            <div className={styles.messageContainer} style={{ gridRow: 'span 2', display: 'flex', alignContent: 'top' }} >
                                <textarea className={styles.message} maxlength="300" type="text" id="message" name="usermessage" placeholder="Message" />
                            </div>
                            <input className={styles.submit} maxlength="30" type="submit" value="Submit" />

                        </div>
                    </div>
                </form>

                <div className={styles.socialsContainerFlex}>

                    {items.map((item) => (
                        <a className={styles.indivSocial} href={item.url}>
                            <div className={styles.indivSocial}>
                                <SocialAspect id={item.id} />
                                {/* <p style={{ height: '100%', display: 'flex', alignContent: 'center', flexWrap: 'wrap', margin: '0px', boxSizing: 'border-box', paddingLeft: '4%' }}>{item.handle}</p> */}
                            </div>
                        </a>


                    ))}

                </div>

            </header>

        </div>

    );

}

export default Contact;
