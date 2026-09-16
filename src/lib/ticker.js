// One requestAnimationFrame loop shared by every procedural surface on the
// page. Each subscriber runs at its own frame rate, and the loop stops
// entirely while nothing is subscribed (e.g. every field is off screen).

const subscribers = new Set();
let raf = 0;

function loop(now) {
    raf = 0;
    subscribers.forEach((sub) => {
        if (now - sub.last >= sub.interval) {
            // keep cadence stable instead of drifting by the frame overshoot
            sub.last = now - ((now - sub.last) % sub.interval);
            sub.cb(now / 1000);
        }
    });
    if (subscribers.size) raf = requestAnimationFrame(loop);
}

export function subscribe(cb, fps = 30) {
    const sub = { cb, interval: 1000 / fps, last: 0 };
    subscribers.add(sub);
    if (!raf) raf = requestAnimationFrame(loop);
    return () => {
        subscribers.delete(sub);
        if (!subscribers.size && raf) {
            cancelAnimationFrame(raf);
            raf = 0;
        }
    };
}

export const prefersReducedMotion = () =>
    typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
