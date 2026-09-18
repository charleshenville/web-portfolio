import React, { useEffect, useRef, useState } from 'react';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import AsciiField from '../ui/AsciiField';
import Oscilloscope from '../ui/Oscilloscope';
import socials from '../socials.json';
import releases from '../../data/discography.json';
import styles from './music.module.css';

const PROFILES = [
    { name: 'soundcloud', label: 'SoundCloud' },
    { name: 'spotify', label: 'Spotify' },
].map((p) => ({ ...p, ...socials.find((s) => s.name === p.name) })).filter((p) => p.url);

const pad = (n) => String(n).padStart(2, '0');
const hash = (s) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const fmt = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}` : '0:00');
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Arrow keys nudge by a few seconds; page keys and shift jump further.
const STEP = 5;
const BIG_STEP = 15;

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
    const audioCtxRef = useRef(null);
    const [analyser, setAnalyser] = useState(null);
    // The playing track, as `${release.id}#${track index}`.
    const [current, setCurrent] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState({ t: 0, d: 0 });
    // Position being dragged on the progress bar, 0–1, or null when not scrubbing.
    // While it is set the bar and the clock follow the pointer, not the audio.
    const [scrub, setScrub] = useState(null);

    useEffect(() => () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
        }
        if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    }, []);

    const play = (release, index) => {
        const track = release.tracks[index];
        if (!track || !track.audio) return;
        const key = `${release.id}#${index}`;
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
        // The graph is built on the first click so the AudioContext starts
        // inside a user gesture. A media element can only be wired up once.
        if (!audioCtxRef.current && (window.AudioContext || window.webkitAudioContext)) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const node = ctx.createAnalyser();
            node.fftSize = 2048;
            ctx.createMediaElementSource(audio).connect(node);
            node.connect(ctx.destination);
            audioCtxRef.current = ctx;
            setAnalyser(node);
        }
        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
            audioCtxRef.current.resume().catch(() => {});
        }
        if (current === key) {
            if (audio.paused) audio.play().catch(() => {});
            else audio.pause();
            return;
        }
        audio.src = track.audio;
        setCurrent(key);
        setTime({ t: 0, d: 0 });
        setScrub(null);
        audio.play().catch(() => {});
    };

    // Seeking only makes sense once metadata has given us a duration.
    const seekable = () => {
        const audio = audioRef.current;
        return audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio : null;
    };

    const seekTo = (seconds) => {
        const audio = seekable();
        if (!audio) return;
        const t = Math.max(0, Math.min(audio.duration, seconds));
        audio.currentTime = t;
        setTime({ t, d: audio.duration });
    };

    const seekBy = (delta) => {
        const audio = seekable();
        if (audio) seekTo(audio.currentTime + delta);
    };

    const fractionAt = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        return box.width ? clamp01((event.clientX - box.left) / box.width) : 0;
    };

    // A press seeks straight away, then the bar tracks the pointer until release.
    const onScrubDown = (event) => {
        const audio = seekable();
        if (!audio || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const f = fractionAt(event);
        setScrub(f);
        seekTo(f * audio.duration);
    };

    const onScrubMove = (event) => {
        if (scrub === null) return;
        setScrub(fractionAt(event));
    };

    const onScrubUp = (event) => {
        if (scrub === null) return;
        const audio = seekable();
        if (audio) seekTo(fractionAt(event) * audio.duration);
        setScrub(null);
    };

    const onScrubKey = (event) => {
        const audio = seekable();
        if (!audio) return;
        const big = event.shiftKey;
        switch (event.key) {
            case 'ArrowLeft': seekBy(big ? -BIG_STEP : -STEP); break;
            case 'ArrowRight': seekBy(big ? BIG_STEP : STEP); break;
            case 'ArrowDown': seekBy(-STEP); break;
            case 'ArrowUp': seekBy(STEP); break;
            case 'PageDown': seekBy(-BIG_STEP); break;
            case 'PageUp': seekBy(BIG_STEP); break;
            case 'Home': seekTo(0); break;
            case 'End': seekTo(audio.duration); break;
            default: return;
        }
        event.preventDefault();
    };

    const years = releases.map((r) => r.year);
    const trackCount = releases.reduce((n, r) => n + r.tracks.length, 0);

    return (
        <>
            <PageHeader
                index="03"
                title="Music"
                count={trackCount}
                meta={['Discography', 'Original work', `${Math.min(...years)} — ${Math.max(...years)}`]}
                lead="Releases and works in progress. Press play to listen to a preview in the page."
            >
                <div className={styles.profiles}>
                    {PROFILES.map((p) => (
                        <a key={p.name} className={styles.profile} href={p.url} target="_blank" rel="noreferrer">
                            <span>{p.label}</span>
                            <span className="label">↗</span>
                        </a>
                    ))}
                </div>
            </PageHeader>

            <Separator index="03.1" title="Discography" meta={`${trackCount} tracks`} rows={1} />

            <ol className={`wrap ${styles.list}`}>
                {sorted.map((r, i) => {
                    const playingIndex = current && current.startsWith(`${r.id}#`) ? Number(current.split('#')[1]) : -1;
                    const isCurrent = playingIndex >= 0;
                    const isPlaying = isCurrent && playing;
                    const dragging = isCurrent && scrub !== null;
                    // Mid-drag the clock reads the pointer's position, so the
                    // number and the bar agree before the seek lands.
                    const at = dragging ? scrub * time.d : time.t;
                    const progress = isCurrent && time.d ? clamp01(at / time.d) : 0;
                    const headIndex = isCurrent ? playingIndex : 0;
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
                                <div className={styles.titleRow}>
                                    <h2 className={styles.title}>{r.title}</h2>
                                    <div className={styles.scope}>
                                        <Oscilloscope analyser={isCurrent ? analyser : null} active={isPlaying} color={r.scopeColor} />
                                    </div>
                                </div>

                                <ol className={styles.tracks}>
                                    {r.tracks.map((t, k) => {
                                        const on = playingIndex === k;
                                        return (
                                            <li key={t.title} className={on ? styles.trackOn : ''}>
                                                <button
                                                    type="button"
                                                    className={styles.track}
                                                    onClick={() => play(r, k)}
                                                    disabled={!t.audio}
                                                    aria-label={`${on && playing ? 'Pause' : 'Play'} ${t.title}`}
                                                >
                                                    <span className="label">{pad(k + 1)}</span>
                                                    <span className={styles.trackTitle}>{t.title}</span>
                                                    <span className="label">{on ? `${fmt(at)} / ${fmt(time.d)}` : '—'}</span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ol>

                                <div className={styles.actions}>
                                    {r.tracks.some((t) => t.audio) && (
                                        <button
                                            type="button"
                                            className={`${styles.play} ${isPlaying ? styles.playOn : ''}`}
                                            onClick={() => play(r, headIndex)}
                                            aria-label={`${isPlaying ? 'Pause' : 'Play'} ${r.tracks[headIndex].title}`}
                                        >
                                            <span className={isPlaying ? styles.iconPause : styles.iconPlay} aria-hidden="true" />
                                            <span>{isPlaying ? 'Pause' : 'Play'}</span>
                                            <span className="label">{r.tracks[headIndex].title}</span>
                                        </button>
                                    )}
                                    {r.links.map((l) => (
                                        <a key={l.url} className={`label link ${styles.ext}`} href={l.url} target="_blank" rel="noreferrer">
                                            {l.label} ↗
                                        </a>
                                    ))}
                                </div>

                                <div
                                    className={`${styles.scrub} ${isCurrent ? styles.scrubLive : ''} ${dragging ? styles.scrubbing : ''}`}
                                    role="slider"
                                    tabIndex={isCurrent ? 0 : -1}
                                    aria-label={`Seek ${r.tracks[headIndex].title}`}
                                    aria-disabled={!isCurrent || !time.d}
                                    aria-valuemin={0}
                                    aria-valuemax={Math.round(time.d) || 0}
                                    aria-valuenow={isCurrent ? Math.round(at) || 0 : 0}
                                    aria-valuetext={isCurrent ? `${fmt(at)} of ${fmt(time.d)}` : 'Not playing'}
                                    onPointerDown={isCurrent ? onScrubDown : undefined}
                                    onPointerMove={isCurrent ? onScrubMove : undefined}
                                    onPointerUp={isCurrent ? onScrubUp : undefined}
                                    onPointerCancel={isCurrent ? onScrubUp : undefined}
                                    onKeyDown={isCurrent ? onScrubKey : undefined}
                                >
                                    <div className={styles.progress}>
                                        <span style={{ transform: `scaleX(${progress})` }} />
                                        <i className={styles.knob} style={{ left: `${progress * 100}%` }} />
                                    </div>
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
