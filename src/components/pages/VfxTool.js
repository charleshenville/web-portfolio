import React, { Suspense, lazy } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import Loading from '../ui/Loading';
import { VFX_TOOLS } from '../../data/nav';
import styles from './vfx.module.css';

// Each tool is its own chunk; only the one being opened is downloaded.
const TOOLS = {
    'blob-tracker': lazy(() => import('../BlobTracker')),
    'pixel-sorter': lazy(() => import('../PixelSorter')),
    ascii: lazy(() => import('../AsciiTool')),
    procedural: lazy(() => import('../ProceduralAscii')),
    visualizer: lazy(() => import('../AudioVisualizer')),
};

function VfxTool() {
    const { slug } = useParams();
    const Tool = TOOLS[slug];
    const tool = VFX_TOOLS.find((t) => t.slug === slug);
    if (!Tool || !tool) return <Navigate to="/vfx" replace />;

    return (
        <div className={styles.shell}>
            <h1 className="visually-hidden">{tool.label}</h1>
            <Suspense fallback={<Loading fullscreen />}>
                <Tool key={slug} />
            </Suspense>
        </div>
    );
}

export default VfxTool;
