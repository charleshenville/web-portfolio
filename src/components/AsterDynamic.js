import * as THREE from 'three';
import { AsciiEffect } from './AsciiEffect.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import React, { useEffect, useRef } from 'react';

function AsterDynamic({
    characters = ' .:-=+*#%@',
    cameraPos = { x: 0, y: 0, z: 5 },
    objectPos = { x: 0, y: 0, z: 0 },
    objectRot = { x: Math.PI / 2, y: 0, z: 0 },
    objectScale = { x: 1, y: 1, z: 1 },
    lights = [{ id: 1, x: 100, y: 100, z: 100, color: '#ffffff', intensity: 1 }],
    autoRotate = false,
    rotationSpeed = { y: 0.001, z: 0.0004 },
    uploadedFile = null,
    fileType = null
}) {
    const sceneRef = useRef();
    const rendererRef = useRef();
    const cameraRef = useRef();
    const effectRef = useRef();
    const currentObjectRef = useRef();
    const lightsArrayRef = useRef([]);
    const animationIdRef = useRef();
    const isInitializedRef = useRef(false);
    const loadingRef = useRef(false); // Add loading state to prevent race conditions
    
    // Store current prop values in refs so they're accessible in the animation loop
    const autoRotateRef = useRef(autoRotate);
    const rotationSpeedRef = useRef(rotationSpeed);

    // Initialize scene only once
    useEffect(() => {
        if (!isInitializedRef.current) {
            initializeScene();
            isInitializedRef.current = true;
        }

        return () => {
            cleanup();
        };
    }, []);

    // Update autoRotate ref when prop changes
    useEffect(() => {
        autoRotateRef.current = autoRotate;
    }, [autoRotate]);

    // Update rotationSpeed ref when prop changes
    useEffect(() => {
        rotationSpeedRef.current = rotationSpeed;
    }, [rotationSpeed]);

    // Update characters when they change
    useEffect(() => {
        if (isInitializedRef.current && effectRef.current) {
            updateCharacters();
        }
    }, [characters]);

    // Update camera position when it changes
    useEffect(() => {
        if (isInitializedRef.current) {
            updateCameraPosition();
        }
    }, [cameraPos]);

    // Update object transform when position, rotation, or scale changes
    useEffect(() => {
        if (isInitializedRef.current) {
            updateObjectTransform();
        }
    }, [objectPos, objectRot, objectScale]);

    // Update lights when they change
    useEffect(() => {
        if (isInitializedRef.current) {
            setupLights();
        }
    }, [lights]);

    // Update object when file changes
    useEffect(() => {
        if (isInitializedRef.current) {
            loadObject();
        }
    }, [uploadedFile, fileType]);

    const cleanup = () => {
        if (animationIdRef.current) {
            cancelAnimationFrame(animationIdRef.current);
        }

        // Clean up lights
        lightsArrayRef.current.forEach(light => {
            if (light.dispose) light.dispose();
        });
        lightsArrayRef.current = [];

        // Clean up current object
        if (currentObjectRef.current) {
            disposeObject(currentObjectRef.current);
        }

        // Clean up renderer and effect
        if (rendererRef.current) {
            rendererRef.current.dispose();
        }

        if (effectRef.current && effectRef.current.domElement) {
            const asterElement = document.getElementById('aster');
            if (asterElement) {
                asterElement.remove();
            }
        }

        // Remove resize listener
        window.removeEventListener('resize', onWindowResize);
    };

    const disposeObject = (obj) => {
        if (!obj) return;

        if (obj.geometry) {
            obj.geometry.dispose();
        }

        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(material => {
                    if (material.dispose) material.dispose();
                });
            } else if (obj.material.dispose) {
                obj.material.dispose();
            }
        }

        if (obj.children) {
            obj.children.forEach(child => disposeObject(child));
        }

        if (obj.parent) {
            obj.parent.remove(obj);
        }
    };

    // Preview fills its container (falls back to the full window).
    const getStageSize = () => {
        const parent = document.getElementById('asterParent');
        return {
            width: parent?.clientWidth || window.innerWidth,
            height: parent?.clientHeight || window.innerHeight,
        };
    };

    const initializeScene = () => {
        // Remove existing element if it exists
        const existingElement = document.getElementById('aster');
        if (existingElement) {
            existingElement.remove();
        }

        const { width, height } = getStageSize();
        let scene = new THREE.Scene();
        let camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        let renderer = new THREE.WebGLRenderer();
        renderer.setSize(width, height);

        // Store references
        sceneRef.current = scene;
        cameraRef.current = camera;
        rendererRef.current = renderer;

        // Setup ASCII effect
        let effect = new AsciiEffect(renderer, characters, { color: true, invert: true });
        effect.setSize(width, height);
        effect.domElement.id = 'aster';
        effect.domElement.style.color = '#ffffff';
        effect.domElement.style.backgroundColor = 'black';
        effect.domElement.style.width = '100%';
        effect.domElement.style.height = '100%';
        effect.domElement.style.left = '0';
        effect.domElement.style.position = 'relative';
        effect.domElement.style.zIndex = '0';
        effect.domElement.style.overflow = 'hidden';

        effectRef.current = effect;

        const asterParentElem = document.getElementById('asterParent');
        if (asterParentElem) {
            asterParentElem.appendChild(effect.domElement);
        }

        // Setup initial state
        setupLights();
        loadObject();
        updateCameraPosition();

        // Setup resize handler
        window.addEventListener('resize', onWindowResize);

        // Start animation
        animate();
    };

    const updateCharacters = () => {
        if (!effectRef.current || !rendererRef.current) return;

        // Create new effect with updated characters
        const oldEffect = effectRef.current;
        const { width, height } = getStageSize();
        const newEffect = new AsciiEffect(rendererRef.current, characters, { color: false, invert: true });
        newEffect.setSize(width, height);
        newEffect.domElement.id = 'aster';
        newEffect.domElement.style.color = '#ffffff';
        newEffect.domElement.style.backgroundColor = 'black';
        newEffect.domElement.style.width = '100%';
        newEffect.domElement.style.height = '100%';
        newEffect.domElement.style.left = '0';
        newEffect.domElement.style.position = 'relative';
        newEffect.domElement.style.zIndex = '0';
        newEffect.domElement.style.overflow = 'hidden';

        // Replace the old element with the new one
        const asterParentElem = document.getElementById('asterParent');
        if (asterParentElem && oldEffect.domElement) {
            asterParentElem.removeChild(oldEffect.domElement);
            asterParentElem.appendChild(newEffect.domElement);
        }

        effectRef.current = newEffect;
    };

    const setupLights = () => {
        if (!sceneRef.current) return;

        // Remove existing lights
        lightsArrayRef.current.forEach(light => {
            sceneRef.current.remove(light);
            if (light.dispose) light.dispose();
        });
        lightsArrayRef.current = [];

        // Add new lights
        lights.forEach(lightData => {
            const pointLight = new THREE.PointLight(lightData.color, lightData.intensity);
            pointLight.position.set(lightData.x, lightData.y, lightData.z);
            sceneRef.current.add(pointLight);
            lightsArrayRef.current.push(pointLight);
        });
    };

    const updateCameraPosition = () => {
        if (cameraRef.current) {
            cameraRef.current.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
            const origin = new THREE.Vector3(0, 0, 0);
            cameraRef.current.lookAt(origin);
        }
    };

    const updateObjectTransform = () => {
        if (currentObjectRef.current) {
            currentObjectRef.current.position.set(objectPos.x, objectPos.y, objectPos.z);
            currentObjectRef.current.rotation.set(objectRot.x, objectRot.y, objectRot.z);
            currentObjectRef.current.scale.set(objectScale.x, objectScale.y, objectScale.z);
        }
    };

    const loadObject = () => {
        if (!sceneRef.current || loadingRef.current) return;

        loadingRef.current = true;

        // Remove existing object first and wait for it to be fully removed
        if (currentObjectRef.current) {
            sceneRef.current.remove(currentObjectRef.current);
            disposeObject(currentObjectRef.current);
            currentObjectRef.current = null;
        }

        if (uploadedFile && fileType) {
            if (fileType === 'gltf') {
                const loader = new GLTFLoader();
                loader.load(uploadedFile, (gltf) => {
                    // Double-check that we haven't started loading something else
                    if (!loadingRef.current) return;

                    currentObjectRef.current = gltf.scene;
                    updateObjectTransform();
                    sceneRef.current.add(currentObjectRef.current);
                    loadingRef.current = false;
                }, undefined, (error) => {
                    console.error('Error loading GLTF:', error);
                    loadDefaultObject();
                });
            } else if (fileType === 'svg') {
                const loader = new SVGLoader();
                loader.load(uploadedFile, (data) => {
                    // Double-check that we haven't started loading something else
                    if (!loadingRef.current) return;

                    const paths = data.paths;
                    const group = new THREE.Group();

                    for (let i = 0; i < paths.length; i++) {
                        const path = paths[i];
                        const material = new THREE.MeshBasicMaterial({
                            color: path.color,
                            side: THREE.DoubleSide,
                            depthWrite: false
                        });

                        const shapes = SVGLoader.createShapes(path);
                        for (let j = 0; j < shapes.length; j++) {
                            const shape = shapes[j];
                            const geometry = new THREE.ExtrudeGeometry(shape, {
                                depth: 20,
                                bevelEnabled: false
                            });
                            const mesh = new THREE.Mesh(geometry, material);
                            group.add(mesh);
                        }
                    }

                    currentObjectRef.current = group;
                    updateObjectTransform();
                    sceneRef.current.add(currentObjectRef.current);
                    loadingRef.current = false;
                }, undefined, (error) => {
                    console.error('Error loading SVG:', error);
                    loadDefaultObject();
                });
            }
        } else {
            // Load default asterisk object
            const loader = new GLTFLoader();
            loader.load('assets/asterisk.gltf', (gltf) => {
                // Double-check that we haven't started loading something else
                if (!loadingRef.current) return;

                currentObjectRef.current = gltf.scene;
                // Don't set rotation here - let updateObjectTransform handle it
                updateObjectTransform();
                sceneRef.current.add(currentObjectRef.current);
                loadingRef.current = false;
            }, undefined, (error) => {
                console.error('Error loading default asterisk:', error);
                loadDefaultObject();
            });
        }
    };

    const loadDefaultObject = () => {
        // Double-check that we haven't started loading something else
        if (!loadingRef.current) return;

        // Fallback to a simple cube if loading fails
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshPhongMaterial({ color: 0x888888 });
        const cube = new THREE.Mesh(geometry, material);

        currentObjectRef.current = cube;
        updateObjectTransform();
        sceneRef.current.add(currentObjectRef.current);
        loadingRef.current = false;
    };

    const animate = () => {
        // Use refs instead of props to get the current values
        if (autoRotateRef.current && currentObjectRef.current) {
            currentObjectRef.current.rotation.y += rotationSpeedRef.current.y;
            currentObjectRef.current.rotation.z += rotationSpeedRef.current.z;
        }

        if (effectRef.current && sceneRef.current && cameraRef.current) {
            effectRef.current.render(sceneRef.current, cameraRef.current);
        }

        animationIdRef.current = requestAnimationFrame(animate);
    };

    const onWindowResize = () => {
        if (!cameraRef.current || !rendererRef.current || !effectRef.current) return;

        const { width, height } = getStageSize();
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(width, height);
        effectRef.current.setSize(width, height);
    };

    return null; // This component doesn't render anything directly
}

export default AsterDynamic;