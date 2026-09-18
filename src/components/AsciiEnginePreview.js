import React, { useEffect, useRef, useState } from 'react';
import AsterDynamic from './AsterDynamic';
import { prefersReducedMotion } from '../lib/ticker';
import styles from './vfx.module.css';

// The ascii renderer itself, shrunk into a card: the same three.js scene and
// AsciiEffect the tool runs, with the default asterisk turning on its own.
//
// three.js is only pulled in (this module is lazy-loaded) and the scene only
// built once the card is near the viewport; the loop then stops whenever it
// leaves again. Reduced motion gets the model standing still.
const LIGHTS = [{ id: 1, x: 500, y: 500, z: 500, color: '#ffffff', intensity: 1 }];
const CAMERA = { x: 0, y: 0, z: 1 };
const OBJECT_ROT = { x: Math.PI / 2, y: 0, z: 0 };
// The tool opens on a small asterisk in a full viewport; in a card it has to
// carry the whole frame, so it is scaled up to fill it.
const OBJECT_SCALE = { x: 4, y: 4, z: 4 };
const SPEED = { y: 0.007, z: 0.003 };

function AsciiEnginePreview() {
    const hostRef = useRef(null);
    const [visible, setVisible] = useState(false);
    const [built, setBuilt] = useState(false);

    useEffect(() => {
        const io = new IntersectionObserver(([entry]) => {
            setVisible(entry.isIntersecting);
            // the scene is kept once built: scrolling past shouldn't cost a
            // new WebGL context and another model load
            if (entry.isIntersecting) setBuilt(true);
        }, { rootMargin: '120px' });
        io.observe(hostRef.current);
        return () => io.disconnect();
    }, []);

    return (
        <div ref={hostRef} className={styles.vfx_cardStage} aria-hidden="true">
            {built && (
                <AsterDynamic
                    container={hostRef}
                    active={visible}
                    fps={24}
                    color={false}
                    autoRotate={!prefersReducedMotion()}
                    rotationSpeed={SPEED}
                    cameraPos={CAMERA}
                    objectRot={OBJECT_ROT}
                    objectScale={OBJECT_SCALE}
                    lights={LIGHTS}
                />
            )}
        </div>
    );
}

export default AsciiEnginePreview;
