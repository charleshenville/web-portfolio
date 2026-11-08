import { createContext, useContext, useEffect, useRef } from 'react';

// What every panel of the compositor reaches for: the project and how to
// change it, the selection, and a per-frame ticker for live readouts (so a
// linked slider's tick can move with the music without re-rendering React).
export const Ctx = createContext(null);
export const useComp = () => useContext(Ctx);

/** Run `fn(t, frame)` every drawn frame while mounted. */
export function useTick(fn) {
    const comp = useComp();
    const ref = useRef(fn);
    ref.current = fn;
    useEffect(() => comp.ticker.add((t, frame) => ref.current(t, frame)), [comp.ticker]);
}

/** A tiny set-of-listeners, used as the ticker. */
export function makeTicker() {
    const fns = new Set();
    return {
        add(fn) { fns.add(fn); return () => fns.delete(fn); },
        run(...args) { fns.forEach((fn) => fn(...args)); },
    };
}
