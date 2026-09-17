import React, { useEffect, useRef } from 'react';
import styles from './ui.module.css';

// Time-domain trace of an AnalyserNode. With no analyser (or when inactive)
// it rests as a flat line and stops its animation loop.
function Oscilloscope({ analyser = null, active = false, color = '#fff', lineWidth = 1, className = '' }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const ctx = canvas.getContext('2d');
        const data = analyser ? new Uint8Array(analyser.fftSize) : null;
        let raf = 0;

        const draw = () => {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.round(canvas.clientWidth * dpr);
            const h = Math.round(canvas.clientHeight * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            ctx.clearRect(0, 0, w, h);
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth * dpr;
            ctx.lineJoin = 'round';
            ctx.beginPath();

            if (active && data) {
                analyser.getByteTimeDomainData(data);
                const step = w / (data.length - 1);
                for (let i = 0; i < data.length; i++) {
                    const y = (data[i] / 255) * h;
                    if (i === 0) ctx.moveTo(0, y);
                    else ctx.lineTo(i * step, y);
                }
                ctx.stroke();
                raf = requestAnimationFrame(draw);
            } else {
                ctx.moveTo(0, h / 2);
                ctx.lineTo(w, h / 2);
                ctx.stroke();
            }
        };

        draw();
        const ro = new ResizeObserver(() => { if (!raf) draw(); });
        ro.observe(canvas);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [analyser, active, color, lineWidth]);

    return <canvas ref={canvasRef} className={`${styles.scope} ${className}`} aria-hidden="true" />;
}

export default Oscilloscope;
