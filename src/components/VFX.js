import React, { useState } from 'react';
import AsciiTool from './AsciiTool';
import BlobTracker from './BlobTracker';
import styles from './vfx.module.css';

const TOOLS = [
    { id: 'blob', name: 'Blob Tracker', render: () => <BlobTracker /> },
    { id: 'ascii', name: 'Ascii', render: () => <AsciiTool /> },
];

// VFX tools page: a fixed tool switcher (top-left, clear of the MenuBar)
// and the active tool filling the rest of the viewport.
function VFX() {
    const [toolId, setToolId] = useState('blob');
    const tool = TOOLS.find((t) => t.id === toolId);

    return (
        <div className={styles.vfx} style={{ height: 'auto', minHeight: '100vh', overflow: 'visible' }}>
            <div
                className={styles.vfx_segRow}
                style={{
                    position: 'fixed',
                    top: 'calc(4vh + 18px)',
                    left: 18,
                    zIndex: 30,
                    gridTemplateColumns: `repeat(${TOOLS.length}, auto)`,
                    marginBottom: 0,
                }}
            >
                {TOOLS.map((t) => (
                    <button
                        type="button"
                        key={t.id}
                        className={`${styles.vfx_segBtn} ${toolId === t.id ? styles.vfx_segBtnOn : ''}`}
                        style={{ padding: '8px 14px' }}
                        onClick={() => setToolId(t.id)}
                    >
                        {t.name}
                    </button>
                ))}
            </div>

            {tool.render()}
        </div>
    );
}

export default VFX;
