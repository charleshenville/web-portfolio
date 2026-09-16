import React, { useRef } from 'react';
import Frame from './ui/Frame';
import styles from './projects.module.css';

// Featured project: framed thumbnail that swaps to its demo video on hover.
// Videos use preload="none", so nothing streams until someone hovers.
function ProjectTile({ item, index, likes }) {
    const videoRef = useRef(null);
    const isLiked = likes && likes.liked.includes(item.id);

    const play = () => {
        const v = videoRef.current;
        if (v) v.play().catch(() => {});
    };
    const pause = () => {
        const v = videoRef.current;
        if (v) v.pause();
    };

    return (
        <article className={styles.tile} onPointerEnter={play} onPointerLeave={pause}>
            <a href={item.repo} target="_blank" rel="noreferrer" className={styles.tileLink} onFocus={play} onBlur={pause}>
                <Frame variant="project">
                    <div className={styles.media}>
                        <img src={item.thumb} alt="" loading="lazy" decoding="async" />
                        <video ref={videoRef} src={item.vid} muted loop playsInline preload="none" />
                    </div>
                </Frame>
                <h3 className={styles.tileTitle}>{item.name}</h3>
            </a>
            <div className={styles.tileMeta}>
                <span className="label">{index}</span>
                <span className="label" aria-hidden="true">/</span>
                <span className="label">{item.date}</span>
                {likes && (
                    <>
                        <span className="label" aria-hidden="true">/</span>
                        <button
                            type="button"
                            className={`label ${styles.like} ${isLiked ? styles.liked : ''}`}
                            onClick={() => likes.like(item.id)}
                            aria-pressed={isLiked}
                            aria-label={`Like ${item.name}`}
                        >
                            <span className={styles.likeMark} aria-hidden="true" />
                            {likes.counts[item.id] || 0}
                        </button>
                    </>
                )}
            </div>
        </article>
    );
}

export default ProjectTile;
