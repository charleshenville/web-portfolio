import React, { useState, useRef } from 'react';
import { SlidersHorizontal, X, Plus, Upload, Download } from 'lucide-react';
import AsterDynamic from './AsterDynamic';
import VfxNumberField from './VfxNumberField';
import styles from './vfx.module.css';

const DEFAULTS = {
    characters: ' .:-=+*#%@',
    cameraPos: { x: 0, y: 0, z: 1 },
    objectPos: { x: 0, y: 0, z: 0 },
    objectRot: { x: Math.PI / 2, y: 0, z: 0 },
    objectScale: { x: 1, y: 1, z: 1 },
    autoRotate: false,
    rotationSpeed: { y: 0.01, z: 0.004 },
};

const makeDefaultLight = () => ({ id: 1, x: 500, y: 500, z: 500, color: '#ffffff', intensity: 1 });

function AsciiTool() {
    const [characters, setCharacters] = useState(DEFAULTS.characters);
    const [cameraPos, setCameraPos] = useState(DEFAULTS.cameraPos);
    const [objectPos, setObjectPos] = useState(DEFAULTS.objectPos);
    const [objectRot, setObjectRot] = useState(DEFAULTS.objectRot);
    const [objectScale, setObjectScale] = useState(DEFAULTS.objectScale);
    const [lights, setLights] = useState([makeDefaultLight()]);
    const [autoRotate, setAutoRotate] = useState(DEFAULTS.autoRotate);
    const [rotationSpeed, setRotationSpeed] = useState(DEFAULTS.rotationSpeed);
    const [uploadedFile, setUploadedFile] = useState(null);
    const [fileType, setFileType] = useState(null);
    const [fileName, setFileName] = useState('');
    const [menuOpen, setMenuOpen] = useState(true);

    const fileInputRef = useRef(null);

    const handleFileUpload = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        setUploadedFile((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(file);
        });
        setFileType('gltf');
        setFileName(file.name);
        event.target.value = '';
    };

    const addLight = () => {
        setLights((prev) => [...prev, {
            id: Date.now(),
            x: Math.random() * 200 - 100,
            y: Math.random() * 200 - 100,
            z: Math.random() * 200 - 100,
            color: '#ffffff',
            intensity: 1,
        }]);
    };

    const updateLight = (id, property, value) => {
        setLights((prev) => prev.map((light) => (
            light.id === id ? { ...light, [property]: value } : light
        )));
    };

    const removeLight = (id) => {
        setLights((prev) => (prev.length > 1 ? prev.filter((light) => light.id !== id) : prev));
    };

    const resetDefaults = () => {
        setCharacters(DEFAULTS.characters);
        setCameraPos(DEFAULTS.cameraPos);
        setObjectPos(DEFAULTS.objectPos);
        setObjectRot(DEFAULTS.objectRot);
        setObjectScale(DEFAULTS.objectScale);
        setAutoRotate(DEFAULTS.autoRotate);
        setRotationSpeed(DEFAULTS.rotationSpeed);
        setLights([makeDefaultLight()]);
    };

    // Serialize the rendered ascii frame (spans + <br> line breaks) to a .txt.
    const exportAsText = () => {
        const element = document.getElementById('aster');
        if (!element) return;
        const tdElement = element.querySelector('td') || element;

        let text = '';
        const processNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName.toLowerCase() === 'br') {
                    text += '\n';
                } else {
                    for (const child of node.childNodes) processNode(child);
                }
            }
        };
        for (const child of tdElement.childNodes) processNode(child);

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

    // Slider + typed-value row (typed value can override the slider range).
    const sliderRow = (label, value, onCommit, min, max, step) => (
        <div className={styles.vfx_row} key={label}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onCommit(parseFloat(e.target.value))}
            />
            <VfxNumberField
                value={value}
                min={min}
                max={max}
                step={step}
                onCommit={onCommit}
            />
        </div>
    );

    const switchRow = (label, value, onToggle) => (
        <div
            className={styles.vfx_checkRow}
            key={label}
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${value ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );

    const vecRows = (labels, vec, setVec, min, max, step) => (
        ['x', 'y', 'z'].map((axis, i) => sliderRow(
            labels[i],
            vec[axis],
            (n) => setVec({ ...vec, [axis]: n }),
            min, max, step,
        ))
    );

    return (
        <div className={styles.vfx}>
            <input
                ref={fileInputRef}
                type="file"
                accept=".gltf,.glb"
                style={{ display: 'none' }}
                onChange={handleFileUpload}
            />

            {/* Full-screen ascii preview */}
            <div id="asterParent" className={styles.vfx_fullStage}>
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

            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    className={`${styles.vfx_toggle} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {menuOpen && (
                <div className={styles.vfx_panel}>
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Ascii Renderer</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Source */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Source</div>
                        <div className={styles.vfx_playRow}>
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                onClick={() => fileInputRef.current.click()}
                            >
                                <Upload size={13} />
                                {uploadedFile ? 'Change Model' : 'Upload Model'}
                            </button>
                        </div>
                        <div className={styles.vfx_fileName} title={fileName || 'asterisk.gltf (default)'}>
                            {fileName || 'asterisk.gltf (default)'}
                        </div>
                    </div>

                    {/* Characters */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Characters</div>
                        <input
                            type="text"
                            className={styles.vfx_text}
                            value={characters}
                            onChange={(e) => setCharacters(e.target.value)}
                            placeholder="dark -> bright ramp"
                            spellCheck={false}
                        />
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Characters ordered dark to bright.
                        </div>
                    </div>

                    {/* Camera */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Camera</div>
                        {vecRows(['Pos X', 'Pos Y', 'Pos Z'], cameraPos, setCameraPos, -20, 20, 0.1)}
                    </div>

                    {/* Object */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Object Transform</div>
                        {vecRows(['Pos X', 'Pos Y', 'Pos Z'], objectPos, setObjectPos, -20, 20, 0.1)}
                        {vecRows(['Rot X', 'Rot Y', 'Rot Z'], objectRot, setObjectRot, -Math.PI * 2, Math.PI * 2, 0.01)}
                        {vecRows(['Scale X', 'Scale Y', 'Scale Z'], objectScale, setObjectScale, 0.05, 10, 0.05)}
                    </div>

                    {/* Rotation */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Rotation</div>
                        {switchRow('Auto Rotate', autoRotate, () => setAutoRotate((v) => !v))}
                        {sliderRow('Speed Y', rotationSpeed.y, (n) => setRotationSpeed({ ...rotationSpeed, y: n }), -0.1, 0.1, 0.001)}
                        {sliderRow('Speed Z', rotationSpeed.z, (n) => setRotationSpeed({ ...rotationSpeed, z: n }), -0.1, 0.1, 0.001)}
                    </div>

                    {/* Lights */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Lights</div>
                        {lights.map((light, i) => (
                            <div className={styles.vfx_card} key={light.id}>
                                <div className={styles.vfx_cardHead}>
                                    <span>Light {i + 1}</span>
                                    <button
                                        type="button"
                                        aria-label="Remove light"
                                        className={styles.vfx_iconBtn}
                                        disabled={lights.length <= 1}
                                        onClick={() => removeLight(light.id)}
                                    >
                                        <X size={13} />
                                    </button>
                                </div>
                                {['x', 'y', 'z'].map((axis) => sliderRow(
                                    axis.toUpperCase(),
                                    light[axis],
                                    (n) => updateLight(light.id, axis, n),
                                    -1000, 1000, 1,
                                ))}
                                {sliderRow('Intensity', light.intensity, (n) => updateLight(light.id, 'intensity', n), 0, 5, 0.1)}
                                <div className={styles.vfx_row}>
                                    <span className={styles.vfx_label}>Color</span>
                                    <input
                                        type="color"
                                        className={styles.vfx_color}
                                        style={{ gridColumn: '2 / 4' }}
                                        value={light.color}
                                        onChange={(e) => updateLight(light.id, 'color', e.target.value)}
                                    />
                                </div>
                            </div>
                        ))}
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 }}
                            onClick={addLight}
                        >
                            <Plus size={13} />
                            Add Light
                        </button>
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export</div>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                            onClick={exportAsText}
                        >
                            <Download size={13} />
                            Export as Text
                        </button>
                    </div>

                    <div className={styles.vfx_section}>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ textAlign: 'center' }}
                            onClick={resetDefaults}
                        >
                            Reset Defaults
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            Upload a .gltf / .glb model to replace the default asterisk.
                            Type a value next to any slider to override its range.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default AsciiTool;
