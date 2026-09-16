import React from 'react';
import { Link } from 'react-router-dom';
import AsciiField from '../ui/AsciiField';
import styles from './e404.module.css';

function E404() {
    return (
        <section className={`wrap ${styles.lost}`}>
            <div className={styles.lostField}>
                <AsciiField cell={10} fractal="turbulence" scale={8} density={-0.2} contrast={1.15} accentAt={0.93} seed={404} />
            </div>
            <p className="label bracket">Error</p>
            <h1 className={styles.lostCode}>404</h1>
            <p className={styles.lostText}>
                This page doesn’t exist. <Link className="link" to="/">Return to the index</Link>.
            </p>
        </section>
    );
}

export default E404;
