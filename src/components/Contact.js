import styles from './contact.module.css';
import React, { useState, useRef } from 'react';
import emailjs from "@emailjs/browser";
import SocialAspect from './SocialAspect';
import items from './socials.json'
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader'

function Contact() {

    const [notifText, setNotifText] = useState("Let's Get In Touch.");

    const start = Date.now();

    let filter = document.getElementById('filter');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer(
        {
            canvas: document.querySelector('#bg'),
        }
    )
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.rotateY(-3.14 / 2.3)

    const material = new THREE.MeshPhysicalMaterial({ color: 0xFFFFFF }) // use for b&w
    const materialC = new THREE.PointsMaterial({ size: 0.003, vertexColors: true })

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
            if (xhr.loaded == xhr.total) {
                MakeTrasnparent();
            }
            //console.log((xhr.loaded / xhr.total) * 100 + '% loaded')

        },
        (error) => {
            console.log(error)
        }

    )

    function MakeTrasnparent() {

        //console.log("here")
        var target = document.getElementById('filter');
        target.classList.add(styles.transparent);

    }

    // window.addEventListener('load', function () {
    //     console.log("here")
    //     var target = document.getElementById('filter');
    //     target.classList.add(styles.transparent);
    // });

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
        t = (Date.now() - start) * 0.0003;
        camera.rotation.y -= 0.0002;
        camera.position.x = 0.2 * Math.sin(t)
        camera.position.z = -0.21 * Math.cos(t)
        renderer.render(scene, camera);

        requestAnimationFrame(Animate);

    }

    const formRef = useRef();

    const sendEmail = (e) => {
        e.preventDefault();

        const inputElement = document.getElementById('submits');
        inputElement.disabled = true;

        // Check if form is valid
        const form = formRef.current;
        const firstName = form.firstname.value.trim();
        const lastName = form.lastname.value.trim();
        const email = form.email.value.trim();
        const message = form.usermessage.value.trim();

        if (firstName === '' || lastName === '' || email === '' || message === '') {
            setNotifText('Please fill in all form fields.');
            inputElement.disabled = false;
            return null;
        }

        if (!email.includes('@') || !email.includes('.')) {
            setNotifText('Please enter a valid email address.');
            inputElement.disabled = false;
            return null;
        }

        emailjs
            .sendForm(
                "service_khx2ntp",
                "template_adla74a",
                formRef.current,
                "K2gA7Qym2vSMS9Ifv"
            )
            .then(
                (result) => {

                    console.log(result.text);
                    console.log("message sent");
                    setNotifText("Message sent, Thank you!")
                    setTimeout(() => {
                        inputElement.disabled = false;
                    }, 10000);

                },
                (error) => {

                    console.log(error.text);
                    setNotifText("Something went wrong. Try again later!")
                    setTimeout(() => {
                        inputElement.disabled = false;
                    }, 30000);

                }
            );
    };

    return (
        <div style={{ width: '100%', minHeight: '100svh', display: 'flex', flexWrap: 'wrap', alignItems: 'center', paddingTop: '8svh', paddingBottom: '8svh', boxSizing: 'border-box' }}>

            <div id='filter' style={{ width: '100%', height: '100%', top: '0', left: '0', backgroundColor: 'black', position: 'absolute' }} ></div>

            <header className={styles.header}>

                <div className={styles.title}>
                    <p style={{ marginTop: '0px' }}>{notifText}</p>
                </div>

                <form style={{ width: '100%', display: 'flex', justifyContent: 'center' }} ref={formRef} onSubmit={sendEmail}>
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
                            <input id='submits' className={styles.submit} maxlength="30" type="submit" value="Submit" />

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

        </div >

    );

}

export default Contact;
