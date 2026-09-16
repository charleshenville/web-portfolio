import React, { useRef, useState } from 'react';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import ProjectTile from '../ProjectTile';
import useLikes from '../../lib/useLikes';
import items from '../projectitems.json';
import styles from '../projects.module.css';

const pad = (n) => String(n).padStart(2, '0');

function Projects() {
    const likes = useLikes();
    const featured = items.filter((i) => i.isFeatured);
    const archive = items.filter((i) => !i.isFeatured);
    const years = items.map((i) => Number(i.date));
    const span = `${Math.min(...years)} — ${Math.max(...years)}`;

    // one shared floating thumbnail for the archive list
    const previewRef = useRef(null);
    const [preview, setPreview] = useState(null);
    const [previewOn, setPreviewOn] = useState(false);
    const movePreview = (e) => {
        const el = previewRef.current;
        if (el) el.style.transform = `translate(${e.clientX + 24}px, ${e.clientY - 90}px)`;
    };

    return (
        <>
            <PageHeader
                index="02"
                title="Projects"
                count={items.length}
                meta={['Hardware / Software', 'Hackathons & coursework', span]}
                lead="Renderers on FPGAs, embedded physics, IoT sensors and web experiments. Hover a piece to play its demo."
            />

            <Separator index="02.1" title="Featured" meta={`${featured.length} works`} />
            <section className="wrap grid" aria-label="Featured projects">
                <div className={`grid ${styles.featured}`} style={{ gridColumn: '1 / -1' }}>
                    {featured.map((item, i) => (
                        <ProjectTile key={item.id} item={item} index={pad(i + 1)} likes={likes} />
                    ))}
                </div>
            </section>

            <Separator index="02.2" title="Archive" meta={`${archive.length} works`} rows={2} />
            <section className="wrap" aria-label="Project archive" onPointerMove={movePreview}>
                <div className={styles.archive} role="table">
                    <div className={styles.archiveHead} role="row">
                        <span className="label" role="columnheader">No.</span>
                        <span className="label" role="columnheader">Title</span>
                        <span className="label" role="columnheader">Description</span>
                        <span className="label" role="columnheader">Year</span>
                        <span className={`label ${styles.right}`} role="columnheader">Link</span>
                    </div>
                    {archive.map((item, i) => (
                        <a
                            key={item.id}
                            role="row"
                            href={item.repo}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.archiveRow}
                            onPointerEnter={() => { setPreview(item.thumb); setPreviewOn(true); }}
                            onPointerLeave={() => setPreviewOn(false)}
                        >
                            <span className="label" role="cell">{pad(featured.length + i + 1)}</span>
                            <span className={styles.archiveTitle} role="cell">{item.name}</span>
                            <span className={styles.desc} role="cell">{item.desc}</span>
                            <span className="label" role="cell">{item.date}</span>
                            <span className={`label ${styles.right}`} role="cell">↗</span>
                        </a>
                    ))}
                </div>
            </section>

            <div
                ref={previewRef}
                className={`${styles.preview} ${previewOn ? styles.previewOn : ''}`}
                style={preview ? { backgroundImage: `url(${preview})` } : undefined}
                aria-hidden="true"
            />
        </>
    );
}

export default Projects;
