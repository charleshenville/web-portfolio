import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import AsciiField from '../ui/AsciiField';
import Frame from '../ui/Frame';
import Separator from '../ui/Separator';
import items from '../projectitems.json';
import { VFX_TOOLS, SITE_VERSION } from '../../data/nav';
import { HERO_FIELD } from '../../data/frameStyle';
import styles from './home.module.css';

const pad = (n) => String(n).padStart(2, '0');

const DIRECTORY = [
    { to: '/projects', title: 'Projects', note: 'Hardware, software, hackathons' },
    { to: '/music', title: 'Music', note: 'Discography' },
    { to: '/vfx', title: 'VFX Tools', note: `${VFX_TOOLS.length} browser tools` },
    { to: '/resume', title: 'Resume', note: 'Experience, education, skills' },
    { to: '/contact', title: 'Contact', note: 'Say hello' },
];

// freeform rhythm for the gallery: widths and vertical drops per item
const GALLERY_WIDTHS = [150, 118, 176, 132, 104, 160, 124, 144, 112, 168];
const GALLERY_DROPS = [0, 36, 12, 52, 20, 4, 44, 16, 60, 28];

const ROLES = [
    { word: 'Developer', note: 'React, three.js, Python, C/C++, k8s, Distributed Systems' },
    { word: 'Engineer', note: 'FPGAs, Embedded Systems, PCBs, ROS' },
    { word: 'Creator', note: 'Generative art, procedural visuals, Davinci Resolve' },
    { word: 'Musician', note: 'FL Studio and Ableton Live' },
    { word: 'Designer', note: 'UI/UX, branding, illustration, Figma' },
];

function Home() {
    const [heroHover, setHeroHover] = useState(false);
    const { persistent: heroPersistent, ...heroField } = HERO_FIELD;

    return (
        <>
            {/* ---- Hero ---- */}
            <section className={`wrap ${styles.hero}`}>
                <div className={`grid ${styles.heroMeta}`}>
                    <span className="label bracket">Portfolio {SITE_VERSION}</span>
                    <span className="label">Computer Engineer<br />University of Toronto</span>
                    <span className="label">43.6629° N<br />79.3957° W</span>
                    <span className={`label ${styles.alignRight}`}>Scroll ↓</span>
                </div>

                <div
                    className={styles.heroField}
                    onPointerEnter={() => setHeroHover(true)}
                    onPointerLeave={() => setHeroHover(false)}
                >
                    <AsciiField {...heroField} interactive animate={heroPersistent || heroHover} />
                    <span className={`label ${styles.fig}`}>
                        {heroField.fractal} noise, {heroField.octaves} octaves{heroPersistent ? ', live' : ''}
                    </span>
                </div>

                <h1 className={styles.name}>
                    <span>Charles</span>
                    <span>Henville<span className={styles.stop}>.</span></span>
                </h1>
            </section>

            {/* ---- About ---- */}
            <Separator index="01" title="About" meta="Toronto, Canada" rows={1} />
            <section className={`wrap grid ${styles.about}`}>
                <p className={styles.statement}>
                    I’m Charles, a computer engineer at the University of Toronto. I’m passionate
                    about data, automation, music, design, machine learning, and more recently, robotics.
                    I like making things that I think are cool or useful, and we should connect if you think we could do something like that together.
                </p>

                <div className={styles.portrait}>
                    <Frame>
                        <img
                            className={styles.headshot}
                            src="assets/headshot.webp"
                            alt="Portrait of Charles Henville"
                            loading="lazy"
                            decoding="async"
                        />
                    </Frame>
                </div>

                <ol className={styles.roles}>
                    {ROLES.map((r, i) => (
                        <li key={r.word} className={styles.role}>
                            <span className="label">{pad(i + 1)}</span>
                            <span className={styles.roleWord}>{r.word}</span>
                            <span className={styles.roleNote}>{r.note}</span>
                        </li>
                    ))}
                </ol>
            </section>

            {/* ---- Work: a small freeform gallery ---- */}
            {/* <Separator index="02" title="Work" meta={<Link className="link" to="/projects">All projects →</Link>} rows={1} />
            <section className="wrap" aria-label="Projects">
                <ul className={styles.gallery}>
                    {items.map((item, i) => (
                        <li key={item.id} className={styles.piece} style={{ '--w': `${GALLERY_WIDTHS[i % GALLERY_WIDTHS.length]}px`, '--dy': `${GALLERY_DROPS[i % GALLERY_DROPS.length]}px` }}>
                            <a href={item.repo} target="_blank" rel="noreferrer" className={styles.pieceLink}>
                                <Frame variant="gallery">
                                    <img className={styles.pieceImg} src={item.thumb} alt="" loading="lazy" decoding="async" />
                                </Frame>
                                <span className={styles.pieceTitle}>{item.name}</span>
                                <span className="label">{item.date}</span>
                            </a>
                        </li>
                    ))}
                </ul>
            </section> */}

            {/* ---- Directory ---- */}
            <Separator index="02" title="Directory" meta={`${DIRECTORY.length} sections`} rows={1} />
            <nav className="wrap" aria-label="Directory">
                <ol className={styles.directory}>
                    {DIRECTORY.map((d, i) => (
                        <li key={d.to}>
                            <Link to={d.to} className={styles.dirRow}>
                                <span className="label">{pad(i + 1)}</span>
                                <span className={styles.dirTitle}>{d.title}</span>
                                <span className={styles.dirNote}>{d.note}</span>
                                <span className={styles.dirArrow} aria-hidden="true">→</span>
                            </Link>
                        </li>
                    ))}
                </ol>
            </nav>
        </>
    );
}

export default Home;
