import React, { useState } from 'react';
import AsciiField from './AsciiField';
import { FRAME_STYLE, FRAME_VARIANTS } from '../../data/frameStyle';
import styles from './ui.module.css';

// Media frame: a dithered noise field over the edges of the media that spills
// inward, thinning out towards the centre. By default it fades in and animates
// only while hovered (nothing is drawn before the first hover); with
// `persistent` it is always shown and animating while on screen.
//
// The look comes from src/data/frameStyle.js. `variant` picks a preset there,
// and any other props (palette, dither, cell, scale, ...) override it here.
function Frame({
    children,
    caption,
    variant,
    className = '',
    innerClassName = '',
    ...overrides
}) {
    const [active, setActive] = useState(false);
    const [armed, setArmed] = useState(false);
    const on = () => {
        setArmed(true);
        setActive(true);
    };
    const off = () => setActive(false);

    const { bleed, fadeIn, fadeOut, persistent, ...field } = {
        ...FRAME_STYLE,
        ...(variant ? FRAME_VARIANTS[variant] : null),
        ...overrides,
    };
    // persistent frames are always shown and animating; others follow hover
    const shown = persistent || active;
    const spillStyle = {
        '--fade-in': `${fadeIn}ms`,
        '--fade-out': `${fadeOut}ms`,
        ...(bleed ? { inset: -bleed } : null),
    };

    return (
        <figure
            className={`${styles.frame} ${shown ? styles.frameActive : ''} ${className}`}
            onPointerEnter={on}
            onPointerLeave={off}
            onFocus={on}
            onBlur={off}
        >
            <div className={styles.frameBox}>
                <div className={`${styles.frameInner} ${innerClassName}`}>{children}</div>
                <div className={styles.spill} style={spillStyle} aria-hidden="true">
                    {(persistent || armed) && (
                        <AsciiField
                            {...field}
                            render="pixels"
                            mode="spill"
                            animate={shown}
                        />
                    )}
                </div>
            </div>
            {caption && <figcaption className={`label ${styles.caption}`}>{caption}</figcaption>}
        </figure>
    );
}

export default Frame;
