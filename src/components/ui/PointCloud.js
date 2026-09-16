import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { subscribe, prefersReducedMotion } from '../../lib/ticker';
import styles from './ui.module.css';

// Slowly orbiting coloured point cloud (the old contact page backdrop), now
// contained in a frame: capped DPR, 30fps, paused when off screen.
function PointCloud({ url, fps = 30, onProgress }) {
    const canvasRef = useRef(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        const reduced = prefersReducedMotion();
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
        renderer.setClearColor(0x000000, 1);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);
        camera.rotation.order = 'YXZ';
        const material = new THREE.PointsMaterial({ size: 0.009, vertexColors: true });
        const st = { t: 0, last: null, unsub: null, visible: false, points: null };

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
            renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
            camera.aspect = rect.width / Math.max(1, rect.height);
            camera.updateProjectionMatrix();
        };

        const draw = () => {
            // same slow drift as the original backdrop
            const t = st.t * 0.3;
            camera.rotation.y = -Math.PI / 2.3 - st.t * 0.012;
            camera.position.x = 0.2 * Math.sin(t);
            camera.position.z = -0.21 * Math.cos(t);
            renderer.render(scene, camera);
        };

        const tick = (now) => {
            if (st.last !== null) st.t += Math.min(0.1, now - st.last);
            st.last = now;
            draw();
        };

        const sync = () => {
            const run = st.visible && st.points && !reduced;
            if (run && !st.unsub) {
                st.last = null;
                st.unsub = subscribe(tick, fps);
            } else if (!run && st.unsub) {
                st.unsub();
                st.unsub = null;
            }
        };

        let disposed = false;
        new PLYLoader().load(
            url,
            (geometry) => {
                if (disposed) {
                    geometry.dispose();
                    return;
                }
                const points = new THREE.Points(geometry, material);
                points.rotateX(-Math.PI / 2);
                scene.add(points);
                st.points = points;
                setLoaded(true);
                draw();
                sync();
            },
            (xhr) => {
                if (onProgress && xhr.total) onProgress(xhr.loaded / xhr.total);
            },
        );

        resize();
        const ro = new ResizeObserver(() => { resize(); draw(); });
        ro.observe(canvas);
        const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; sync(); });
        io.observe(canvas);

        return () => {
            disposed = true;
            ro.disconnect();
            io.disconnect();
            if (st.unsub) st.unsub();
            if (st.points) st.points.geometry.dispose();
            material.dispose();
            renderer.dispose();
            renderer.forceContextLoss();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, fps]);

    return (
        <canvas
            ref={canvasRef}
            className={`${styles.field} ${styles.cloud} ${loaded ? styles.cloudLoaded : ''}`}
            aria-hidden="true"
        />
    );
}

export default PointCloud;
