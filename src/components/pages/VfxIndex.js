import React, { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import AsciiField from '../ui/AsciiField';
import VideoField from '../ui/VideoField';
import { VFX_TOOLS } from '../../data/nav';
import styles from './vfx.module.css';

// The ascii card runs the real renderer, so three.js stays out of this
// page's chunk until a card asks for it.
const AsciiEnginePreview = lazy(() => import('../AsciiEnginePreview'));

// What each card shows: a clip of the tool's own output, the live engine, or
// a noise signature for the ones with nothing recorded yet. Clips and the
// engine run by themselves; noise fields only animate on hover.
const PREVIEWS = {
    'blob-tracker': { kind: 'video', clip: 'blob-tracker' },
    'pixel-sorter': { kind: 'video', clip: 'pixel-sorter' },
    ascii: { kind: 'engine' },
    procedural: { kind: 'video', clip: 'procedural' },
    visualizer: {
        kind: 'noise',
        signature: { fractal: 'turbulence', scale: 18, density: 0.05, driftY: 0.3 },
    },
};

const FALLBACK = {
    kind: 'noise',
    signature: { fractal: 'fbm', scale: 9, density: 0 },
};

function Preview({ tool, index, active }) {
    const preview = PREVIEWS[tool.slug] || FALLBACK;
    if (preview.kind === 'video') {
        return (
            <VideoField
                src={`/VfxVids/${preview.clip}.mp4`}
                poster={`/VfxVids/${preview.clip}.jpg`}
            />
        );
    }
    if (preview.kind === 'engine') {
        return (
            <Suspense fallback={null}>
                <AsciiEnginePreview />
            </Suspense>
        );
    }
    return (
        <AsciiField
            cell={7}
            animate={active}
            fps={20}
            contrast={1.15}
            accentAt={0.97}
            seed={index * 17 + 2}
            {...preview.signature}
        />
    );
}

function ToolCard({ tool, index }) {
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
                    <Preview tool={tool} index={index} active={active} />
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
            <Separator index="04.0" title="Tools" meta="Select an instrument" rows={1} />
            <ol className={`wrap ${styles.cards}`}>
                {VFX_TOOLS.map((tool, i) => (
                    <ToolCard key={tool.slug} tool={tool} index={i + 1} />
                ))}
            </ol>
        </>
    );
}

export default VfxIndex;
