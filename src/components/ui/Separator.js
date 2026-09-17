import React from 'react';
import AsciiField from './AsciiField';
import styles from './ui.module.css';

// Section divider: hairline, a mono index row, then a thin procedural band.
//   [ 02 ]  Selected Work ..................................... 2022 — 2024
//   ░░▒▒▓▓▒▒░░ (noise band)
function Separator({ index, title, meta, rows = 1, cell = 7, band = {}, id }) {
    return (
        <div className={styles.separator} id={id}>
            <div className={`wrap ${styles.sepHead}`}>
                {index && <span className="label bracket">{index}</span>}
                {title && <h2 className={styles.sepTitle}>{title}</h2>}
                {meta && <span className={`label ${styles.sepMeta}`}>{meta}</span>}
            </div>
            <div className={styles.sepBand} style={{ height: `${rows * cell * 1.8}px` }}>
                <AsciiField
                    cell={cell}
                    fadeX
                    density={-0.12}
                    contrast={1.15}
                    accentAt={0.985}
                    seed={(title || index || 'x').length * 7 + rows}
                    ramp="░▒▓"
                    {...band}
                />
            </div>
        </div>
    );
}

export default Separator;
