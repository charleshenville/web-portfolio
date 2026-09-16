import React, { useEffect, useRef, useState } from 'react';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import AsciiField from '../ui/AsciiField';
import releases from '../../data/discography.json';
import styles from './music.module.css';

const pad = (n) => String(n).padStart(2, '0');
const hash = (s) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const fmt = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}` : '0:00');

// Album art, or a procedural cover seeded by the title when none is set.
// Generated covers only animate while their release is playing.
function Cover({ release, playing }) {
    if (release.art) {
        return <img className={styles.art} src={release.art} alt={`${release.title} cover art`} loading="lazy" decoding="async" />;
    }
    const seed = Math.abs(hash(release.id));
    return (
        <div className={styles.generated} role="img" aria-label={`${release.title} generated cover`}>
            <AsciiField
                animate={playing}
                cell={7}
                fps={24}
                seed={seed}
                fractal={['fbm', 'ridged', 'turbulence'][seed % 3]}
                scale={5 + (seed % 9)}
                density={-0.22}
                contrast={1.25}
                accentAt={0.96}
            />
            <span className={styles.coverTitle}>{release.title}</span>
            <span className={`label ${styles.coverMark}`}>CMH</span>
        </div>
    );
}

function Music() {
    const sorted = [...releases].sort((a, b) => b.year - a.year);
    const audioRef = useRef(null);
    const [current, setCurrent] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState({ t: 0, d: 0 });

    useEffect(() => () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
        }
    }, []);

    const toggle = (release) => {
        let audio = audioRef.current;
        if (!audio) {
            audio = new Audio();
            audio.preload = 'none';
            audio.addEventListener('timeupdate', () => setTime({ t: audio.currentTime, d: audio.duration }));
            audio.addEventListener('play', () => setPlaying(true));
            audio.addEventListener('pause', () => setPlaying(false));
            audio.addEventListener('ended', () => setPlaying(false));
            audioRef.current = audio;
        }
        if (current === release.id) {
            if (audio.paused) audio.play().catch(() => {});
            else audio.pause();
            return;
        }
        audio.src = release.audio;
        setCurrent(release.id);
        setTime({ t: 0, d: 0 });
        audio.play().catch(() => {});
    };

    const years = releases.map((r) => r.year);

    return (
        <>
            <PageHeader
                index="03"
                title="Music"
                count={releases.length}
                meta={['Discography', 'Original work', `${Math.min(...years)} — ${Math.max(...years)}`]}
                lead="Releases and works in progress. Press play to listen to a preview in the page."
            />

            <Separator index="03.1" title="Discography" meta={`${releases.length} releases`} rows={2} />

            <ol className={`wrap ${styles.list}`}>
                {sorted.map((r, i) => {
                    const isCurrent = current === r.id;
                    const isPlaying = isCurrent && playing;
                    const progress = isCurrent && time.d ? time.t / time.d : 0;
                    return (
                        <li key={r.id} className={`${styles.release} ${isCurrent ? styles.releaseCurrent : ''}`}>
                            <div className={styles.cover}>
                                <Cover release={r} playing={isPlaying} />
                            </div>

                            <div className={styles.info}>
                                <div className={styles.infoTop}>
                                    <span className="label">{pad(sorted.length - i)}</span>
                                    <span className="label">{r.type}</span>
                                    <span className="label">{r.year}</span>
                                </div>
                                <h2 className={styles.title}>{r.title}</h2>

                                <ol className={styles.tracks}>
                                    {r.tracks.map((t, k) => (
                                        <li key={t}>
                                            <span className="label">{pad(k + 1)}</span>
                                            <span>{t}</span>
                                        </li>
                                    ))}
                                </ol>

                                <div className={styles.actions}>
                                    {r.audio && (
                                        <button
                                            type="button"
                                            className={`${styles.play} ${isPlaying ? styles.playOn : ''}`}
                                            onClick={() => toggle(r)}
                                            aria-label={`${isPlaying ? 'Pause' : 'Play'} ${r.title}`}
                                        >
                                            <span className={isPlaying ? styles.iconPause : styles.iconPlay} aria-hidden="true" />
                                            <span>{isPlaying ? 'Pause' : 'Play'}</span>
                                            <span className="label">{isCurrent ? `${fmt(time.t)} / ${fmt(time.d)}` : 'Preview'}</span>
                                        </button>
                                    )}
                                    {r.links.map((l) => (
                                        <a key={l.url} className={`label link ${styles.ext}`} href={l.url} target="_blank" rel="noreferrer">
                                            {l.label} ↗
                                        </a>
                                    ))}
                                </div>

                                <div className={styles.progress} aria-hidden="true">
                                    <span style={{ transform: `scaleX(${progress})` }} />
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </>
    );
}

export default Music;
