import * as THREE from 'three';
import { AsciiEffect } from './AsciiEffect.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

function Aster() {

    let scene = new THREE.Scene();
    let camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    // let renderer = new THREE.WebGLRenderer({
    //     canvas: document.querySelector('#re'),
    // });
    
    let renderer = new THREE.WebGLRenderer();
    renderer.setSize( window.innerWidth, window.innerHeight );

    const pointLight1 = new THREE.PointLight(0xFFFFFF);
    pointLight1.position.set(500, 500, 500);
    scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0xFFFFFF);
    pointLight2.position.set(-500, -500, -500);
    scene.add(pointLight2);

    let effect;
    function asciiart() {
        effect = new AsciiEffect(renderer, ' .:-+*%$@#', { invert: true });
        effect.setSize(window.innerWidth-15, window.innerHeight);
        effect.domElement.style.color = '#999999';
        effect.domElement.style.backgroundColor = 'black';
        effect.domElement.style.width = '100%';
        effect.domElement.style.height = '100%';
        effect.domElement.style.top = '4vh';
        effect.domElement.style.left = '0';
        effect.domElement.style.position = 'relative';
        
        document.body.appendChild(effect.domElement);
        
    }
    asciiart();

    const loader = new GLTFLoader();
    let ast;
    loader.load('assets/asterisk.gltf', (gltf) => {

        ast = gltf.scene;
        ast.scale.set(150, 150, 150);
        ast.position.x = 0;
        ast.position.y = 0;
        ast.position.z = 0;
        ast.rotation.x = 3.1415 / 2;
        scene.add(ast)

        animateAST();
        function animateAST() {
            ast.rotation.y += 0.001;
            ast.rotation.z += 0.0004;

            requestAnimationFrame(animateAST);
        }
    })

    window.addEventListener('resize', onWindowResize);
    camera.position.setZ(30);

    animate();
    function animate() {
        effect.render(scene, camera);
        requestAnimationFrame(animate);
    }

    function onWindowResize() {
        
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        // renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        effect.setSize(window.innerWidth-15, window.innerHeight);

    }

}

export default Aster;
