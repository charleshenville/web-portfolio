import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { subscribe, prefersReducedMotion } from '../../lib/ticker';
import styles from './ui.module.css';

// A glTF model rendered to a tiny offscreen WebGL target (one pixel per
// character cell), then drawn as glyphs on a 2D canvas. Much cheaper than
// the DOM-table AsciiEffect: one readPixels of a few thousand pixels and one
// fillText per row. Pauses off screen.

const FONT_STACK = '"SF Mono", ui-monospace, Menlo, Monaco, monospace';
const ROW_RATIO = 1.8;
const DEFAULT_SPIN = [0, 0.35, 0.14];

function AsciiModel({ url, ramp = ' .:-=+*#%@', cell = 7, fps = 24, spin = DEFAULT_SPIN, className = '' }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const chars = Array.from(ramp);
        const reduced = prefersReducedMotion();

        const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
        renderer.setPixelRatio(1);
        const target = new THREE.WebGLRenderTarget(1, 1);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);
        const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
        camera.position.set(0, 0, 6);
        const key = new THREE.DirectionalLight(0xffffff, 1.4);
        key.position.set(3, 4, 5);
        const rim = new THREE.DirectionalLight(0xffffff, 0.5);
        rim.position.set(-4, -2, -3);
        scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.12));

        const st = { cols: 1, rows: 1, W: 1, H: 1, dpr: 1, cw: cell, ch: cell * ROW_RATIO, fontSize: 12, pixels: new Uint8Array(4), model: null, t: 0, last: null, unsub: null, visible: false, ink: '#ecebe6' };

        const measure = () => {
            const rect = canvas.getBoundingClientRect();
            st.W = Math.max(1, rect.width);
            st.H = Math.max(1, rect.height);
            st.dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(st.W * st.dpr);
            canvas.height = Math.round(st.H * st.dpr);
            st.cols = Math.max(1, Math.floor(st.W / st.cw));
            st.rows = Math.max(1, Math.floor(st.H / st.ch));
            target.setSize(st.cols, st.rows);
            renderer.setSize(st.cols, st.rows, false);
            st.pixels = new Uint8Array(st.cols * st.rows * 4);
            // cells are taller than wide; squash the projection to match
            camera.aspect = (st.cols * st.cw) / (st.rows * st.ch);
            camera.updateProjectionMatrix();
            ctx.font = `100px ${FONT_STACK}`;
            st.fontSize = st.cw / ((ctx.measureText('M').width / 100) || 0.6);
            st.ink = getComputedStyle(canvas).color || st.ink;
        };

        const draw = () => {
            if (st.model) {
                st.model.rotation.x = Math.PI / 2 + spin[0] * st.t;
                st.model.rotation.y = spin[1] * st.t;
                st.model.rotation.z = spin[2] * st.t;
            }
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            renderer.readRenderTargetPixels(target, 0, 0, st.cols, st.rows, st.pixels);
            renderer.setRenderTarget(null);

            ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
            ctx.clearRect(0, 0, st.W, st.H);
            ctx.font = `${st.fontSize}px ${FONT_STACK}`;
            ctx.textBaseline = 'middle';
            ctx.fillStyle = st.ink;
            const x0 = (st.W - st.cols * st.cw) / 2;
            const y0 = (st.H - st.rows * st.ch) / 2;
            const top = chars.length - 1;
            for (let r = 0; r < st.rows; r++) {
                // render targets are bottom-up
                const base = (st.rows - 1 - r) * st.cols * 4;
                let line = '';
                let any = false;
                for (let c = 0; c < st.cols; c++) {
                    const i = base + c * 4;
                    const lum = (0.3 * st.pixels[i] + 0.59 * st.pixels[i + 1] + 0.11 * st.pixels[i + 2]) / 255;
                    // lift midtones so lit faces use the whole ramp
                    const q = Math.min(top, ((lum ** 0.75) * 1.25 * chars.length) | 0);
                    if (q) any = true;
                    line += chars[q];
                }
                if (any) ctx.fillText(line, x0, y0 + (r + 0.5) * st.ch);
            }
        };

        const tick = (now) => {
            if (st.last !== null) st.t += Math.min(0.1, now - st.last);
            st.last = now;
            draw();
        };

        const sync = () => {
            const run = st.visible && st.model && !reduced;
            if (run && !st.unsub) {
                st.last = null;
                st.unsub = subscribe(tick, fps);
            } else if (!run && st.unsub) {
                st.unsub();
                st.unsub = null;
            }
        };

        let disposed = false;
        new GLTFLoader().load(url, (gltf) => {
            if (disposed) return;
            const model = gltf.scene;
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3()).length() || 1;
            const center = box.getCenter(new THREE.Vector3());
            const pivot = new THREE.Group();
            model.position.sub(center);
            pivot.add(model);
            pivot.scale.setScalar(4.2 / size);
            model.traverse((o) => {
                if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1 });
            });
            scene.add(pivot);
            st.model = pivot;
            st.t = 2.4;
            draw();
            sync();
        });

        measure();
        const ro = new ResizeObserver(() => { measure(); draw(); });
        ro.observe(canvas);
        const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; sync(); });
        io.observe(canvas);

        return () => {
            disposed = true;
            ro.disconnect();
            io.disconnect();
            if (st.unsub) st.unsub();
            scene.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
            target.dispose();
            renderer.dispose();
            renderer.forceContextLoss();
        };
    }, [url, ramp, cell, fps, spin]);

    return <canvas ref={canvasRef} className={`${styles.field} ${className}`} aria-hidden="true" />;
}

export default AsciiModel;
