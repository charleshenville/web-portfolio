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

        // Clean up export buttons
        const exportButtons = document.getElementById('export-buttons');
        if (exportButtons) {
            exportButtons.remove();
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

    const initializeScene = () => {
        // Remove existing element if it exists
        const existingElement = document.getElementById('aster');
        if (existingElement) {
            existingElement.remove();
        }

        let scene = new THREE.Scene();
        let camera = new THREE.PerspectiveCamera(75, (window.innerWidth * 0.6) / window.innerHeight, 0.1, 1000);
        let renderer = new THREE.WebGLRenderer();
        renderer.setSize((window.innerWidth * 0.6), window.innerHeight);

        // Store references
        sceneRef.current = scene;
        cameraRef.current = camera;
        rendererRef.current = renderer;

        // Setup ASCII effect
        let effect = new AsciiEffect(renderer, characters, { color: true, invert: true });
        effect.setSize((window.innerWidth * 0.6), window.innerHeight);
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

        // Add export buttons
        addExportButtons();

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
        const newEffect = new AsciiEffect(rendererRef.current, characters, { color: true, invert: true });
        newEffect.setSize((window.innerWidth * 0.6), window.innerHeight);
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

    const addExportButtons = () => {
        // Check if buttons already exist
        if (document.getElementById('export-buttons')) return;

        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'export-buttons';
        buttonContainer.style.position = 'relative';
        buttonContainer.style.zIndex = '1000';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';

        // Export as text button
        const textButton = document.createElement('button');
        textButton.textContent = 'Export as Text';
        textButton.style.padding = '10px 15px';
        textButton.style.backgroundColor = '#556574ff';
        textButton.style.fontFamily = 'SF Mono, Monospace';
        textButton.style.color = 'white';
        textButton.style.border = 'none';
        textButton.style.borderRadius = '5px';
        textButton.style.cursor = 'pointer';
        textButton.onclick = exportAsText;

        // Export as SVG button
        // const svgButton = document.createElement('button');
        // svgButton.textContent = 'Export as SVG';
        // svgButton.style.padding = '10px 15px';
        // svgButton.style.backgroundColor = '#00aa00';
        // svgButton.style.color = 'white';
        // svgButton.style.border = 'none';
        // svgButton.style.borderRadius = '5px';
        // svgButton.style.cursor = 'pointer';
        // svgButton.onclick = exportAsSVG;

        buttonContainer.appendChild(textButton);
        // buttonContainer.appendChild(svgButton);
        const panel = document.getElementById("asciitool_c_p");
        panel?.appendChild(buttonContainer);
    };

    const exportAsText = () => {
        if (!effectRef.current || !effectRef.current.domElement) return;

        const element = effectRef.current.domElement;
        let text = '';

        // Find the TD element or use the element itself if it's the container
        const tdElement = element.querySelector('td') || element;

        // Walk through all child nodes of the TD
        const processNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                // Add text content
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName.toLowerCase() === 'br') {
                    // BR tags represent line breaks
                    text += '\n';
                } else if (node.tagName.toLowerCase() === 'span') {
                    // Process span content
                    for (let child of node.childNodes) {
                        processNode(child);
                    }
                } else {
                    // Process other elements recursively
                    for (let child of node.childNodes) {
                        processNode(child);
                    }
                }
            }
        };

        // Process all child nodes
        for (let child of tdElement.childNodes) {
            processNode(child);
        }

        if (!text.trim()) return;

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ascii-art.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const exportAsSVG = () => {
        if (!effectRef.current || !effectRef.current.domElement) return;

        const asciiContent = effectRef.current.domElement.textContent;
        if (!asciiContent) return;

        const lines = asciiContent.split('\n');
        const charWidth = 6;
        const charHeight = 10;
        const width = Math.max(...lines.map(line => line.length)) * charWidth;
        const height = lines.length * charHeight;

        let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="black"/>
            <style>text { font-family: monospace; font-size: 8px; fill: #999999; }</style>`;

        lines.forEach((line, y) => {
            if (line.trim()) {
                svg += `<text x="0" y="${(y + 1) * charHeight}">${line
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')}</text>`;
            }
        });

        svg += '</svg>';

        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ascii-art.svg';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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

        cameraRef.current.aspect = (window.innerWidth * 0.6) / window.innerHeight;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize((window.innerWidth * 0.6), window.innerHeight);
        effectRef.current.setSize((window.innerWidth * 0.6), window.innerHeight);
    };

    return null; // This component doesn't render anything directly
}

export default AsterDynamic;