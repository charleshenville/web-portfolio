import './App.css';
import MenuBar from './MenuBar';
import Adjectives from './Adjectives';
import * as THREE from 'three';

function App() {

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#bg'),
  })
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.position.setZ(30);

  const materials = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, wireframe: true });

  const mainTorusGeometry = new THREE.TorusGeometry(12, 7, 10, 50);
  const torus = new THREE.Mesh(mainTorusGeometry, materials);
  const torusX = 18;

  scene.add(torus);
  torus.position.x = torusX;

  const icosRadius = 9;
  const icosahedronGrometry = new THREE.OctahedronGeometry(icosRadius, 1);
  const icosahedron = new THREE.Mesh(icosahedronGrometry, materials);
  const icosX = 60;
  icosahedron.position.x = icosX;
  scene.add(icosahedron);

  function Animate() {
    renderer.render(scene, camera);
    renderer.setSize(window.innerWidth, window.innerHeight);
    torus.rotation.x += 0.001;
    torus.rotation.y += 0.0005;
    torus.rotation.z += 0.00025;

    for (let i = 0; i < 3; i++) {
      icosahedron.rotation.x += 0.001;
      icosahedron.rotation.y += 0.0008;
    }

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

    if((icosX/1250)*toTop+2*icosX <= 12.75){
      icosahedron.position.y = -0.05*(toTop - (12.75-2*icosX)*(1250/icosX));
    }
    else if (toTop < -1250)
    {
      icosahedron.position.x = (icosX/1250)*toTop+2*icosX;
    }

  }
  document.body.onscroll = ScrollHome;

  return (
    <div className="App">
      <Animate />
      <MenuBar />
      <header className="App-header">

        <div className='mainGrid'>
          <h1 className="txt">CHARLES HENVILLE.</h1>
          <h1 className="aboutTxt">ABOUT.</h1>
          <a className="aboutSubTxt">
            Hi viewer! I’m Charles Miguel, an 18-year-old computer
            engineer at the University of Toronto in Canada.
            I’m passionate about all things relating to data,
            automation, and more recently, machine learning.
            While I am busy with my studies, I enjoy creating
            things that I think are cool and sharing them with
            people! See my projects to check out what I’ve been
            up to!
          </a>
          <div className="adjs"><Adjectives /></div>
        </div>


      </header>
    </div>
  );
}

export default App;
