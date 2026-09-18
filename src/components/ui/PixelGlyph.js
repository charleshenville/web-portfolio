import React from 'react';
import styles from './ui.module.css';

// A pixel-art chevron that hops in discrete steps.
//
// Every pixel is a whole <rect> and the hop uses a stepped timing function, so
// nothing about it ever lands on a half pixel — that jitter is the point, and
// it is what ties the mark to the rest of the page's blocky language.
//
// Colour comes from `currentColor`, so it takes the hover and focus states of
// whatever it sits in. `delayMs` offsets the hop, so a pair of glyphs does not
// move in lockstep.

const GLYPH = [
    '....#....',
    '....#....',
    '....#....',
    '.#..#..#.',
    '..#.#.#..',
    '...###...',
    '....#....',
];

const CELL = 8;

function PixelGlyph({ className = '', delayMs = 0, flip = false }) {
    const cols = GLYPH[0].length;

    return (
        <span
            aria-hidden="true"
            className={`${styles.pixelHop} ${className}`}
            style={{ animationDelay: `${delayMs}ms`, '--cell': `${CELL}px` }}
        >
            <svg
                width={cols * CELL}
                height={GLYPH.length * CELL}
                viewBox={`0 0 ${cols * CELL} ${GLYPH.length * CELL}`}
                fill="currentColor"
                shapeRendering="crispEdges"
                style={flip ? { transform: 'scaleX(-1)' } : undefined}
            >
                {GLYPH.flatMap((row, y) => row.split('').map((cell, x) => (
                    cell === '#'
                        ? <rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL} height={CELL} />
                        : null
                )))}
            </svg>
        </span>
    );
}

export default PixelGlyph;
