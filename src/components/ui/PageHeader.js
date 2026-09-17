import React from 'react';
import styles from './page.module.css';

// Editorial page opener:
//   [ 02 ]          META / META / META
//   Title(10)
//   aside (optional)               lead paragraph in the right six columns
function PageHeader({ index, title, count, meta = [], lead, aside, children }) {
    return (
        <header className={`wrap ${styles.head}`}>
            <div className={`grid ${styles.metaRow}`}>
                <span className={`label bracket ${styles.metaIndex}`}>{index}</span>
                {meta.map((m) => (
                    <span key={m} className={`label ${styles.metaItem}`}>{m}</span>
                ))}
            </div>
            <h1 className={styles.title}>
                {title}
                {count !== undefined && <sup className={styles.count}>({count})</sup>}
            </h1>
            {(lead || children) && (
                <div className={`grid ${styles.leadRow}`}>
                    {aside && <div className={styles.aside}>{aside}</div>}
                    <div className={styles.lead}>
                        {lead && <p>{lead}</p>}
                        {children}
                    </div>
                </div>
            )}
        </header>
    );
}

export default PageHeader;
