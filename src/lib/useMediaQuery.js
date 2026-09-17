import { useEffect, useState } from 'react';

// Subscribes to a media query and re-renders on change. Used where a layout
// swap has to happen in markup rather than in CSS, e.g. mounting the compact
// role prism only on the narrow layout instead of rendering both.
export default function useMediaQuery(query) {
    const [matches, setMatches] = useState(
        () => typeof window !== 'undefined'
            && !!window.matchMedia
            && window.matchMedia(query).matches,
    );

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined;
        const mq = window.matchMedia(query);
        const onChange = () => setMatches(mq.matches);
        onChange();
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [query]);

    return matches;
}
