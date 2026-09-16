import React from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import AsciiField from '../ui/AsciiField';
import { VFX_TOOLS } from '../../data/nav';
import styles from './vfx.module.css';

// A distinct noise signature per tool card; they only animate on hover.
const SIGNATURES = [
    { fractal: 'turbulence', scale: 7, density: -0.1 },
    { fractal: 'fbm', scale: 4, density: 0, driftX: 1.4 },
    { fractal: 'ridged', scale: 10, density: -0.3 },
    { fractal: 'fbm', scale: 14, density: -0.05, octaves: 5 },
    { fractal: 'turbulence', scale: 18, density: 0.05, driftY: 0.3 },
];

function ToolCard({ tool, index, signature }) {
    const [active, setActive] = React.useState(false);
    return (
        <li className={styles.card}>
            <Link
                to={`/vfx/${tool.slug}`}
                className={styles.cardLink}
                onPointerEnter={() => setActive(true)}
                onPointerLeave={() => setActive(false)}
                onFocus={() => setActive(true)}
                onBlur={() => setActive(false)}
            >
                <div className={styles.cardField}>
                    <AsciiField cell={7} animate={active} fps={20} contrast={1.15} accentAt={0.97} seed={index * 17 + 2} {...signature} />
                </div>
                <div className={styles.cardMeta}>
                    <span className="label">04.{index}</span>
                    <h2 className={styles.cardTitle}>{tool.label}</h2>
                    <p className={styles.cardBlurb}>{tool.blurb}</p>
                    <span className={styles.cardGo} aria-hidden="true">Open →</span>
                </div>
            </Link>
        </li>
    );
}

function VfxIndex() {
    return (
        <>
            <PageHeader
                index="04"
                title="VFX"
                count={VFX_TOOLS.length}
                meta={['Browser tools', 'Canvas / WebGL', 'Runs locally']}
                lead="Small instruments for making images move. Everything runs in your browser; nothing is uploaded."
            />
            <Separator index="04.0" title="Tools" meta="Select an instrument" rows={2} />
            <ol className={`wrap ${styles.cards}`}>
                {VFX_TOOLS.map((tool, i) => (
                    <ToolCard key={tool.slug} tool={tool} index={i + 1} signature={SIGNATURES[i % SIGNATURES.length]} />
                ))}
            </ol>
        </>
    );
}

export default VfxIndex;
