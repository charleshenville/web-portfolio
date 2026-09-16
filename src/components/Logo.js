import React from 'react';
import styles from './logo.module.css';

// cmh wordmark, drawn on an isometric plane. On hover / focus stacked blue
// silhouettes slide down linearly beneath the face, extruding the mark into
// a solid isometric shape.

export const LOGO_PATH = 'M130.738 26.1963L125.601 29.1616L105.353 17.4726L88.2583 27.3415L109.128 39.3895L103.985 42.3585L69.5092 22.4555L69.0677 22.7104L89.3652 50.7986L81.7536 55.1928L47.2776 35.2898L46.8361 35.5446L58.7883 52.0802L58.8007 52.073C60.6882 54.5458 61.4391 55.6232 62.1774 57.3109C62.9157 58.9985 63.1198 60.6828 62.7806 62.362C62.4263 64.0327 61.5704 65.6463 60.2124 67.1977C58.8685 68.7408 57.0474 70.1735 54.7586 71.495C50.8895 73.7286 46.5027 75.1691 41.6 75.8173C36.6962 76.4654 31.6344 76.2828 26.4204 75.2681C21.2069 74.2533 16.2063 72.3655 11.4211 69.603C6.63579 66.8404 3.36578 63.9538 1.60814 60.9439C-0.149556 57.9339 -0.465872 55.0117 0.656687 52.1807C1.77966 49.3506 4.275 46.8178 8.1439 44.5843C10.433 43.263 12.9146 42.2117 15.5876 41.4359C18.2751 40.6518 21.08 40.1636 23.9889 39.9675C26.8823 39.7634 29.7907 39.8753 32.7136 40.3014C35.6232 40.7193 38.455 41.4798 41.2021 42.5882L35.7048 45.7618C33.7996 45.0371 31.843 44.5619 29.8344 44.3402C27.8404 44.1099 25.8601 44.0974 23.8956 44.2935C21.9313 44.4726 20.0448 44.8401 18.2429 45.4028C16.442 45.9654 14.7925 46.684 13.2867 47.5532C10.5397 49.1391 8.7372 50.9751 7.89515 53.0639C7.0683 55.1437 7.35373 57.3439 8.74089 59.6623C10.144 61.973 12.8093 64.2655 16.738 66.5336C20.667 68.8018 24.6376 70.3403 28.6405 71.1503C32.6569 71.9513 36.4672 72.116 40.0703 71.6386C43.6888 71.1525 46.8749 70.1156 49.6221 68.5296C51.1277 67.6603 52.3663 66.7045 53.3408 65.6648C54.3153 64.6248 54.9622 63.541 55.2872 62.4158C55.6122 61.2732 55.5803 60.1242 55.1815 58.973C54.79 57.8261 54.668 57.1532 53.4527 55.2969L34.9586 29.815L41.5192 26.0275L79.1853 47.7722L79.4403 47.625L57.1901 16.9807L63.7508 13.1933L83.3891 24.5305L100.484 14.6616L80.2239 2.96535L85.3604 0L130.738 26.1963Z';

const WIDTH = 131;
const HEIGHT = 77;
const DEPTH = 24;      // extrusion depth in viewBox units
const LAYERS = 24;     // ~1 unit apart, so the walls read as one solid

// Every layer eases linearly over the same duration, so at any moment they
// are spread evenly from 0 to the current depth: a continuous solid wall.
const layers = Array.from({ length: LAYERS }, (_, k) => {
    const j = LAYERS - k; // paint deepest first
    return { key: j, offset: (DEPTH * j) / LAYERS };
});

function Logo({ className = '', title = 'Charles Miguel Henville' }) {
    return (
        <svg
            className={`${styles.logo} ${className}`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT + DEPTH}`}
            role="img"
            aria-label={title}
        >
            <defs>
                <path id="cmh-mark" d={LOGO_PATH} />
            </defs>
            {layers.map((l) => (
                <use
                    key={l.key}
                    href="#cmh-mark"
                    className={styles.layer}
                    style={{ '--y': `${l.offset}px` }}
                />
            ))}
            <use href="#cmh-mark" className={styles.face} />
        </svg>
    );
}

export default Logo;
