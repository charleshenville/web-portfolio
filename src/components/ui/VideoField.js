import React, { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../../lib/ticker';
import styles from './ui.module.css';

// A muted, looping clip that fills its (positioned) parent: the recorded
// cousin of AsciiField, for previews of tools whose output can't be faked
// with noise.
//
// Nothing streams until the clip is close to the viewport (preload="none" and
// play() is what starts the download), it pauses again on the way out and
// while the tab is hidden, and a viewer who prefers reduced motion only ever
// gets the poster frame.
function VideoField({ src, poster, className = '', style }) {
    const videoRef = useRef(null);

    useEffect(() => {
        const video = videoRef.current;
        video.muted = true; // belt and braces: autoplay is refused without it
        if (prefersReducedMotion()) return undefined;

        let onScreen = false;
        const sync = () => {
            if (onScreen && !document.hidden) video.play().catch(() => {});
            else video.pause();
        };

        const io = new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
            sync();
        }, { rootMargin: '120px' });
        io.observe(video);
        document.addEventListener('visibilitychange', sync);

        return () => {
            io.disconnect();
            document.removeEventListener('visibilitychange', sync);
        };
    }, []);

    return (
        <video
            ref={videoRef}
            className={`${styles.field} ${styles.videoField} ${className}`}
            style={style}
            src={src}
            poster={poster}
            muted
            loop
            playsInline
            preload="none"
            tabIndex={-1}
            aria-hidden="true"
        />
    );
}

export default VideoField;
