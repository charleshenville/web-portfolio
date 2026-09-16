import React from 'react';
import styles from './ui.module.css';

function Loading({ fullscreen = false }) {
    return (
        <div className={`${styles.loading} ${fullscreen ? styles.loadingFull : ''}`} role="status">
            <span className="label bracket">Loading</span>
            <span className={styles.loadingBar} aria-hidden="true" />
        </div>
    );
}

export default Loading;
