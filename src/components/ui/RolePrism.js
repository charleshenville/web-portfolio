import React, { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../lib/ticker';
import styles from './ui.module.css';

// The roles sitting on the faces of a virtual prism, one face forward at a
// time. The prism keeps turning the same way, so `turn` counts up forever and
// the live face is `turn % faces`.
//
// This is the compact stand-in for the full roles list: it only goes in where
// there is no room for the list itself (the narrow layout).

const DWELL = 2300;

// distance from the axis to each face, so the faces meet at their edges
const radiusFor = (height, faces) => height / 2 / Math.tan(Math.PI / faces);

function RolePrism({ items, className = '' }) {
    const stage = useRef(null);
    const [turn, setTurn] = useState(0);
    const [height, setHeight] = useState(0);
    const faces = items.length;
    const step = 360 / faces;
    const live = turn % faces;

    // the geometry needs the face height in px, and it comes from a clamp()
    useEffect(() => {
        const el = stage.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(() => setHeight(el.clientHeight));
        ro.observe(el);
        setHeight(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    // turn only while on screen, and never under reduced motion
    useEffect(() => {
        const el = stage.current;
        if (!el || faces < 2 || prefersReducedMotion()) return undefined;
        let timer = 0;
        const io = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting && !timer) {
                timer = setInterval(() => setTurn((t) => t + 1), DWELL);
            } else if (!entry.isIntersecting && timer) {
                clearInterval(timer);
                timer = 0;
            }
        });
        io.observe(el);
        return () => {
            io.disconnect();
            if (timer) clearInterval(timer);
        };
    }, [faces]);

    // reduced motion gets the words on one line instead of a turning prism
    if (prefersReducedMotion()) {
        return (
            <p className={`${styles.prism} ${styles.prismFlat} ${className}`}>
                {items.map((it) => it.word).join(' · ')}
            </p>
        );
    }

    return (
        <div className={`${styles.prism} ${className}`}>
            <div
                ref={stage}
                className={styles.prismStage}
                style={{ '--radius': `${radiusFor(height, faces)}px` }}
            >
                <ol className={styles.prismCage} style={{ '--spin': `${turn * step}deg` }}>
                    {items.map((it, i) => (
                        <li
                            key={it.word}
                            className={`${styles.prismFace} ${i === live ? styles.prismFaceLive : ''}`}
                            style={{ '--face': `${-i * step}deg` }}
                        >
                            <span className={styles.prismWord}>{it.word}</span>
                            <span className={`label ${styles.prismNote}`}>{it.note}</span>
                        </li>
                    ))}
                </ol>
            </div>
        </div>
    );
}

export default RolePrism;
