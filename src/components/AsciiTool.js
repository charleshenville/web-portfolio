import styles from './resume.module.css';
import React, { useState, useEffect, useRef } from 'react';
import AsterDynamic from './AsterDynamic';

function AsciiTool() {
    // UI State
    const [characters, setCharacters] = useState(' .:-=+*#%@');
    const [cameraPos, setCameraPos] = useState({ x: 0, y: 0, z: 1 });
    const [objectPos, setObjectPos] = useState({ x: 0, y: 0, z: 0 });
    const [objectRot, setObjectRot] = useState({ x: Math.PI/2, y: 0, z: 0 });
    const [objectScale, setObjectScale] = useState({ x: 1, y: 1, z: 1 });
    const [lights, setLights] = useState([
        { id: 1, x: 500, y: 500, z: 500, color: '#ffffff', intensity: 1 }
    ]);
    const [autoRotate, setAutoRotate] = useState(false);
    const [rotationSpeed, setRotationSpeed] = useState({ y: 0.001, z: 0.0004 });
    const [uploadedFile, setUploadedFile] = useState(null);
    const [fileType, setFileType] = useState(null);

    const handleFileUpload = (event, type) => {
        const file = event.target.files[0];
        if (!file) return;
        
        const url = URL.createObjectURL(file);
        setUploadedFile(url);
        setFileType(type);
    };

    const addLight = () => {
        const newLight = {
            id: Date.now(),
            x: Math.random() * 200 - 100,
            y: Math.random() * 200 - 100,
            z: Math.random() * 200 - 100,
            color: '#ffffff',
            intensity: 1
        };
        setLights([...lights, newLight]);
    };

    const updateLight = (id, property, value) => {
        setLights(lights.map(light => 
            light.id === id ? { ...light, [property]: value } : light
        ));
    };

    const removeLight = (id) => {
        if (lights.length > 1) {
            setLights(lights.filter(light => light.id !== id));
        }
    };

    return (
        <div style={{ width: '100%', backgroundColor: '#111', color: '#fff'}}>
            <div className={styles.header}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr', gap: '20px', padding: '20px' }}>
                    {/* Canvas Area */}
                    <div id="asterParent" style={{height:'100svh', width:'60svw'}}>
                        <AsterDynamic 
                            characters={characters}
                            cameraPos={cameraPos}
                            objectPos={objectPos}
                            objectRot={objectRot}
                            objectScale={objectScale}
                            lights={lights}
                            autoRotate={autoRotate}
                            rotationSpeed={rotationSpeed}
                            uploadedFile={uploadedFile}
                            fileType={fileType}
                        />
                    </div>

                    {/* Controls Panel */}
                    <div style={{ 
                        backgroundColor: '#222', 
                        padding: '20px', 
                        borderRadius: '8px',
                        maxHeight: '80vh',
                        overflowY: 'auto'
                    }}>
                        <h2 style={{ marginBottom: '20px', fontSize: '24px' }}>ASCII Art Controls</h2>

                        {/* Characters */}
                        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#333', borderRadius: '6px' }}>
                            <h3 style={{ marginBottom: '10px' }}>ASCII Characters</h3>
                            <input
                                type="text"
                                value={characters}
                                onChange={(e) => setCharacters(e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '8px',
                                    backgroundColor: '#444',
                                    border: '1px solid #666',
                                    borderRadius: '4px',
                                    color: '#fff',
                                    fontFamily: 'monospace'
                                }}
                                placeholder="Enter characters..."
                            />
                        </div>

                        {/* File Upload */}
                        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#333', borderRadius: '6px' }}>
                            <h3 style={{ marginBottom: '10px' }}>Load Model</h3>
                            <div style={{ marginBottom: '10px' }}>
                                <label style={{ display: 'block', fontSize: '14px', marginBottom: '5px' }}>
                                    GLTF File:
                                </label>
                                <input
                                    type="file"
                                    accept=".gltf,.glb"
                                    onChange={(e) => handleFileUpload(e, 'gltf')}
                                    style={{ width: '100%', padding: '5px' }}
                                />
                            </div>
                            <div>
                                <label style={{ display: 'block', fontSize: '14px', marginBottom: '5px' }}>
                                    SVG File:
                                </label>
                                <input
                                    type="file"
                                    accept=".svg"
                                    onChange={(e) => handleFileUpload(e, 'svg')}
                                    style={{ width: '100%', padding: '5px' }}
                                />
                            </div>
                        </div>

                        {/* Camera Controls */}
                        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#333', borderRadius: '6px' }}>
                            <h3 style={{ marginBottom: '10px' }}>Camera Position</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                                {['x', 'y', 'z'].map(axis => (
                                    <label key={axis} style={{ fontSize: '12px' }}>
                                        <span style={{ color: '#ccc' }}>{axis.toUpperCase()}:</span>
                                        <input
                                            type="number"
                                            value={cameraPos[axis]}
                                            onChange={(e) => setCameraPos({...cameraPos, [axis]: parseFloat(e.target.value) || 0})}
                                            style={{
                                                width: '100%',
                                                padding: '4px',
                                                backgroundColor: '#444',
                                                border: '1px solid #666',
                                                borderRadius: '4px',
                                                color: '#fff',
                                                marginTop: '2px'
                                            }}
                                        />
                                    </label>
                                ))}
                            </div>
                        </div>

                        {/* Object Controls */}
                        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#333', borderRadius: '6px' }}>
                            <h3 style={{ marginBottom: '10px' }}>Object Transform</h3>
                            
                            <div style={{ marginBottom: '10px' }}>
                                <span style={{ fontSize: '14px', color: '#ccc' }}>Position:</span>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginTop: '5px' }}>
                                    {['x', 'y', 'z'].map(axis => (
                                        <input
                                            key={axis}
                                            type="number"
                                            value={objectPos[axis]}
                                            onChange={(e) => setObjectPos({...objectPos, [axis]: parseFloat(e.target.value) || 0})}
                                            style={{
                                                padding: '4px',
                                                backgroundColor: '#444',
                                                border: '1px solid #666',
                                                borderRadius: '4px',
                                                color: '#fff',
                                                fontSize: '12px'
                                            }}
                                            placeholder={axis}
                                        />
                                    ))}
                                </div>
                            </div>

                            <div style={{ marginBottom: '10px' }}>
                                <span style={{ fontSize: '14px', color: '#ccc' }}>Rotation:</span>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginTop: '5px' }}>
                                    {['x', 'y', 'z'].map(axis => (
                                        <input
                                            key={axis}
                                            type="number"
                                            step="0.1"
                                            value={objectRot[axis].toFixed(2)}
                                            onChange={(e) => setObjectRot({...objectRot, [axis]: parseFloat(e.target.value) || 0})}
                                            style={{
                                                padding: '4px',
                                                backgroundColor: '#444',
                                                border: '1px solid #666',
                                                borderRadius: '4px',
                                                color: '#fff',
                                                fontSize: '12px'
                                            }}
                                            placeholder={axis}
                                        />
                                    ))}
                                </div>
                            </div>

                            <div style={{ marginBottom: '10px' }}>
                                <span style={{ fontSize: '14px', color: '#ccc' }}>Scale:</span>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginTop: '5px' }}>
                                    {['x', 'y', 'z'].map(axis => (
                                        <input
                                            key={axis}
                                            type="number"
                                            value={objectScale[axis]}
                                            onChange={(e) => setObjectScale({...objectScale, [axis]: parseFloat(e.target.value) || 1})}
                                            style={{
                                                padding: '4px',
                                                backgroundColor: '#444',
                                                border: '1px solid #666',
                                                borderRadius: '4px',
                                                color: '#fff',
                                                fontSize: '12px'
                                            }}
                                            placeholder={axis}
                                        />
                                    ))}
                                </div>
                            </div>

                            <label style={{ display: 'flex', alignItems: 'center', fontSize: '14px', marginTop: '10px' }}>
                                <input
                                    type="checkbox"
                                    checked={autoRotate}
                                    onChange={(e) => setAutoRotate(e.target.checked)}
                                    style={{ marginRight: '8px' }}
                                />
                                Auto Rotate
                            </label>
                        </div>

                        {/* Lights */}
                        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#333', borderRadius: '6px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                <h3>Lights</h3>
                                <button 
                                    onClick={addLight}
                                    style={{
                                        padding: '6px 12px',
                                        backgroundColor: '#0066cc',
                                        border: 'none',
                                        borderRadius: '4px',
                                        color: '#fff',
                                        cursor: 'pointer',
                                        fontSize: '12px'
                                    }}
                                >
                                    Add Light
                                </button>
                            </div>

                            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                                {lights.map((light) => (
                                    <div key={light.id} style={{ 
                                        backgroundColor: '#444', 
                                        padding: '10px', 
                                        borderRadius: '4px', 
                                        marginBottom: '8px' 
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                            <span style={{ fontSize: '14px', fontWeight: 'bold' }}>Light {light.id}</span>
                                            <button
                                                onClick={() => removeLight(light.id)}
                                                style={{
                                                    backgroundColor: '#cc0000',
                                                    border: 'none',
                                                    borderRadius: '3px',
                                                    color: '#fff',
                                                    cursor: 'pointer',
                                                    fontSize: '10px',
                                                    padding: '3px 6px'
                                                }}
                                            >
                                                Remove
                                            </button>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginBottom: '8px' }}>
                                            {['x', 'y', 'z'].map(axis => (
                                                <input
                                                    key={axis}
                                                    type="number"
                                                    value={light[axis]}
                                                    onChange={(e) => updateLight(light.id, axis, parseFloat(e.target.value) || 0)}
                                                    style={{
                                                        padding: '4px',
                                                        backgroundColor: '#555',
                                                        border: '1px solid #777',
                                                        borderRadius: '3px',
                                                        color: '#fff',
                                                        fontSize: '11px'
                                                    }}
                                                    placeholder={axis}
                                                />
                                            ))}
                                        </div>

                                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                            <input
                                                type="color"
                                                value={light.color}
                                                onChange={(e) => updateLight(light.id, 'color', e.target.value)}
                                                style={{ width: '30px', height: '25px', borderRadius: '3px', border: 'none' }}
                                            />
                                            <input
                                                type="range"
                                                min="0"
                                                max="2"
                                                step="0.1"
                                                value={light.intensity}
                                                onChange={(e) => updateLight(light.id, 'intensity', parseFloat(e.target.value))}
                                                style={{ flex: 1 }}
                                            />
                                            <span style={{ fontSize: '11px', minWidth: '30px' }}>{light.intensity}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AsciiTool;