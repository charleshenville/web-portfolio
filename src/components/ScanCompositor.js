import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    Play, Pause, SlidersHorizontal, X, Download,
    Camera, Trash2, RotateCcw, Save, Plus, Music, Boxes, Spline, Upload,
    PersonStanding, FolderOpen, FileDown, Monitor, Frame, Shapes,
} from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import DreamHazeShader from '../lib/dreamHaze';
import {
    Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget,
} from 'mp4-muxer';
import VfxNumberField from './VfxNumberField';
import useMediaQuery from '../lib/useMediaQuery';
import {
    ASSETS, CURVES, MUSIC_ASSETS, PARAM_GROUPS, GEOM_KEYS, CURVE_GEOM_KEYS,
    fibonacciSphere, makeItem, makeCurveItem, buildPointCloudRecord,
    buildCurveRecord, applyAudioReactivity, applyCloudReactivity,
    applyWireReactivity, buildWireTopology, applyRecordTransform,
    disposeRecord, loadPlyPoints, computeSpectrogram, bandLevel,
    envelopeFollow, applySceneOpacity, recolorPointCloud, sphereColorKey,
    OBJECT_DEFAULTS, CURVE_DEFAULTS, nextInstanceId,
} from '../lib/audioScene';
import { Mp4FrameReader, drainEncoders } from '../lib/mp4Frames';
import {
    ProtagonistModel, makeModelItem, MODEL_DEFAULTS, POSES, JOINTS, LEG_JOINTS,
    BODY_FIELDS, COLOUR_FIELDS, FINISH_FIELDS, TEXTURE_FIELDS, mirrorJoint,
    mirrorAngles, specOf, migrateModelOp,
} from '../lib/protagonist/poser';
import { metalEnvironment } from '../lib/protagonist/rig';
import { kickEnvelope, kickHits, kickLevelAt } from '../lib/protagonist/kicks';
import { bodyDims } from '../lib/protagonist/model';
import { SLOTS, SLOT_INFO } from '../lib/protagonist/parts';
import { RARITIES } from '../lib/protagonist/spec';
import {
    loadLibrary, saveLibrary, downloadLibrary, patchAsset, CATEGORIES, RIGS, DEFAULT_SCREEN,
} from '../lib/scanAssets/library';
import { MOD_DEFAULTS } from '../lib/scanAssets/modulate';
import {
    PropModel, makePropItem, reviveProp, fitCornersToMesh,
} from '../lib/scanAssets/props';
import {
    SackboyModel, makeSackboyItem, reviveSackboy, SACKBOY_DEFAULTS, SACKBOY_POSES,
    SACKBOY_JOINT_MENU,
} from '../lib/scanAssets/sackboy';
import {
    WindowModel, WindowCompositor, makeWindowItem, reviveWindow, cornersFacing, LAYER,
} from '../lib/scanAssets/windows';
import { PUBLIC_VIDEOS, storeUpload, listUploads, deleteUpload } from '../lib/scanAssets/screenVideo';
import {
    MatteSet, HoldoutPass, mattesFor, onMattesChanged,
} from '../lib/scanAssets/roto';
import RotoEditor from './RotoEditor';
import CurveEditor, { placeCurveDot } from './CurveEditor';
import styles from './vfx.module.css';

// Camera poses come from backend/vidtrack: a pose is solved per frame, and
// align.py carries those poses into the GLB's own coordinate frame. So the scan
// sits at the origin untransformed and the camera is what moves. The footage is
// undistorted by the same pipeline, which is what lets a plain pinhole frustum
// line up with it all the way into the corners.
const MANIFEST_URL = `${process.env.PUBLIC_URL}/mv/manifest.json`;

const SHADING = [
    { id: 'textured', name: 'Scan' },
    { id: 'matte', name: 'Matte' },
    { id: 'shaded', name: 'Shaded' },
    { id: 'normal', name: 'Normal' },
];

// Face budgets the pipeline writes per take. Picking one is a look, not a
// performance setting - a scan drawn at full density is a solid fill.
const WIRE_LEVELS = [
    { id: 'coarse', name: 'Coarse' },
    { id: 'medium', name: 'Medium' },
    { id: 'fine', name: 'Fine' },
];

const EXPORT_SCALES = [
    { id: 0.5, name: '0.5x' },
    { id: 1, name: '1x' },
    { id: 1.5, name: '1.5x' },
    { id: 2, name: '2x' },
];

// Bits per pixel per frame. The old exporter was fixed at 0.25, which is thin
// for a frame full of points and thin lines - exactly the high-frequency
// detail H.264 throws away first - and is the main reason an export looked
// softer and blockier than the preview.
const EXPORT_QUALITY = [
    { id: 0.18, name: 'Draft' },
    { id: 0.4, name: 'High' },
    { id: 0.85, name: 'Max' },
];

// How the clip behaves when it reaches its end: stop, jump back to the start,
// or run backwards to it. A bounce never repeats the turnaround frame, so a
// short take reads as one continuous move rather than a stutter on the end.
const LOOP_MODES = [
    { id: 'off', name: 'Once' },
    { id: 'loop', name: 'Loop' },
    { id: 'bounce', name: 'Ping-pong' },
];

// How much of the loop an export covers.
const EXPORT_LENGTHS = [
    { id: 'clip', name: 'One cycle' },
    { id: 'audio', name: 'Full track' },
    { id: 'loops', name: 'Cycles' },
];

// Supersample factor for the export, applied on top of the output scale: the
// scene is drawn this much larger and filtered down, which is what stops a
// point cloud crawling and a one-pixel wireframe breaking up.
const EXPORT_SS = 2;

// The layer stack. All of it is snapshotted into a view, so one key can
// swap the whole look of the shot.
const DEFAULT_LAYERS = {
    bgColor: '#000000',

    videoOn: true,
    videoOpacity: 1,

    cloudOn: false,
    cloudColorMode: 'scan',   // 'scan' = sampled texture colour, 'solid'
    cloudColor: '#f2f0e6',
    cloudSize: 1.6,
    cloudOpacity: 1,
    cloudDensity: 0.6,        // fraction of the 300k sampled points drawn
    cloudAttenuate: true,
    // The scan's own points react to the music like any placed cloud. Kept in
    // the layer stack rather than beside the scene objects so a cut can turn
    // the object itself into the thing that moves.
    cloudReact: 0,            // 0 leaves the scan geometrically true
    cloudScatter: 0.002,
    cloudFreqLow: 0,
    cloudFreqHigh: 1,
    cloudPulseX: 0,
    cloudPulseY: 0,
    cloudPulseZ: 0,

    meshOn: false,
    meshShading: 'matte',
    meshColor: '#2b4bdf',
    meshOpacity: 1,

    wireOn: false,
    wireColor: '#e8c56a',
    wireOpacity: 0.5,
    wireLevel: 'medium',
    // As a fraction of frame height, so the preview and a 1440p export show
    // the same weight of line rather than the same number of pixels.
    wireThickness: 0.0015,
    wireReact: 0,

    // Placed objects as one group, so the Scene panel's contents can be faded
    // in and out of a shot without editing each item.
    sceneOpacity: 1,

    // The scan's own points, mesh and wireframe drawn behind the footage
    // instead of over it, so they only show through windows (or where the
    // footage is faded).
    scanBehind: false,

    // Post FX over the finished composite, the audio visualizer's look. Both
    // start off so a take reads as the plain solve until you ask for more.
    // The floor is in scene brightness, so footage glows too - a window or a
    // strip light blooms with the overlays rather than sitting flat under them.
    // It sits higher than the visualizer's 0.5: that draws on black, and over
    // daylight footage 0.5 blooms half the frame.
    bloomStrength: 0,
    bloomRadius: 0.6,
    bloomThreshold: 0.8,
    haze: 0,

    // One envelope, read off a chosen slice of the spectrum, multiplying the
    // opacity of whichever layers opt in. In 'band' it breathes with the
    // level above a floor; in 'gate' it snaps on when the band crosses the
    // threshold, which is how you get points flashing on the beat.
    opacityReact: 0,
    opacityMode: 'band',      // 'band' | 'gate'
    opacityFreqLow: 0,
    opacityFreqHigh: 0.12,
    opacityThreshold: 0.25,
    opacityInvert: false,
    opacitySmooth: 0.4,
    opacityPoints: true,
    opacityWire: false,
    opacityMesh: false,
    opacityScene: false,

    // Object mattes (Roto): whether the take's published mattes are used at
    // all, and which of them hold out what is in front of the video - by
    // matte id, on unless set false.
    mattesOn: true,
    matteHoldout: {},
};

// Kept out of the views: these describe the solve, not the look, so recalling
// a view should never disturb them.
const DEFAULT_RIG = {
    cameraMode: 'tracked',    // 'tracked' | 'free'
    offsetX: 0, offsetY: 0, offsetZ: 0,
    rotX: 0, rotY: 0, rotZ: 0,
    scale: 1,
    // Pushes the overlays off the surface so the mesh does not clip through
    // them. The mesh itself stays at 1, so the scan keeps its true size.
    overscale: 1,
    // Shifts the points and wireframe bodily off the mesh. Swell can only
    // move them along the line from the centre; this detaches them in a
    // direction of your choosing, which is what a drifting double image of
    // the object needs.
    overlayX: 0, overlayY: 0, overlayZ: 0,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Rigged models that can be placed in a take. Unlike the point clouds and
// curves these are posed and animated rather than driven by the spectrum.
const MODELS = [
    { id: 'protagonist', name: 'Protagonist' },
    ...RIGS.map((r) => ({ id: r.id, name: r.name })),
];

// Sackboy on the Bench: perched on the seat (its top is at +0.06), facing
// out over the path like the protagonist. He faces +Z where the protagonist
// faces -Z, hence the half turn.
const SACKBOY_SPAWNS = {
    bench: { op: { posX: -0.283, posY: 0.06, posZ: 0.283, rotY: 135 }, pose: 'sit' },
};

const LAYER_OPTIONS = [['front', 'In front of video'], ['behind', 'Behind video']];

const VIDEO_FITS = [[null, 'Default'], ['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch']];

// Pixel sort options, as the Pixel Sorter names them.
const SORT_BY = ['brightness', 'hue', 'saturation', 'lightness', 'red', 'green', 'blue'];
const SORT_THRESHOLD = ['brightness', 'saturation', 'hue', 'none'];

// Ways to draw a model, each on or off on its own.
const MODEL_VIEWS = [
    { key: 'viewTextured', name: 'Textured' },
    { key: 'viewWire', name: 'Wireframe' },
    { key: 'viewPoints', name: 'Points' },
];

// Where a model lands when it is added to a take, in the scan's own frame.
// The Bench scan is metric with Y up: ground at -0.385, the seat's top at
// +0.06, and the bench running along the x = z diagonal with its backrest
// towards -x / +z. So he sits a little forward of the backrest, facing out
// over the path towards where the camera walks, hips just clear of the seat.
const MODEL_SPAWNS = {
    bench: {
        op: { posX: -0.283, posY: -0.385, posZ: 0.283, rotY: -45, hipHeight: 0.555, footForward: 0.36 },
        pose: 'sit',
    },
};

// The sun: one directional light (as good as infinitely far away) over the
// placed models, set in the scan's own frame - azimuth round from +X towards
// +Z, elevation up from the ground. It also casts the models' shadows onto the
// scan, drawn over the footage. The defaults are the old fixed key light.
const DEFAULT_SUN = {
    azimuth: 45,
    elevation: 47,
    intensity: 1.1,
    color: '#ffffff',
    ambient: 0.55,
    shadows: true,
    shadowOpacity: 0.4,
    shadowSoftness: 2,
};

// Models reflect an unlit copy of the scan that only their cube cameras see.
const ENV_LAYER = 1;

// Project files: everything the tool knows about a shot, so a session can be
// saved and picked up again. Bump the version when the shape changes and
// teach `readProject` to upgrade the old one.
const PROJECT_FORMAT = 'scan-compositor-project';
const PROJECT_VERSION = 1;

/** A scene item as read back from a project, with any missing parameters filled in. */
function reviveItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : nextInstanceId();
    if (raw.kind === 'prop') {
        return typeof raw.assetId === 'string' ? reviveProp(raw, id) : null;
    }
    if (raw.kind === 'window') return reviveWindow(raw, id);
    if (raw.kind === 'model' && raw.modelId === 'sackboy') return reviveSackboy(raw, id);
    if (raw.kind === 'model') {
        const op = migrateModelOp(raw.op || {});
        const base = makeModelItem(id, op, 'sit');
        return { ...base, op: { ...MODEL_DEFAULTS, ...op }, pose: { ...base.pose, ...raw.pose } };
    }
    if (raw.kind === 'curve') {
        if (!CURVES.some((c) => c.id === raw.funcId)) return null;
        return { id, kind: 'curve', funcId: raw.funcId, reactive: raw.reactive !== false, op: { ...CURVE_DEFAULTS, ...raw.op } };
    }
    if (!ASSETS.some((a) => a.id === raw.assetId)) return null;
    return { id, kind: 'asset', assetId: raw.assetId, reactive: raw.reactive !== false, op: { ...OBJECT_DEFAULTS, ...raw.op } };
}

function ScanCompositor() {
    const mountRef = useRef(null);
    // The canvas box, as state too: Roto mode draws its overlay into it.
    const [mountEl, setMountEl] = useState(null);
    const mountCallback = useCallback((el) => { mountRef.current = el; setMountEl(el); }, []);
    const videoRef = useRef(null);
    // The take reversed, published beside it. Ping-pong plays this forwards
    // rather than seeking the take backwards, which no browser does well.
    const revVideoRef = useRef(null);

    const [clips, setClips] = useState([]);
    const [clipId, setClipId] = useState(null);
    const [track, setTrack] = useState(null);
    const [status, setStatus] = useState('Loading takes...');

    const [layers, setLayers] = useState(DEFAULT_LAYERS);
    const [rig, setRig] = useState(DEFAULT_RIG);
    const [menuOpen, setMenuOpen] = useState(true);

    const [presets, setPresets] = useState(() => Array(9).fill(null));
    const [activePreset, setActivePreset] = useState(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [loopMode, setLoopMode] = useState('loop');
    // Jump over stretches the solver could not place a camera for, rather than
    // showing a frozen camera drifting against moving footage.
    const [skipUnsolved, setSkipUnsolved] = useState(true);
    const [muted, setMuted] = useState(false);
    const [revReady, setRevReady] = useState(false);
    const revReadyRef = useRef(false);
    // Set while a turnaround waits for the incoming copy's first frame.
    const handoverRef = useRef(null);
    useEffect(() => { revReadyRef.current = revReady; }, [revReady]);
    const [speed, setSpeed] = useState(1);

    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);
    const [exportStage, setExportStage] = useState('');
    const [exportScale, setExportScale] = useState(1);
    const [exportQuality, setExportQuality] = useState(0.4);
    const [exportLength, setExportLength] = useState('clip');
    const [exportLoops, setExportLoops] = useState(2);
    // Where an export starts: seconds into the music, and into the take.
    // Fixed rather than read off wherever the preview happens to be sitting,
    // so the same settings always render the same film.
    const [exportMusicStart, setExportMusicStart] = useState(0);
    const [exportVideoStart, setExportVideoStart] = useState(0);

    // ---- Audio-reactive scene (shared engine with the Audio Visualizer) ----
    const [sceneOpen, setSceneOpen] = useState(false);
    const [sceneItems, setSceneItems] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [addAssetId, setAddAssetId] = useState('sphere');
    const [addCurveId, setAddCurveId] = useState(CURVES[0].id);
    const [trackName, setTrackName] = useState('');
    const [audioReady, setAudioReady] = useState(false);
    // Depth-only draw of the scan, so overlays can be hidden where the real
    // object would be in front of them.
    const [occlude, setOcclude] = useState(false);
    const [addModelId, setAddModelId] = useState(MODELS[0].id);
    // Pose editing: joint markers in the viewport and a rotate gizmo on
    // whichever joint is picked, for the selected model only.
    const [poseEdit, setPoseEdit] = useState(false);
    const [poseJoint, setPoseJoint] = useState('head');
    const poseEditRef = useRef({ on: false, itemId: null, joint: 'head' });
    // Placed models, by item id. Kept apart from the reactive records: they
    // animate themselves rather than being driven by the spectrum.
    const modelObjectsRef = useRef(new Map());
    // Placed props and screens, and windows, by item id.
    const propObjectsRef = useRef(new Map());
    const windowObjectsRef = useRef(new Map());
    // The asset library (which GLBs are props and which are screens, and
    // where each screen's surface is). Saved by itself, outside projects:
    // it describes the assets, not a shot.
    const [library, setLibrary] = useState(loadLibrary);
    const libraryRef = useRef(library);
    useEffect(() => { libraryRef.current = library; }, [library]);
    const [librarySaved, setLibrarySaved] = useState(null); // null | 'saving' | 'repo' | 'browser'
    const librarySaveRef = useRef(0);
    const [addPropId, setAddPropId] = useState('');
    const [addScreenId, setAddScreenId] = useState('');
    // Viewport editing beyond the pose gizmo: moving the selected object, or
    // the corners of the selected window / screen. `handle` is which corner
    // (0-3: TL, TR, BR, BL) or 4 for the whole patch.
    const [editMode, setEditMode] = useState(null); // null | 'move' | 'corners'
    const [cornerHandle, setCornerHandle] = useState(4);
    const editRef = useRef({ mode: null, itemId: null, handle: 4 });
    const [uploads, setUploads] = useState([]);
    const videoInputRef = useRef(null);
    // Bumped when an asset finishes loading, so effects that look objects up
    // (the gizmos) run again.
    const [assetTick, setAssetTick] = useState(0);
    // Live readouts in the panels, written straight from the render loop.
    const modUiRef = useRef({});
    const freeClockRef = useRef(0);
    const tapRef = useRef([]);
    // Where the loaded track came from, so a project can load it again.
    const [musicSource, setMusicSource] = useState(null);
    const [sun, setSun] = useState(DEFAULT_SUN);
    const sunRef = useRef(sun);
    // Roto mode: cutting object mattes out of the take (RotoEditor). While it
    // is on the take is held paused on a frame, and drawn plain if asked.
    const [rotoOn, setRotoOn] = useState(false);
    const [rotoPlain, setRotoPlain] = useState(true);
    const rotoRef = useRef({ on: false, plain: true });
    useEffect(() => { rotoRef.current = { on: rotoOn, plain: rotoPlain }; three.current.needsRender = true; }, [rotoOn, rotoPlain]);
    // The take's published mattes, decoded in step with the footage.
    const matteSetRef = useRef(null);
    if (!matteSetRef.current) matteSetRef.current = new MatteSet();
    const [mattesTick, setMattesTick] = useState(0);
    useEffect(() => onMattesChanged(() => setMattesTick((v) => v + 1)), []);
    useEffect(() => { sunRef.current = sun; }, [sun]);
    const selectedIdRef = useRef(null);
    // The kick meter in the model panel, written straight from the render
    // loop rather than through React.
    const kickMeterRef = useRef(null);
    const kickFlashRef = useRef(null);
    const projectInputRef = useRef(null);
    // A project waiting on its take to finish loading before the parts that
    // the load itself resets (camera, rig) can go back on.
    const pendingProjectRef = useRef(null);

    const audioRef = useRef(null);
    const audioCtxRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const audioBufferRef = useRef(null);
    const audioUrlRef = useRef(null);
    const fileInputRef = useRef(null);
    const sceneObjectsRef = useRef(new Map());
    const plyCacheRef = useRef(new Map());
    const sceneItemsRef = useRef(sceneItems);
    const spectrogramRef = useRef(null);
    const lastTickRef = useRef(0);
    // The clip's own soundtrack, decoded out of its mp4 so the exporter can
    // mux it. Only fetched when something actually asks for it.
    const clipAudioRef = useRef({ id: null, buffer: null, promise: null });
    // Opacity envelope state. Held outside React so the render loop can
    // advance it without a re-render, and reset before an export so the
    // result does not depend on what the preview was doing beforehand.
    const opacityEnvRef = useRef({ v: 0 });

    useEffect(() => { sceneItemsRef.current = sceneItems; }, [sceneItems]);
    useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);


    // Live mirrors so the render loop never closes over stale state.
    const layersRef = useRef(layers);
    const rigRef = useRef(rig);
    const trackRef = useRef(null);
    const presetsRef = useRef(presets);
    const activePresetRef = useRef(activePreset);
    const exportingRef = useRef(false);
    const exportCanceledRef = useRef(false);

    useEffect(() => { layersRef.current = layers; }, [layers]);
    useEffect(() => { rigRef.current = rig; }, [rig]);
    useEffect(() => { presetsRef.current = presets; }, [presets]);
    useEffect(() => { activePresetRef.current = activePreset; }, [activePreset]);

    // three.js objects, built once and mutated in place.
    const three = useRef({
        renderer: null, scene: null, camera: null, freeCamera: null,
        controls: null, modelRoot: null, mesh: null, cloud: null, wire: null,
        bgScene: null, bgCamera: null, bgQuad: null, videoTexture: null,
        materials: {}, raf: 0, needsRender: true,
    });

    const clip = useMemo(
        () => clips.find((c) => c.id === clipId) || null,
        [clips, clipId],
    );
    // Two stacked control columns. Each element sits clear of whatever is to
    // its right: a panel takes a full column, a closed one only its toggle. So
    // the Scene panel moves aside only when the compositor panel is open, and
    // the compositor's toggle steps left when the Scene panel has taken the
    // right-hand column - which is what stops the toggle landing on top of the
    // other panel's close button.
    const narrow = useMediaQuery('(max-width: 820px)');
    const COL = 306; // panel width + gap
    const TOGGLE_COL = 46; // toggle width + gap
    const slide = (offset) => ({ right: `calc(var(--gutter) + ${offset}px)` });
    const layout = useMemo(() => {
        if (narrow) {
            // No room for two columns; only one panel is open at a time, so
            // everything can sit flush right.
            return {
                menuPanel: 0, menuToggle: 0, scenePanel: 0, sceneToggle: TOGGLE_COL,
            };
        }
        return {
            menuPanel: 0,
            menuToggle: sceneOpen ? COL : 0,
            scenePanel: menuOpen ? COL : 0,
            sceneToggle: menuOpen ? COL : TOGGLE_COL,
        };
    }, [narrow, menuOpen, sceneOpen]);

    // Narrow viewports have room for one column, so opening either panel puts
    // the other away rather than letting them overlap.
    useEffect(() => {
        if (narrow && menuOpen && sceneOpen) setSceneOpen(false);
    }, [narrow, menuOpen, sceneOpen]);

    const selected = useMemo(
        () => sceneItems.find((i) => i.id === selectedId) || null,
        [sceneItems, selectedId],
    );

    // Contiguous runs of solved frames, and a flat lookup for "is this frame
    // placed?". A take can be missing its tail, a stretch in the middle, or
    // nothing at all, so playback and export both work off these rather than
    // assuming the solve covers the clip.
    const coverage = useMemo(() => {
        if (!track || !track.frames || !track.frames.length) {
            return { spans: [], mask: null, unsolved: 0 };
        }
        const last = track.frames[track.frames.length - 1].i;
        const mask = new Uint8Array(last + 1);
        track.frames.forEach((f) => { mask[f.i] = f.solved ? 1 : 0; });

        const spans = [];
        let start = null;
        for (let i = 0; i <= last; i++) {
            if (mask[i] && start === null) start = i;
            else if (!mask[i] && start !== null) { spans.push([start, i - 1]); start = null; }
        }
        if (start !== null) spans.push([start, last]);

        let unsolved = 0;
        for (let i = 0; i <= last; i++) if (!mask[i]) unsolved++;
        return { spans, mask, unsolved };
    }, [track]);

    const coverageRef = useRef(coverage);
    const skipUnsolvedRef = useRef(skipUnsolved);
    const loopModeRef = useRef(loopMode);
    const speedRef = useRef(speed);
    // Transport state the tick owns. Running backwards means the video element
    // is paused and its clock is being driven by hand, so the element's own
    // paused flag can no longer say whether the transport is rolling.
    const playingRef = useRef(false);
    // Which copy of the clip is on screen: 1 the take, -1 its reversed copy.
    const dirRef = useRef(1);
    useEffect(() => { coverageRef.current = coverage; }, [coverage]);
    useEffect(() => { skipUnsolvedRef.current = skipUnsolved; }, [skipUnsolved]);
    useEffect(() => { speedRef.current = speed; }, [speed]);

    // Some parameters only apply to the generated sphere, not to a loaded PLY.
    const selectedAssetType = useMemo(() => (
        selected && selected.kind === 'asset'
            ? ASSETS.find((a) => a.id === selected.assetId)?.type
            : null
    ), [selected]);

    // ---- Manifest --------------------------------------------------------

    useEffect(() => {
        let alive = true;
        fetch(MANIFEST_URL)
            .then((r) => {
                if (!r.ok) throw new Error(`manifest ${r.status}`);
                return r.json();
            })
            .then((list) => {
                if (!alive) return;
                setClips(list);
                if (list.length) setClipId(list[0].id);
                else setStatus('No takes in public/mv/manifest.json');
            })
            .catch((e) => alive && setStatus(`Could not load takes: ${e.message}`));
        return () => { alive = false; };
    }, []);

    // ---- Scene graph -----------------------------------------------------

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return undefined;

        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            // The export path builds a VideoFrame straight off this canvas, so
            // the drawing buffer has to survive past the draw call.
            preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.autoClear = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';

        const scene = new THREE.Scene();
        const modelRoot = new THREE.Group();
        scene.add(modelRoot);

        const ambient = new THREE.AmbientLight(0xffffff, 0.55);
        scene.add(ambient);
        // The sun. Its position is only a direction (placeSun keeps it a
        // fixed way off whatever it is lighting); the shadow camera is fitted
        // round the placed models every frame.
        const key = new THREE.DirectionalLight(0xffffff, 1.1);
        key.position.set(2, 3, 2);
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.bias = -0.0004;
        key.shadow.normalBias = 0.015;
        scene.add(key);
        scene.add(key.target);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-2, -1, -2);
        scene.add(fill);
        // Things behind the video are drawn on their own camera layer, and a
        // light only reaches the layers it is on.
        [ambient, key, fill].forEach((l) => l.layers.enableAll());
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        // The scene is drawn in several passes a frame (behind the video,
        // windows, in front); shadows are worked out only for the two that
        // draw objects, rather than again for every pass.
        renderer.shadowMap.autoUpdate = false;

        // The tracked camera's frustum is rebuilt from the solved intrinsics
        // each frame, so its constructor arguments are placeholders.
        const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 100);
        const freeCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.001, 1000);
        freeCamera.position.set(0, 0, 4);

        const controls = new OrbitControls(freeCamera, renderer.domElement);
        controls.enableDamping = true;
        controls.enabled = false;

        // Background pass: the footage as a screen-filling quad drawn before
        // the scene, so one canvas holds the finished composite and export is
        // just an encode of that canvas.
        const bgScene = new THREE.Scene();
        const bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const bgQuad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
        );
        bgScene.add(bgQuad);

        // Glow and haze. With either on, the composite is drawn into this
        // target instead of the canvas and the passes finish it to screen.
        // Half float, because a target holds linear colour and eight bits of
        // that bands in the shadows; multisampled, because only the canvas
        // gets the renderer's own antialiasing and hairline edges need it.
        // three r152 has no OutputPass, so gamma correction does its job:
        // drawing into a target skips the sRGB encode the canvas gets.
        const fxTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            samples: 4,
        });
        const composer = new EffectComposer(renderer, fxTarget);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0.6, 0.5);
        const gammaPass = new ShaderPass(GammaCorrectionShader);
        // After gamma, so the tint works on display colour as it does in the
        // audio visualizer.
        const hazePass = new ShaderPass(DreamHazeShader);
        composer.addPass(bloomPass);
        composer.addPass(gammaPass);
        composer.addPass(hazePass);

        // Pose editing: rotates one joint of the selected model. Lives in the
        // scene rather than the model root so the alignment nudge and the
        // scene fades never touch it, and is hidden for exports.
        const gizmo = new TransformControls(freeCamera, renderer.domElement);
        gizmo.setMode('rotate');
        gizmo.setSpace('local');
        gizmo.setSize(0.7);
        gizmo.enabled = false;
        gizmo.visible = false;
        scene.add(gizmo);
        gizmo.addEventListener('dragging-changed', (e) => {
            const tt = three.current;
            tt.controls.enabled = !e.value && rigRef.current.cameraMode === 'free';
            const rec = modelObjectsRef.current.get(poseEditRef.current.itemId);
            if (rec) rec.dragJoint = e.value ? poseEditRef.current.joint : null;
            if (!e.value) tt.onGizmoCommit?.();
        });
        gizmo.addEventListener('objectChange', () => three.current.onGizmoChange?.());

        // Moving things: the selected object bodily, or one corner of a
        // window or screen (or the whole patch) through a proxy that stands
        // where that corner is.
        const moveGizmo = new TransformControls(freeCamera, renderer.domElement);
        moveGizmo.setMode('translate');
        moveGizmo.setSpace('world');
        moveGizmo.setSize(0.55);
        moveGizmo.enabled = false;
        moveGizmo.visible = false;
        scene.add(moveGizmo);
        moveGizmo.addEventListener('dragging-changed', (e) => {
            const tt = three.current;
            tt.controls.enabled = !e.value && rigRef.current.cameraMode === 'free';
            tt.moveDragging = e.value;
            if (!e.value) tt.onMoveCommit?.();
        });
        moveGizmo.addEventListener('objectChange', () => three.current.onMoveChange?.());
        const cornerProxy = new THREE.Object3D();
        modelRoot.add(cornerProxy);

        // Corner markers for the patch being edited: four corners and the
        // middle. Drawn on the overlay layer, over everything.
        const cornerHandles = new THREE.Group();
        const cornerGeo = new THREE.OctahedronGeometry(1, 0);
        for (let i = 0; i < 5; i++) {
            const m = new THREE.Mesh(cornerGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9, toneMapped: false,
            }));
            m.layers.set(LAYER.OVERLAY);
            m.renderOrder = 1001;
            m.userData.corner = i;
            m.userData.handle = true;
            cornerHandles.add(m);
        }
        cornerHandles.visible = false;
        modelRoot.add(cornerHandles);

        const compositor = new WindowCompositor(renderer);
        const holdout = new HoldoutPass(renderer);

        // Picking a joint: the marker nearest the click on screen, within a
        // finger's width. A scan is shot from a few metres off, so the
        // markers are only a few pixels across and ray-picking them would be
        // fiddly. Ignored while the pointer is over the gizmo, which has the
        // click itself.
        const PICK_PX = 18;
        const onPick = (e) => {
            const ed = poseEditRef.current;
            const tt = three.current;
            if (e.button !== 0 || moveGizmo.dragging || moveGizmo.axis) return;
            // Corners first: the same nearest-marker-on-screen pick.
            if (editRef.current.mode === 'corners' && cornerHandles.visible && tt.activeCamera) {
                const box = renderer.domElement.getBoundingClientRect();
                const p = new THREE.Vector3();
                let best = null;
                cornerHandles.children.forEach((h) => {
                    h.getWorldPosition(p).project(tt.activeCamera);
                    if (p.z < -1 || p.z > 1) return;
                    const dx = ((p.x + 1) / 2) * box.width + box.left - e.clientX;
                    const dy = ((1 - p.y) / 2) * box.height + box.top - e.clientY;
                    const d = Math.hypot(dx, dy);
                    if (d < PICK_PX && (!best || d < best.d)) best = { d, i: h.userData.corner };
                });
                if (best) tt.onCornerPick?.(best.i);
                return;
            }
            if (!ed.on || gizmo.dragging || gizmo.axis) return;
            const rec = modelObjectsRef.current.get(ed.itemId);
            const cam = tt.activeCamera;
            if (!rec || !cam) return;
            const box = renderer.domElement.getBoundingClientRect();
            const p = new THREE.Vector3();
            let best = null;
            rec.handles.forEach((h) => {
                h.getWorldPosition(p).project(cam);
                if (p.z < -1 || p.z > 1) return;
                const dx = ((p.x + 1) / 2) * box.width + box.left - e.clientX;
                const dy = ((1 - p.y) / 2) * box.height + box.top - e.clientY;
                const d = Math.hypot(dx, dy);
                if (d < PICK_PX && (!best || d < best.d)) best = { d, joint: h.userData.joint };
            });
            if (best) tt.onJointPick?.(best.joint);
        };
        renderer.domElement.addEventListener('pointerdown', onPick);

        three.current = {
            ...three.current,
            renderer, scene, camera, freeCamera, controls, modelRoot,
            bgScene, bgCamera, bgQuad,
            composer, bloomPass, hazePass, gizmo,
            sun: key, ambient, fill,
            moveGizmo, cornerProxy, cornerHandles, compositor, holdout,
        };

        return () => {
            cancelAnimationFrame(three.current.raf);
            renderer.domElement.removeEventListener('pointerdown', onPick);
            gizmo.detach();
            gizmo.dispose();
            moveGizmo.detach();
            moveGizmo.dispose();
            compositor.dispose();
            holdout.dispose();
            matteSetRef.current?.dispose();
            cornerGeo.dispose();
            cornerHandles.children.forEach((m) => m.material.dispose());
            composer.dispose();
            bloomPass.dispose();
            controls.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode === mount) {
                mount.removeChild(renderer.domElement);
            }
        };
    }, []);

    // ---- Material / visibility sync --------------------------------------

    const applyLayers = useCallback((L) => {
        const t = three.current;
        if (!t.renderer) return;

        if (t.bgQuad) {
            const freeCam = rigRef.current.cameraMode === 'free';
            // In free orbit the footage no longer corresponds to the view, so
            // showing it would only mislead.
            t.bgQuad.visible = L.videoOn && !freeCam && !!t.videoTexture;
            t.bgQuad.material.opacity = L.videoOpacity;
        }

        if (t.mesh) {
            t.mesh.visible = L.meshOn;
            if (L.meshOn) {
                const want = L.meshShading;
                let mat = t.mesh.material;
                const needs = (type) => !mat || mat.userData.kind !== type;

                if (want === 'textured') {
                    if (mat !== t.materials.textured) {
                        t.mesh.material = t.materials.textured;
                        mat = t.mesh.material;
                    }
                } else if (want === 'normal') {
                    if (needs('normal')) {
                        mat = new THREE.MeshNormalMaterial();
                        mat.userData.kind = 'normal';
                        t.mesh.material = mat;
                    }
                } else if (want === 'shaded') {
                    if (needs('shaded')) {
                        mat = new THREE.MeshLambertMaterial();
                        mat.userData.kind = 'shaded';
                        t.mesh.material = mat;
                    }
                    mat.color.set(L.meshColor);
                } else {
                    if (needs('matte')) {
                        mat = new THREE.MeshBasicMaterial();
                        mat.userData.kind = 'matte';
                        t.mesh.material = mat;
                    }
                    mat.color.set(L.meshColor);
                }
                mat = t.mesh.material;
                mat.transparent = L.meshOpacity < 1;
                mat.opacity = L.meshOpacity;
                mat.depthWrite = L.meshOpacity >= 1;
                mat.needsUpdate = true;
            }
        }

        if (t.wire) {
            t.wire.visible = L.wireOn;
            const m = t.wire.material;
            m.color.set(L.wireColor);
            m.opacity = L.wireOpacity;
            // Fat lines need the draw size to turn a pixel width into clip
            // space, and the width itself is a fraction of frame height so the
            // preview and a full-resolution export match.
            const size = t.renderer.getDrawingBufferSize(new THREE.Vector2());
            m.resolution.set(size.x, size.y);
            m.linewidth = Math.max(0.5, L.wireThickness * size.y);
            m.needsUpdate = true;
        }

        if (t.cloud) {
            t.cloud.visible = L.cloudOn;
            const m = t.cloud.material;
            const useScan = L.cloudColorMode === 'scan'
                && !!t.cloud.geometry.getAttribute('color');
            m.vertexColors = useScan;
            m.color.set(useScan ? '#ffffff' : L.cloudColor);
            // With attenuation the size is in scan units, which keeps the
            // preview and the export looking identical; without it the size is
            // in screen pixels and so depends on the output resolution.
            m.sizeAttenuation = L.cloudAttenuate;
            // A screen-space size is in drawing-buffer pixels, so it has to
            // follow the export's supersample factor or the points would come
            // out smaller than previewed once the frame is filtered down.
            m.size = L.cloudAttenuate
                ? (L.cloudSize / 1000) * 4
                : L.cloudSize * 1.5 * (t.ss || 1);
            m.opacity = L.cloudOpacity;
            m.transparent = L.cloudOpacity < 1;
            m.depthWrite = L.cloudOpacity >= 1;
            m.needsUpdate = true;

            const total = t.cloud.geometry.getAttribute('position').count;
            t.cloud.geometry.setDrawRange(
                0, Math.max(1, Math.floor(total * clamp01(L.cloudDensity))),
            );
        }

        // Swell the overlays slightly off the surface. Scaling happens about
        // the model root, which a scan is centred on, so points and edges lift
        // away from the mesh evenly instead of sliding to one side. The offset
        // then slides them as a body, which swell cannot do.
        const R = rigRef.current;
        const over = R.overscale ?? 1;
        [t.cloud, t.wire].forEach((o) => {
            if (!o) return;
            o.scale.setScalar(over);
            o.position.set(R.overlayX ?? 0, R.overlayY ?? 0, R.overlayZ ?? 0);
        });

        t.renderer.setClearColor(new THREE.Color(L.bgColor), 1);

        if (t.composer) {
            t.bloomPass.enabled = L.bloomStrength > 0;
            t.bloomPass.strength = L.bloomStrength;
            t.bloomPass.radius = L.bloomRadius;
            t.bloomPass.threshold = L.bloomThreshold;
            t.hazePass.enabled = L.haze > 0;
            t.hazePass.uniforms.intensity.value = L.haze;
            t.hazePass.uniforms.tint.value = Math.min(1, L.haze);
            // The passes work at the drawing buffer's own size, which the
            // export changes when it supersamples.
            const size = t.renderer.getDrawingBufferSize(new THREE.Vector2());
            const cur = t.composer.renderTarget1;
            if (cur.width !== size.x || cur.height !== size.y) {
                t.composer.setPixelRatio(1);
                t.composer.setSize(size.x, size.y);
            }
        }
        t.needsRender = true;
    }, []);

    // ---- Audio-reactive scene --------------------------------------------

    // Visualizer defaults are sized for a free-flying scene tens of units
    // across; a scan is a couple of units. Scale new items to the take so they
    // arrive at a sensible size next to the object instead of swallowing it.
    const scaleForScan = useCallback(() => {
        const t = three.current;
        const r = t.cloud?.geometry?.boundingSphere?.radius;
        return r && Number.isFinite(r) ? r : 1;
    }, []);

    const addAsset = useCallback(() => {
        const r = scaleForScan();
        const item = makeItem(addAssetId, true, {
            radius: r * 1.4,
            pointSize: Math.max(0.0015, r * 0.004),
            maxPoints: 40000,
            samples: 20000,
            scale: 1,
        });
        // A PLY asset arrives in its own units, so fit it to the scan instead.
        if (ASSETS.find((a) => a.id === addAssetId)?.type === 'ply') {
            item.op.scale = r * 0.08;
        }
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    }, [addAssetId, scaleForScan]);

    const addCurve = useCallback(() => {
        const r = scaleForScan();
        const item = makeCurveItem(addCurveId, true, {
            curveScale: r * 1.2,
            dotSize: Math.max(0.01, r * 0.02),
        });
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    }, [addCurveId, scaleForScan]);

    const removeItem = useCallback((id) => {
        setSceneItems((prev) => prev.filter((i) => i.id !== id));
        setSelectedId((cur) => (cur === id ? null : cur));
    }, []);

    const setItemParam = useCallback((key) => (value) => {
        setSceneItems((prev) => prev.map((i) => (
            i.id === selectedId ? { ...i, op: { ...i.op, [key]: value } } : i
        )));
    }, [selectedId]);

    // ---- Models ------------------------------------------------------------

    // A model arrives where the take says it belongs (on the Bench, sitting
    // on the bench), or else standing at the middle of the scan.
    // Where something new should stand: the middle of the scan, on whatever
    // the scan's lowest points around there say the floor is.
    const scanCentre = useCallback(() => {
        const c = three.current.cloud?.geometry?.boundingSphere?.center;
        const r = (v) => Math.round(v * 1000) / 1000;
        return c ? { posX: r(c.x), posY: r(c.y), posZ: r(c.z) } : { posX: 0, posY: 0, posZ: 0 };
    }, []);

    const addModel = useCallback(() => {
        if (addModelId === 'sackboy') {
            const spawn = SACKBOY_SPAWNS[clipId];
            const item = spawn
                ? makeSackboyItem(nextInstanceId(), spawn.op, spawn.pose)
                : makeSackboyItem(nextInstanceId(), scanCentre(), 'stand');
            setSceneItems((prev) => [...prev, item]);
            setSelectedId(item.id);
            return;
        }
        const spawn = MODEL_SPAWNS[clipId];
        let item;
        if (spawn) {
            item = makeModelItem(nextInstanceId(), spawn.op, spawn.pose);
        } else {
            const c = three.current.cloud?.geometry?.boundingSphere?.center;
            item = makeModelItem(nextInstanceId(), {
                posX: c ? Math.round(c.x * 1000) / 1000 : 0,
                posY: c ? Math.round(c.y * 1000) / 1000 : 0,
                posZ: c ? Math.round(c.z * 1000) / 1000 : 0,
            }, 'stand');
        }
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
    }, [clipId, addModelId, scanCentre]);

    // A prop or screen from the library, standing at the middle of the scan.
    const addProp = useCallback((assetId) => {
        if (!assetId) return;
        const item = makePropItem(nextInstanceId(), assetId, scanCentre());
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
        setEditMode('move');
    }, [scanCentre]);

    // A window: a square facing the camera, as far off as the middle of the
    // scan, about a third of the frame across. Corners are editing at once.
    const addWindow = useCallback(() => {
        const t = three.current;
        const cam = t.activeCamera || t.camera;
        if (!cam || !t.modelRoot) return;
        const c = t.cloud?.geometry?.boundingSphere?.center;
        const centre = c ? t.modelRoot.localToWorld(c.clone()) : new THREE.Vector3();
        const dist = Math.max(0.3, centre.distanceTo(cam.getWorldPosition(new THREE.Vector3())));
        // The frame's height at that distance: from the solve's intrinsics
        // for the tracked camera (its fov is a placeholder), else the fov.
        const intr = trackRef.current?.intrinsics;
        const span = rigRef.current.cameraMode !== 'free' && intr?.fy
            ? intr.height / intr.fy
            : 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) / 2);
        const size = dist * span * 0.35;
        const item = makeWindowItem(nextInstanceId(), cornersFacing(cam, t.modelRoot, dist, size));
        setSceneItems((prev) => [...prev, item]);
        setSelectedId(item.id);
        setEditMode('corners');
        setCornerHandle(4);
    }, []);

    // Edit the selected model: its parameters and pose together, so one
    // change cannot land half-applied.
    const updateSelected = useCallback((fn) => {
        setSceneItems((prev) => prev.map((i) => (i.id === selectedId ? fn(i) : i)));
    }, [selectedId]);

    const setJointAngle = useCallback((joint, axis) => (value) => {
        updateSelected((i) => {
            const cur = i.pose[joint] || [0, 0, 0];
            const next = [...cur];
            next[axis] = value;
            return { ...i, pose: { ...i.pose, [joint]: next } };
        });
    }, [updateSelected]);

    // Planted feet own the legs. Grabbing a leg joint hands the legs back to
    // the pose, starting from wherever the IK had them.
    const releaseLegs = useCallback((item) => {
        if (!item.op.plantFeet) return item;
        const rec = modelObjectsRef.current.get(item.id);
        const legs = rec ? rec.captureLegs() : {};
        return { ...item, op: { ...item.op, plantFeet: false }, pose: { ...item.pose, ...legs } };
    }, []);

    const pickJoint = useCallback((joint) => {
        setPoseJoint(joint);
        if (LEG_JOINTS.includes(joint)) updateSelected(releaseLegs);
    }, [updateSelected, releaseLegs]);

    const applyPosePreset = useCallback((presetId) => {
        const sel = sceneItemsRef.current.find((i) => i.id === selectedIdRef.current);
        if (sel?.modelId === 'sackboy') {
            const made = SACKBOY_POSES[presetId]?.make();
            if (!made) return;
            updateSelected((i) => ({ ...i, op: { ...i.op, ...made.op }, pose: made.pose }));
            return;
        }
        const preset = POSES[presetId];
        if (!preset) return;
        updateSelected((i) => {
            const made = preset.make(bodyDims(specOf({ ...MODEL_DEFAULTS, ...i.op }).body));
            const op = { ...i.op, ...made.op };
            // Seated poses keep the seat they are on: a spawn fitted to a
            // bench should not hop up to the preset's generic height.
            const standing = POSES.stand.make(bodyDims(specOf({ ...MODEL_DEFAULTS, ...i.op }).body)).op.hipHeight;
            if (preset.seated && i.op.hipHeight < standing * 0.8) {
                op.hipHeight = i.op.hipHeight;
                op.footForward = i.op.footForward;
            }
            return { ...i, op, pose: made.pose };
        });
    }, [updateSelected]);

    const mirrorPose = useCallback((joint) => {
        const other = mirrorJoint(joint);
        if (!other) return;
        updateSelected((i) => ({
            ...i, pose: { ...i.pose, [other]: mirrorAngles(i.pose[joint] || [0, 0, 0]) },
        }));
    }, [updateSelected]);

    // Tap tempo: the mean gap of the last few taps, forgotten after a pause.
    const tapTempo = useCallback(() => {
        const now = performance.now();
        const taps = tapRef.current.filter((t) => now - t < 2500);
        taps.push(now);
        tapRef.current = taps.slice(-8);
        if (taps.length < 2) return;
        const gaps = [];
        for (let i = 1; i < tapRef.current.length; i++) gaps.push(tapRef.current[i] - tapRef.current[i - 1]);
        const bpm = 60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
        setItemParam('bpm')(Math.round(Math.max(30, Math.min(240, bpm)) * 10) / 10);
    }, [setItemParam]);

    // Build, update and drop model instances to match the item list.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        const map = modelObjectsRef.current;
        const wanted = new Map(sceneItems.filter((i) => i.kind === 'model').map((i) => [i.id, i]));
        Array.from(map.keys()).forEach((id) => {
            if (wanted.has(id)) return;
            const rec = map.get(id);
            if (t.gizmo?.object && rec.bones && Object.values(rec.bones).includes(t.gizmo.object)) t.gizmo.detach();
            rec.dispose();
            map.delete(id);
        });
        wanted.forEach((item, id) => {
            let rec = map.get(id);
            if (!rec) {
                if (item.modelId === 'sackboy') {
                    rec = new SackboyModel(item);
                    // He loads asynchronously; the gizmo and markers look
                    // for his bones again once he is in.
                    rec.onReady = () => { three.current.needsRender = true; setAssetTick((n) => n + 1); };
                } else {
                    rec = new ProtagonistModel(item);
                }
                map.set(id, rec);
                t.modelRoot.add(rec.object);
            } else {
                // The scene graph can be rebuilt under a live instance (a hot
                // reload does it); follow it to the current root.
                if (rec.object.parent !== t.modelRoot) t.modelRoot.add(rec.object);
                const before = rec.inst;
                rec.sync(item);
                // A rebuild makes new bones; the gizmo has to follow.
                if (before !== rec.inst && t.gizmo?.object) t.gizmo.detach();
            }
        });
        t.needsRender = true;
    }, [sceneItems]);

    // Joint markers and the gizmo follow the selection.
    useEffect(() => {
        const t = three.current;
        const sel = sceneItems.find((i) => i.id === selectedId);
        const on = poseEdit && sel?.kind === 'model';
        poseEditRef.current = { on, itemId: on ? sel.id : null, joint: poseJoint };
        modelObjectsRef.current.forEach((rec, id) => {
            rec.setEditing(on && id === selectedId, poseJoint);
        });
        const gizmo = t.gizmo;
        if (!gizmo) return;
        const rec = on ? modelObjectsRef.current.get(sel.id) : null;
        const bone = rec?.bones?.[poseJoint];
        if (bone) {
            if (gizmo.object !== bone) gizmo.attach(bone);
            // Sackboy's bones point along their own X, so his rings are drawn
            // in the world's axes, which read the same as his angles do.
            gizmo.setSpace(rec.gizmoSpace || 'local');
            gizmo.enabled = true;
            gizmo.visible = true;
        } else {
            gizmo.detach();
            gizmo.enabled = false;
            gizmo.visible = false;
        }
        t.needsRender = true;
    }, [poseEdit, poseJoint, selectedId, sceneItems, assetTick]);

    // A joint the selected model does not have (an ear on Sackboy, a jaw on
    // the protagonist) falls back to the head.
    useEffect(() => {
        const sel = sceneItems.find((i) => i.id === selectedId);
        if (sel?.kind !== 'model') return;
        const menu = sel.modelId === 'sackboy' ? SACKBOY_JOINT_MENU : JOINTS;
        if (!menu.some(([j]) => j === poseJoint)) setPoseJoint('head');
    }, [selectedId, sceneItems, poseJoint]);

    // Viewport editing follows the selection: it ends when the selection
    // changes to something it cannot apply to.
    useEffect(() => {
        const sel = sceneItems.find((i) => i.id === selectedId);
        const entry = sel?.kind === 'prop' ? libraryRef.current.assets.find((a) => a.id === sel.assetId) : null;
        const cornersOk = sel?.kind === 'window' || entry?.category === 'screen';
        if (!sel || (editMode === 'corners' && !cornersOk) || (editMode === 'move' && sel.kind === 'window')) {
            if (editMode) setEditMode(null);
        }
    }, [selectedId, sceneItems, editMode]);
    useEffect(() => { setCornerHandle(4); }, [selectedId]);
    useEffect(() => { if (editMode) setPoseEdit(false); }, [editMode]);
    useEffect(() => { if (poseEdit) setEditMode(null); }, [poseEdit]);

    // The gizmo writes the bone directly; read it back into the pose. Wired
    // through `three.current` so the listeners, made once, see current state.
    useEffect(() => {
        const t = three.current;
        t.onJointPick = (joint) => pickJoint(joint);
        t.onGizmoChange = () => {
            const ed = poseEditRef.current;
            const rec = modelObjectsRef.current.get(ed.itemId);
            if (!rec || !rec.bones[ed.joint]) return;
            const angles = rec.jointAngles(ed.joint);
            setSceneItems((prev) => prev.map((i) => (
                i.id === ed.itemId ? { ...i, pose: { ...i.pose, [ed.joint]: angles } } : i
            )));
        };
        t.onGizmoCommit = t.onGizmoChange;
    }, [pickJoint]);

    // ---- Props, screens and windows -----------------------------------------

    // Build, update and drop props and screens to match the item list. The
    // library is part of what they are (size, screen surface), so a library
    // edit updates every placed copy of that asset.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        const map = propObjectsRef.current;
        const wanted = new Map(sceneItems.filter((i) => i.kind === 'prop').map((i) => [i.id, i]));
        Array.from(map.keys()).forEach((id) => {
            if (wanted.has(id)) return;
            const rec = map.get(id);
            if (t.moveGizmo?.object === rec.object) t.moveGizmo.detach();
            rec.dispose();
            map.delete(id);
        });
        wanted.forEach((item, id) => {
            const entry = library.assets.find((a) => a.id === item.assetId);
            if (!entry) return;
            let rec = map.get(id);
            if (!rec || rec.entry.file !== entry.file) {
                rec?.dispose();
                rec = new PropModel(item, entry);
                rec.onReady = () => { three.current.needsRender = true; setAssetTick((n) => n + 1); };
                map.set(id, rec);
            } else {
                rec.sync(item, entry);
            }
            if (rec.object.parent !== t.modelRoot) t.modelRoot.add(rec.object);
        });
        t.needsRender = true;
    }, [sceneItems, library]);

    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        const map = windowObjectsRef.current;
        const wanted = new Map(sceneItems.filter((i) => i.kind === 'window').map((i) => [i.id, i]));
        Array.from(map.keys()).forEach((id) => {
            if (wanted.has(id)) return;
            map.get(id).dispose();
            map.delete(id);
        });
        wanted.forEach((item, id) => {
            let rec = map.get(id);
            // A hot reload swaps the class under a live window; rebuild it
            // rather than drive an instance of the old one.
            if (rec && !(rec instanceof WindowModel)) {
                rec.dispose();
                map.delete(id);
                rec = null;
            }
            if (!rec) {
                rec = new WindowModel(item);
                map.set(id, rec);
            } else {
                rec.sync(item);
            }
            if (rec.object.parent !== t.modelRoot) t.modelRoot.add(rec.object);
        });
        t.needsRender = true;
    }, [sceneItems]);

    // Uploaded screen videos, kept in this browser.
    useEffect(() => { listUploads().then(setUploads); }, []);

    const onVideoFile = useCallback(async (file) => {
        if (!file) return;
        try {
            const id = await storeUpload(file);
            setUploads(await listUploads());
            setSceneItems((prev) => prev.map((i) => (
                i.id === selectedIdRef.current ? { ...i, op: { ...i.op, video: id } } : i
            )));
        } catch (e) {
            setStatus(`Could not keep that video: ${e.message}`);
        }
    }, []);

    // ---- The asset library ----

    // Apply an edit to one asset and save it. Saves are queued so the last
    // edit always lands last; mid-drag edits only update the screen and are
    // saved when the drag ends.
    const editAsset = useCallback((id, fn, save = true) => {
        setLibrary((prev) => {
            const next = patchAsset(prev, id, fn);
            libraryRef.current = next;
            return next;
        });
        if (!save) return;
        const n = ++librarySaveRef.current;
        setLibrarySaved('saving');
        // After the state update, so the save carries this edit.
        setTimeout(() => {
            saveLibrary(libraryRef.current).then((where) => {
                if (n === librarySaveRef.current) setLibrarySaved(where);
            });
        }, 0);
    }, []);

    const saveLibraryNow = useCallback(() => {
        const n = ++librarySaveRef.current;
        setLibrarySaved('saving');
        saveLibrary(libraryRef.current).then((where) => {
            if (n === librarySaveRef.current) setLibrarySaved(where);
        });
    }, []);

    // ---- Viewport editing: moving objects, and corners ----

    // The patch being edited: the selected window's corners (in the scan's
    // frame) or the selected screen's (in its GLB's own units), and the
    // space they are written in.
    const cornerTarget = useCallback(() => {
        const ed = editRef.current;
        if (ed.mode !== 'corners') return null;
        const item = sceneItemsRef.current.find((i) => i.id === ed.itemId);
        if (!item) return null;
        const t = three.current;
        if (item.kind === 'window') {
            return { corners: item.op.corners, space: t.modelRoot, item };
        }
        const rec = propObjectsRef.current.get(item.id);
        const entry = libraryRef.current.assets.find((a) => a.id === item.assetId);
        if (!rec || !rec.ready || entry?.category !== 'screen') return null;
        return { corners: { ...DEFAULT_SCREEN, ...entry.screen }.corners, space: rec.norm, item, entry };
    }, []);

    const placeCornerHandles = useCallback(() => {
        const t = three.current;
        const target = cornerTarget();
        const handles = t.cornerHandles;
        if (!handles) return;
        if (!target) {
            handles.visible = false;
            return;
        }
        if (handles.parent !== target.space) target.space.add(handles);
        handles.visible = true;
        const C = target.corners.map((c) => new THREE.Vector3().fromArray(c));
        const mid = C.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(0.25);
        const active = editRef.current.handle;
        handles.children.forEach((m, i) => {
            m.position.copy(i < 4 ? C[i] : mid);
            m.material.color.set(i === active ? '#ffb347' : (i === 4 ? '#7fe3ff' : '#ffffff'));
            m.userData.active = i === active;
        });
    }, [cornerTarget]);

    // Attach the move gizmo to whatever the edit is about.
    useEffect(() => {
        const t = three.current;
        const gz = t.moveGizmo;
        if (!gz) return;
        const sel = sceneItems.find((i) => i.id === selectedId);
        editRef.current = { mode: editMode, itemId: sel ? sel.id : null, handle: cornerHandle };
        let obj = null;
        if (editMode === 'move' && sel) {
            if (sel.kind === 'prop') obj = propObjectsRef.current.get(sel.id)?.object;
            else if (sel.kind === 'model') obj = modelObjectsRef.current.get(sel.id)?.object;
            else if (sel.kind === 'asset' || sel.kind === 'curve') obj = sceneObjectsRef.current.get(sel.id)?.transformTarget;
        } else if (editMode === 'corners') {
            const target = cornerTarget();
            if (target && !t.moveDragging) {
                const proxy = t.cornerProxy;
                if (proxy.parent !== target.space) target.space.add(proxy);
                const C = target.corners.map((c) => new THREE.Vector3().fromArray(c));
                proxy.position.copy(cornerHandle < 4 ? C[cornerHandle]
                    : C.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(0.25));
                proxy.updateMatrixWorld(true);
                obj = proxy;
            } else if (target) {
                obj = t.cornerProxy;
            }
        }
        placeCornerHandles();
        if (obj) {
            if (gz.object !== obj) gz.attach(obj);
            gz.enabled = true;
            gz.visible = true;
        } else {
            gz.detach();
            gz.enabled = false;
            gz.visible = false;
        }
        t.needsRender = true;
    }, [editMode, cornerHandle, selectedId, sceneItems, library, assetTick, cornerTarget, placeCornerHandles]);

    // The gizmo moved something: write it back into the item (or library).
    useEffect(() => {
        const t = three.current;
        const r4 = (v) => Math.round(v * 1e4) / 1e4;
        t.onCornerPick = (i) => setCornerHandle(i);
        t.onMoveChange = () => {
            const ed = editRef.current;
            const gz = t.moveGizmo;
            if (!gz.object) return;
            if (ed.mode === 'move') {
                const p = gz.object.position;
                setSceneItems((prev) => prev.map((i) => (
                    i.id === ed.itemId ? { ...i, op: { ...i.op, posX: r4(p.x), posY: r4(p.y), posZ: r4(p.z) } } : i
                )));
                return;
            }
            const target = cornerTarget();
            if (!target) return;
            const p = t.cornerProxy.position;
            let corners;
            if (ed.handle < 4) {
                corners = target.corners.map((c, k) => (k === ed.handle ? [r4(p.x), r4(p.y), r4(p.z)] : c));
            } else {
                const C = target.corners.map((c) => new THREE.Vector3().fromArray(c));
                const mid = C.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(0.25);
                const d = p.clone().sub(mid);
                corners = C.map((c) => c.add(d).toArray().map(r4));
            }
            if (target.item.kind === 'window') {
                setSceneItems((prev) => prev.map((i) => (
                    i.id === target.item.id ? { ...i, op: { ...i.op, corners } } : i
                )));
            } else {
                // Saved once the drag ends, not on every step of it.
                editAsset(target.entry.id, (a) => ({ ...a, screen: { ...DEFAULT_SCREEN, ...a.screen, corners } }), false);
            }
        };
        t.onMoveCommit = () => {
            const ed = editRef.current;
            if (ed.mode !== 'corners') return;
            const target = cornerTarget();
            if (target?.entry) saveLibraryNow();
        };
    }, [cornerTarget, editAsset, saveLibraryNow]);

    // Reconcile the scene graph with the item list: add what is new, drop what
    // is gone, and rebuild only the items whose geometry parameters moved.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        const map = sceneObjectsRef.current;
        // Read by load callbacks that land after this render.
        sceneItemsRef.current = sceneItems;
        const wanted = new Set(sceneItems.map((i) => i.id));

        Array.from(map.keys()).forEach((id) => {
            if (!wanted.has(id)) {
                disposeRecord(map.get(id));
                map.delete(id);
            }
        });

        const attach = (item, record) => {
            record.reactive = item.reactive;
            record.op = item.op;
            record.object3D.userData.itemId = item.id;
            record.object3D.frustumCulled = false;
            applyRecordTransform(record, item.op);
            t.modelRoot.add(record.object3D);
            map.set(item.id, record);
            t.needsRender = true;
        };

        sceneItems.forEach((item) => {
            // Models have their own reconciler.
            if (item.kind === 'model') return;
            const rec = map.get(item.id);

            if (item.kind === 'curve') {
                const key = CURVE_GEOM_KEYS.map((k) => item.op[k]).join('|');
                if (rec && rec.curveKey === key && rec.curve?.id === item.funcId) {
                    rec.op = item.op;
                    rec.reactive = item.reactive;
                    rec.colA = new THREE.Color(item.op.startColor);
                    rec.colB = new THREE.Color(item.op.endColor);
                    applyRecordTransform(rec, item.op);
                    return;
                }
                if (rec) { disposeRecord(rec); map.delete(item.id); }
                const next = buildCurveRecord(item.funcId, item.op);
                next.curveKey = key;
                attach(item, next);
                return;
            }

            const asset = ASSETS.find((a) => a.id === item.assetId);
            if (!asset || asset.type === 'glb') return;
            const key = GEOM_KEYS.map((k) => item.op[k]).join('|');
            if (rec && !rec.loading && rec.geomKey === key) {
                // A load started for an earlier key is now moot.
                rec.pending = null;
                rec.op = item.op;
                rec.reactive = item.reactive;
                // Pulse origin moved, so the cached directions are stale.
                rec.dirs = null;
                if (rec.colorKey !== sphereColorKey(item.op)) recolorPointCloud(rec, item.op);
                applyRecordTransform(rec, item.op);
                t.needsRender = true;
                return;
            }
            if (rec && rec.loading) return;

            // Swap in a fresh build, disposing whatever record is in the map
            // at that moment - not whatever was there when the build started.
            const build = (raw, it) => {
                const old = map.get(it.id);
                if (old) { disposeRecord(old); map.delete(it.id); }
                const next = buildPointCloudRecord(raw, it.op, asset.type);
                next.geomKey = GEOM_KEYS.map((k) => it.op[k]).join('|');
                attach(it, next);
            };

            if (asset.type === 'sphere') {
                build(fibonacciSphere(item.op.samples, item.op.radius, item.op.jitter), item);
                return;
            }

            // A PLY loads asynchronously, even from the cache. The record that
            // is already showing stays in the map (and on screen) until its
            // replacement is ready, so a delete in the meantime still finds it
            // and removes it. Each load carries a token; only the latest one
            // for a still-present item may land.
            if (rec) {
                // Keep the showing record following moves while it waits.
                rec.op = item.op;
                rec.reactive = item.reactive;
                rec.dirs = null;
                applyRecordTransform(rec, item.op);
                t.needsRender = true;
                if (rec.pending && rec.pendingKey === key) return; // already on its way
            }
            const token = {};
            if (rec) { rec.pending = token; rec.pendingKey = key; }
            else map.set(item.id, { loading: true, pending: token });
            loadPlyPoints(asset.path, plyCacheRef.current)
                .then((raw) => {
                    const cur = map.get(item.id);
                    if (!cur || cur.pending !== token) return; // removed or superseded
                    // Build against the item as it is now: parameters may have
                    // moved while the file was loading.
                    const latest = sceneItemsRef.current.find((i) => i.id === item.id);
                    if (!latest) return;
                    build(raw, latest);
                })
                .catch(() => {
                    const cur = map.get(item.id);
                    if (cur && cur.pending === token) {
                        if (cur.loading) map.delete(item.id);
                        else cur.pending = null;
                    }
                });
        });
    }, [sceneItems]);

    // ---- Wireframe -------------------------------------------------------
    // Its own layer, loaded per resolution, because the useful density of a
    // wireframe is a look rather than a constant. Drawn as fat lines
    // (LineSegments2) since WebGL ignores lineWidth on ordinary LineSegments,
    // which is why thickness could not be configured before.
    useEffect(() => {
        const t = three.current;
        if (!clip || !t.modelRoot) return undefined;
        if (!layers.wireOn && !t.wire) return undefined;

        let alive = true;
        const level = layers.wireLevel;
        const url = `${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}_wire_${level}.glb`;

        new GLTFLoader().loadAsync(url)
            .then((gltf) => {
                if (!alive) return;
                let src = null;
                gltf.scene.updateMatrixWorld(true);
                gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
                if (!src) throw new Error('no mesh in wireframe GLB');

                const geo = src.geometry.clone();
                geo.applyMatrix4(src.matrixWorld);
                const topo = buildWireTopology(geo);
                geo.dispose();

                // Two endpoints per segment, laid out as the interleaved
                // buffer LineSegmentsGeometry expects.
                const flat = new Float32Array((topo.edges.length / 2) * 6);
                for (let i = 0; i < topo.edges.length / 2; i++) {
                    const a = topo.edges[i * 2] * 3;
                    const b = topo.edges[i * 2 + 1] * 3;
                    flat[i * 6] = topo.positions[a];
                    flat[i * 6 + 1] = topo.positions[a + 1];
                    flat[i * 6 + 2] = topo.positions[a + 2];
                    flat[i * 6 + 3] = topo.positions[b];
                    flat[i * 6 + 4] = topo.positions[b + 1];
                    flat[i * 6 + 5] = topo.positions[b + 2];
                }

                if (t.wire) {
                    t.modelRoot.remove(t.wire);
                    t.wire.geometry.dispose();
                    t.wire.material.dispose();
                }

                const lineGeo = new LineSegmentsGeometry();
                lineGeo.setPositions(flat);
                const mat = new LineMaterial({
                    color: new THREE.Color(layersRef.current.wireColor),
                    transparent: true,
                    depthWrite: false,
                    linewidth: 1,
                });
                const seg = new LineSegments2(lineGeo, mat);
                seg.frustumCulled = false;
                t.wire = seg;
                t.wireEdges = topo.edges;
                t.wireBuffer = lineGeo.attributes.instanceStart.data;
                t.wireState = {
                    base: topo.positions,
                    dirs: null, dists: null, freqIndex: null,
                    key: null, dirty: false, moved: null,
                };
                t.modelRoot.add(seg);
                applyLayers(layersRef.current);
                t.needsRender = true;
            })
            .catch((e) => alive && setStatus(`Wireframe failed: ${e.message}`));

        return () => { alive = false; };
    }, [clip, layers.wireLevel, layers.wireOn, applyLayers]);

    // Depth-only copy of the scan. Drawing it before everything else, with
    // colour writes off, means points, wireframe and placed objects are hidden
    // wherever the real object stands in front of them - whether or not the
    // mesh layer itself is being shown.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        if (t.occluder) {
            t.modelRoot.remove(t.occluder);
            t.occluder.material.dispose();
            t.occluder = null;
        }
        if (occlude && t.mesh) {
            const occ = new THREE.Mesh(
                t.mesh.geometry,
                new THREE.MeshBasicMaterial({ colorWrite: false }),
            );
            occ.frustumCulled = false;
            occ.renderOrder = -1; // lay the depth down first
            t.occluder = occ;
            t.modelRoot.add(occ);
        }
        t.needsRender = true;
    }, [occlude, track]);

    // Two more copies of the scan, for the models. A shadow catcher: draws
    // nothing but the sun's shadows, so the models shade the real ground in
    // the footage. And an unlit copy in its scan texture on a layer only the
    // models' cube cameras see, which is what their hulls reflect.
    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        [t.shadowCatcher, t.envMesh].forEach((o) => {
            if (!o) return;
            t.modelRoot.remove(o);
            o.material.dispose();
        });
        t.shadowCatcher = null;
        t.envMesh = null;
        if (!t.mesh) return;
        const catcher = new THREE.Mesh(
            t.mesh.geometry,
            new THREE.ShadowMaterial({
                transparent: true,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -4,
            }),
        );
        catcher.receiveShadow = true;
        catcher.frustumCulled = false;
        catcher.visible = false;
        t.shadowCatcher = catcher;
        t.modelRoot.add(catcher);

        const src = t.materials.textured;
        const env = new THREE.Mesh(
            t.mesh.geometry,
            new THREE.MeshBasicMaterial({
                map: src?.map || null,
                color: src?.map ? 0xffffff : (src?.color || 0x808080),
                side: THREE.DoubleSide,
            }),
        );
        env.layers.set(ENV_LAYER);
        env.frustumCulled = false;
        t.envMesh = env;
        t.modelRoot.add(env);
        modelObjectsRef.current.forEach((rec) => { rec.envDirty = true; });
        t.needsRender = true;
    }, [track]);

    // ---- Audio -----------------------------------------------------------

    const attachAnalyser = useCallback(() => {
        const el = audioRef.current;
        if (!el || analyserRef.current) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        ctx.createMediaElementSource(el).connect(analyser);
        analyser.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    }, []);

    // Decoded separately from playback: the exporter cannot use a live
    // analyser, so it needs the samples to analyse offline.
    const loadAudio = useCallback(async (url, name) => {
        const el = audioRef.current;
        if (!el) return;
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = url.startsWith('blob:') ? url : null;

        el.src = url;
        el.load();
        setTrackName(name);
        setAudioReady(false);
        spectrogramRef.current = null;
        try {
            const buf = await fetch(url).then((r) => r.arrayBuffer());
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = audioCtxRef.current || new Ctx();
            audioCtxRef.current = ctx;
            audioBufferRef.current = await ctx.decodeAudioData(buf.slice(0));
            setAudioReady(true);
        } catch (e) {
            setStatus(`Could not decode audio: ${e.message}`);
        }
    }, []);

    const onAudioFile = useCallback((file) => {
        if (!file) return;
        loadAudio(URL.createObjectURL(file), file.name);
        setMusicSource({ type: 'file', name: file.name });
    }, [loadAudio]);

    const loadBundledTrack = useCallback((id) => {
        const m = MUSIC_ASSETS.find((x) => x.id === id);
        if (!m) return;
        loadAudio(`${process.env.PUBLIC_URL}/${m.path}`, m.name);
        setMusicSource({ type: 'bundled', id: m.id, name: m.name });
    }, [loadAudio]);

    // ---- Per-clip assets -------------------------------------------------

    useEffect(() => {
        if (!clip) return undefined;
        const t = three.current;
        if (!t.scene) return undefined;

        let alive = true;
        setStatus(`Loading ${clip.label}...`);
        setTrack(null);
        trackRef.current = null;

        // Drop whatever the previous take left behind.
        [t.mesh, t.cloud].forEach((obj) => {
            if (!obj) return;
            t.modelRoot.remove(obj);
            obj.geometry?.dispose();
            if (obj.material && obj.material !== t.materials.textured) {
                obj.material.dispose?.();
            }
        });
        if (t.materials.textured) {
            t.materials.textured.map?.dispose?.();
            t.materials.textured.dispose?.();
            t.materials.textured = null;
        }
        t.mesh = t.cloud = null;

        const base = `${process.env.PUBLIC_URL}/mv/${clip.id}`;

        // A take without a solve is still worth opening: the scan loads and
        // free orbit works, there is just no footage to lock onto.
        const trackP = fetch(`${base}/track.json`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
        const glbP = new GLTFLoader().loadAsync(`${base}/${clip.id}.glb`);
        const plyP = new PLYLoader().loadAsync(`${base}/${clip.id}.ply`);
        Promise.all([trackP, glbP, plyP])
            .then(([trackData, gltf, cloudGeo]) => {
                if (!alive) return;

                // --- mesh + wireframe
                let src = null;
                gltf.scene.updateMatrixWorld(true);
                gltf.scene.traverse((o) => {
                    if (!src && o.isMesh) src = o;
                });
                if (!src) throw new Error('no mesh in GLB');

                const geo = src.geometry.clone();
                geo.applyMatrix4(src.matrixWorld);
                geo.computeVertexNormals();

                t.materials.textured = src.material;
                const mesh = new THREE.Mesh(geo, src.material);
                mesh.frustumCulled = false;
                t.mesh = mesh;
                t.modelRoot.add(mesh);

                // PLY colours are sampled straight out of the scan's sRGB
                // texture, but three treats vertex colours as already being in
                // the linear working space. Without this the cloud reads
                // noticeably brighter than the same surface on the mesh.
                const colorAttr = cloudGeo.getAttribute('color');
                if (colorAttr) {
                    const a = colorAttr.array;
                    for (let i = 0; i < a.length; i++) {
                        a[i] = a[i] <= 0.04045
                            ? a[i] / 12.92
                            : ((a[i] + 0.055) / 1.055) ** 2.4;
                    }
                    colorAttr.needsUpdate = true;
                }

                cloudGeo.computeBoundingSphere();

                // Keep the scan's true positions; audio displacement is always
                // computed from these, never from the previous frame, so it
                // cannot accumulate drift.
                t.cloudReact = {
                    base: Float32Array.from(cloudGeo.getAttribute('position').array),
                    dirs: null,
                    dists: null,
                    freqIndex: null,
                    key: null,
                    dirty: false,
                };

                // Frame the free-orbit camera on the scan so switching to it
                // lands on the object rather than somewhere off in space.
                const sphere = cloudGeo.boundingSphere;
                if (sphere) {
                    t.controls.target.copy(sphere.center);
                    t.freeCamera.position.set(
                        sphere.center.x,
                        sphere.center.y,
                        sphere.center.z + sphere.radius * 2.6,
                    );
                    t.controls.update();
                }

                const cloud = new THREE.Points(
                    cloudGeo,
                    new THREE.PointsMaterial({ transparent: true }),
                );
                cloud.frustumCulled = false;
                t.cloud = cloud;
                t.modelRoot.add(cloud);

                // Without a solve there is no tracked camera to use, so fall
                // back to a plain viewer around the scan.
                const resolved = trackData || {
                    fps: 30,
                    frame_count: 1,
                    solved_count: 0,
                    frames: [],
                    intrinsics: { aspect: 4 / 3, width: 1440, height: 1080 },
                    unsolved: true,
                };
                setTrack(resolved);
                trackRef.current = resolved;
                // The layer state has not changed, so the effect that syncs
                // materials will not fire; push the current settings onto the
                // objects that were just built.
                applyLayers(layersRef.current);
                t.needsRender = true;

                if (resolved.unsolved) {
                    setRig((p) => ({ ...p, cameraMode: 'free' }));
                    setLayers((p) => ({ ...p, videoOn: false, meshOn: true }));
                    setStatus('No solve for this take — free orbit only');
                } else {
                    const pct = Math.round(
                        (resolved.solved_count / resolved.frame_count) * 100,
                    );
                    const q = resolved.alignment?.quality;
                    setStatus(
                        `${resolved.frame_count} frames, ${pct}% solved`
                        + (q ? ` · fit ${(q.inlier_fraction_2pct * 100).toFixed(0)}%` : ''),
                    );
                }

                // A project opened onto this take: put back what the load
                // has just reset to suit a fresh take.
                const pending = pendingProjectRef.current;
                if (pending && pending.clip === clip.id) {
                    pendingProjectRef.current = null;
                    pending.apply();
                }
            })
            .catch((e) => alive && setStatus(`Load failed: ${e.message}`));

        return () => { alive = false; };
    }, [clip, applyLayers]);

    // ---- Object mattes ----------------------------------------------------

    // The take's published mattes (Roto), decoded in step with the footage.
    const [takeMattes, setTakeMattes] = useState([]);
    useEffect(() => {
        const list = clipId ? mattesFor(clipId) : [];
        matteSetRef.current.set(clipId, list);
        setTakeMattes(list);
        three.current.needsRender = true;
    }, [clipId, mattesTick]);

    // The mattes this frame needs: those holding out, and those a window is
    // held to.
    const mattesInUse = useCallback(() => {
        const L = layersRef.current;
        if (!L.mattesOn) return { hold: [], all: [] };
        const set = matteSetRef.current;
        const hold = Array.from(set.tracks.keys()).filter((id) => (L.matteHoldout || {})[id] !== false);
        const all = new Set(hold);
        windowObjectsRef.current.forEach((w) => { if (w.op.matte && set.get(w.op.matte)) all.add(w.op.matte); });
        return { hold, all: Array.from(all) };
    }, []);

    // ---- Video element / texture ----------------------------------------

    // Each element gets its own texture; turning around swaps which one the
    // background quad samples.
    const makeTexture = (el) => {
        const tex = new THREE.VideoTexture(el);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        return tex;
    };

    const showVideo = useCallback((dir) => {
        const t = three.current;
        handoverRef.current = null;
        dirRef.current = dir;
        const tex = dir < 0 ? t.texRev : t.texFwd;
        if (tex && t.bgQuad) {
            t.videoTexture = tex;
            t.bgQuad.material.map = tex;
            t.bgQuad.material.needsUpdate = true;
        }
        t.videoDirty = 3;
        t.needsRender = true;
    }, []);

    const attachVideo = useCallback((el) => {
        videoRef.current = el;
        const t = three.current;
        if (!el || !t.bgQuad) return;
        t.texFwd?.dispose();
        t.texFwd = makeTexture(el);
        if (dirRef.current > 0) {
            t.videoTexture = t.texFwd;
            t.bgQuad.material.map = t.texFwd;
            t.bgQuad.material.needsUpdate = true;
        }
    }, []);

    const attachRevVideo = useCallback((el) => {
        revVideoRef.current = el;
        const t = three.current;
        if (!el) return;
        t.texRev?.dispose();
        t.texRev = makeTexture(el);
    }, []);

    // The reversed copy runs on its own clock, so its position has to be read
    // back as a position in the take. Scaled by the two durations rather than
    // subtracted outright, so a copy that lands a frame short still maps onto
    // the take exactly at both ends.
    const takeTime = useCallback((el) => {
        if (!el) return 0;
        if (dirRef.current >= 0) return el.currentTime;
        const d = videoRef.current?.duration || el.duration || 0;
        const rd = el.duration || d || 1;
        return Math.max(0, d - (el.currentTime * d) / rd);
    }, []);

    // Put the playhead at a position in the take, whichever copy is running.
    const seekTake = useCallback((at) => {
        const fwd = videoRef.current;
        const rev = revVideoRef.current;
        if (dirRef.current < 0 && rev) {
            const d = fwd?.duration || rev.duration || 1;
            const rd = rev.duration || d;
            rev.currentTime = Math.max(0, ((d - at) * rd) / d);
        } else if (fwd) {
            fwd.currentTime = at;
        }
    }, []);

    // Put the other copy on screen only once it has a frame of its own up.
    // Switching straight away uploads whatever that element last decoded -
    // the far end of the take - under the turnaround's pose for a frame or
    // two. Until then the outgoing copy holds its last frame, and the
    // playhead with it. `after` runs once the switch is made.
    const handOver = useCallback((el, dir, after) => {
        const token = {};
        handoverRef.current = token;
        const finish = () => {
            if (handoverRef.current !== token) return;
            handoverRef.current = null;
            showVideo(dir);
            after?.();
        };
        if (el.requestVideoFrameCallback) {
            el.requestVideoFrameCallback(finish);
        } else {
            el.addEventListener('seeked', finish, { once: true });
            el.addEventListener('playing', finish, { once: true });
        }
        // A paused element presents nothing new, so don't wait on it forever.
        setTimeout(finish, 300);
    }, [showVideo]);

    // Hand the clip back to the take, from the top.
    const goForward = useCallback(() => {
        const fwd = videoRef.current;
        const rev = revVideoRef.current;
        if (handoverRef.current) return;
        rev?.pause();
        if (!fwd) { showVideo(1); return; }
        // Normally parked there already, and re-seeking would only make the
        // decoder fetch the same frame again.
        if (fwd.currentTime > 0.001) fwd.currentTime = 0;
        if (playingRef.current && !exportingRef.current) {
            fwd.play().catch(() => {});
        }
        // Park the reversed copy at its start, ready for the next way back.
        handOver(fwd, 1, () => { if (rev) rev.currentTime = 0; });
    }, [showVideo, handOver]);

    // The take ran out going forwards. In ping-pong the reversed copy takes
    // over; in the other modes this is simply the end.
    //
    // `from` is where in the take to turn around, which is the end of the
    // clip when it played all the way out, but the end of the solved footage
    // when a take's tail has no camera and the gap skipper got there first.
    const goBackward = useCallback((from) => {
        const rev = revVideoRef.current;
        if (exportingRef.current || !playingRef.current) return;
        if (loopModeRef.current === 'bounce' && rev && revReadyRef.current) {
            if (dirRef.current < 0 || handoverRef.current) return;
            const fwd = videoRef.current;
            const d = fwd?.duration || rev.duration || 1;
            const rd = rev.duration || d;
            const at = Number.isFinite(from) ? Math.min(from, d) : d;
            fwd?.pause();
            const target = Math.max(0, ((d - at) * rd) / d);
            if (Math.abs(rev.currentTime - target) > 0.001) {
                rev.currentTime = target;
            }
            rev.playbackRate = speedRef.current;
            rev.play().catch(() => {});
            // Park the take at its top, ready for the way forward again.
            handOver(rev, -1, () => { if (fwd) fwd.currentTime = 0; });
            return;
        }
        if (loopModeRef.current === 'off') {
            playingRef.current = false;
            setIsPlaying(false);
        }
    }, [handOver]);

    // A video element reaches its last frame a little short of the duration
    // it reports, so the end has to be tested with some room.
    const atEnd = useCallback(
        (v) => v.ended || v.currentTime >= v.duration - 0.05, [],
    );

    useEffect(() => {
        loopModeRef.current = loopMode;
        // Leaving ping-pong mid-return hands the clip back to the take.
        if (loopMode !== 'bounce' && dirRef.current < 0) goForward();
    }, [loopMode, goForward]);

    // ---- Sizing ----------------------------------------------------------
    // The canvas is locked to the footage's aspect and letterboxed, so image
    // space and render space agree exactly and the overlay cannot drift.

    useEffect(() => {
        const mount = mountRef.current;
        const t = three.current;
        if (!mount || !t.renderer || !track) return undefined;

        const aspect = track.intrinsics.aspect;

        const resize = () => {
            if (exportingRef.current) return;
            const box = mount.parentElement;
            if (!box) return;
            const availW = box.clientWidth;
            const availH = box.clientHeight;
            if (!availW || !availH) return;

            let w = availW;
            let h = w / aspect;
            if (h > availH) { h = availH; w = h * aspect; }

            mount.style.width = `${Math.round(w)}px`;
            mount.style.height = `${Math.round(h)}px`;
            t.renderer.setSize(Math.round(w), Math.round(h), true);
            applyLayers(layersRef.current);
            t.needsRender = true;
        };

        resize();
        const ro = new ResizeObserver(resize);
        if (mount.parentElement) ro.observe(mount.parentElement);
        window.addEventListener('resize', resize);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', resize);
        };
    }, [track, applyLayers]);

    // ---- Pose sampling ---------------------------------------------------

    // Interpolating between the two bracketing solved frames keeps scrubbing
    // and slow motion smooth instead of stepping frame to frame.
    const poseAt = useCallback((time, trackData) => {
        const frames = trackData.frames;
        if (!frames.length) return null;
        const x = Math.max(0, Math.min(frames.length - 1, time * trackData.fps));
        const i0 = Math.floor(x);
        const i1 = Math.min(frames.length - 1, i0 + 1);
        const f = x - i0;
        const a = frames[i0];
        const b = frames[i1];

        const pos = new THREE.Vector3(a.p[0], a.p[1], a.p[2]);
        const quat = new THREE.Quaternion(a.q[0], a.q[1], a.q[2], a.q[3]);
        if (i1 !== i0 && f > 0) {
            pos.lerp(new THREE.Vector3(b.p[0], b.p[1], b.p[2]), f);
            quat.slerp(new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), f);
        }
        return { pos, quat, solved: a.solved && b.solved };
    }, []);

    // Rebuild the frustum from fx/fy/cx/cy rather than trusting a single fov.
    // An off-centre principal point is a real shear in the projection, and
    // ignoring it would slide the overlay across the frame.
    const applyIntrinsics = useCallback((cam, intr) => {
        const { fx, fy, cx, cy, width, height } = intr;
        const near = 0.005;
        const far = 200;
        const left = (-cx / fx) * near;
        const right = ((width - cx) / fx) * near;
        const top = (cy / fy) * near;
        const bottom = (-(height - cy) / fy) * near;
        cam.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
        cam.near = near;
        cam.far = far;
        // Not used for the projection (that is set above), but the gizmos
        // size themselves on screen from it.
        cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * fy)));
    }, []);

    useEffect(() => { applyLayers(layers); }, [layers, applyLayers, rig.cameraMode]);

    useEffect(() => {
        const t = three.current;
        if (!t.modelRoot) return;
        t.modelRoot.position.set(rig.offsetX, rig.offsetY, rig.offsetZ);
        t.modelRoot.rotation.set(
            THREE.MathUtils.degToRad(rig.rotX),
            THREE.MathUtils.degToRad(rig.rotY),
            THREE.MathUtils.degToRad(rig.rotZ),
        );
        t.modelRoot.scale.setScalar(rig.scale);
        // The nudge moves the models with the scan, but what they see of it
        // from where they stand is unchanged - except that it now sits at a
        // new place in the world their cube cameras are placed in.
        modelObjectsRef.current.forEach((rec) => { rec.envDirty = true; });
        if (t.controls) t.controls.enabled = rig.cameraMode === 'free';
        applyLayers(layersRef.current);
        t.needsRender = true;
    }, [rig, applyLayers]);

    // ---- Render loop -----------------------------------------------------

    // Point the sun, and fit its shadow camera round the placed models so
    // the shadow map's resolution is spent where the shadows fall.
    const placeSun = useCallback(() => {
        const t = three.current;
        if (!t.sun) return;
        const S = sunRef.current;
        const az = THREE.MathUtils.degToRad(S.azimuth);
        const el = THREE.MathUtils.degToRad(S.elevation);
        // In the scan's frame, then carried into the world with the nudge.
        const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        dir.applyQuaternion(t.modelRoot.getWorldQuaternion(new THREE.Quaternion())).normalize();
        t.sun.color.set(S.color);
        t.sun.intensity = S.intensity;
        t.ambient.intensity = S.ambient;
        t.fill.intensity = S.ambient * 0.64;

        const box = new THREE.Box3();
        modelObjectsRef.current.forEach((rec) => {
            if (rec.object.visible) box.expandByObject(rec.object);
        });
        propObjectsRef.current.forEach((rec) => {
            if (rec.ready && rec.object.visible && rec.op.castShadow) box.expandByObject(rec.object);
        });
        const casting = S.shadows && !box.isEmpty();
        t.sun.castShadow = casting;
        if (t.shadowCatcher) {
            t.shadowCatcher.visible = casting;
            t.shadowCatcher.material.opacity = S.shadowOpacity;
        }
        const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
        t.sun.target.position.copy(center);
        t.sun.target.updateMatrixWorld();
        t.sun.position.copy(center).addScaledVector(dir, 20);
        t.sun.updateMatrixWorld();
        if (casting) {
            // Big enough for the models and the shadows they throw at a low sun.
            const r = box.getBoundingSphere(new THREE.Sphere()).radius;
            const tall = box.max.y - box.min.y;
            const reach = r * 1.2 + Math.min(12, tall / Math.max(0.08, Math.tan(el)));
            const cam = t.sun.shadow.camera;
            cam.left = -reach;
            cam.right = reach;
            cam.top = reach;
            cam.bottom = -reach;
            cam.near = 1;
            cam.far = 40;
            cam.updateProjectionMatrix();
            t.sun.shadow.radius = S.shadowSoftness;
        }
    }, []);

    // Put every placed thing on the camera layer its item asks for, the
    // scan's own layers where the layer stack puts them, and every editing
    // marker on the overlay. Done each frame because models rebuild their
    // meshes. Returns how many things are behind the video.
    const assignLayers = useCallback(() => {
        const t = three.current;
        const L = layersRef.current;
        let behind = 0;
        const put = (obj, back) => {
            const mask = 1 << (back ? LAYER.BEHIND : LAYER.FRONT);
            obj.traverse((o) => {
                if (o.userData.handle) o.layers.set(LAYER.OVERLAY);
                else if (o.layers.mask !== mask) o.layers.mask = mask;
            });
            if (back && obj.visible) behind++;
        };
        const items = new Map(sceneItemsRef.current.map((i) => [i.id, i]));
        const isBack = (id) => items.get(id)?.op?.depthLayer === 'behind';
        modelObjectsRef.current.forEach((rec, id) => put(rec.object, isBack(id)));
        propObjectsRef.current.forEach((rec, id) => put(rec.object, isBack(id)));
        sceneObjectsRef.current.forEach((rec, id) => { if (rec.object3D) put(rec.object3D, isBack(id)); });
        const scanBack = !!L.scanBehind;
        [t.mesh, t.cloud, t.wire].forEach((o) => {
            if (!o) return;
            o.layers.set(scanBack ? LAYER.BEHIND : LAYER.FRONT);
            if (scanBack && o.visible) behind++;
        });
        // The depth-only scan hides things behind the real object on either side.
        if (t.occluder) { t.occluder.layers.set(LAYER.FRONT); t.occluder.layers.enable(LAYER.BEHIND); }
        return behind;
    }, []);

    // Markers stay the same size on screen however far off they are.
    const sizeHandles = useCallback((cam) => {
        const t = three.current;
        const h = t.cornerHandles;
        if (!h || !h.visible) return;
        const p = new THREE.Vector3();
        const s = new THREE.Vector3();
        const camAt = cam.getWorldPosition(new THREE.Vector3());
        h.parent.getWorldScale(s);
        h.children.forEach((m) => {
            m.getWorldPosition(p);
            const k = p.distanceTo(camAt) * (m.userData.active ? 0.016 : 0.011);
            m.scale.setScalar(k / Math.max(1e-6, s.x));
        });
    }, []);

    const renderFrame = useCallback((time, opts = {}) => {
        const t = three.current;
        const trackData = trackRef.current;
        if (!t.renderer || !trackData) return;

        const L = layersRef.current;
        const R = rigRef.current;
        let cam = t.camera;

        // VideoTexture only refreshes itself off the video's own frame
        // callbacks, which never fire while paused or mid-seek - so a still
        // frame can leave the quad showing an empty (white) texture. Upload
        // explicitly whenever the frame could have changed.
        //
        // The time comparison alone is not enough: an upload taken the instant
        // a seek lands can read a frame the decoder has not produced yet, and
        // since the time now matches, nothing ever uploads again and the
        // footage stays blank until playback resumes. So a settled seek asks
        // for several uploads and the texture is certain to catch up.
        const vid = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
        if (t.videoTexture && vid && vid.readyState >= 2) {
            const forced = (t.videoDirty || 0) > 0;
            if (!vid.paused || forced || t.lastVideoTime !== vid.currentTime) {
                t.videoTexture.needsUpdate = true;
                t.videoDirty = forced ? t.videoDirty - 1 : 0;
                t.lastVideoTime = vid.currentTime;
            }
        }

        if (R.cameraMode === 'free') {
            cam = t.freeCamera;
            const size = t.renderer.getSize(new THREE.Vector2());
            cam.aspect = size.x / Math.max(1, size.y);
            cam.updateProjectionMatrix();
            t.controls.update();
        } else {
            const pose = poseAt(time, trackData);
            if (pose) {
                cam.position.copy(pose.pos);
                cam.quaternion.copy(pose.quat);
                cam.updateMatrixWorld(true);
            }
            applyIntrinsics(cam, trackData.intrinsics);
        }
        // Picking and the pose gizmo work in whichever camera is drawing.
        t.activeCamera = cam;
        if (t.gizmo) t.gizmo.camera = cam;
        if (t.moveGizmo) t.moveGizmo.camera = cam;
        placeSun();

        // Rotoscoping on plain footage: just the frame, nothing over it.
        const ro = rotoRef.current;
        if (ro.on && ro.plain && !exportingRef.current) {
            const r0 = t.renderer;
            r0.setRenderTarget(null);
            r0.setClearColor(0x000000, 1);
            r0.clear();
            if (t.videoTexture) {
                const { visible } = t.bgQuad;
                const op = t.bgQuad.material.opacity;
                t.bgQuad.visible = true;
                t.bgQuad.material.opacity = 1;
                r0.render(t.bgScene, t.bgCamera);
                t.bgQuad.visible = visible;
                t.bgQuad.material.opacity = op;
            }
            return;
        }

        // Sort everything onto its camera layer: in front of the video or
        // behind it, with the editing markers on the overlay.
        const behindCount = assignLayers();
        placeCornerHandles();
        sizeHandles(cam);

        // With glow or haze on, the composite goes to the composer's buffer
        // and the passes finish it; otherwise straight to the canvas, so a
        // plain take costs nothing extra.
        const r = t.renderer;
        const fx = t.composer && (L.bloomStrength > 0 || L.haze > 0);
        const out = fx ? t.composer.readBuffer : null;
        // Placed objects count too, so the 3D pass still runs when the scan's
        // own layers are all off and only the scene is being composited.
        const drawScene = L.cloudOn || L.meshOn || L.wireOn || sceneObjectsRef.current.size
            || modelObjectsRef.current.size || propObjectsRef.current.size;
        const wins = Array.from(windowObjectsRef.current.values()).filter((w) => w.open);
        const footage = t.bgQuad.visible;
        const size = t.compositor.ensure();

        // Object mattes: the ones holding out what is in front of the video,
        // and each window's, if it is held to one. Only over the footage -
        // in free orbit a matte no longer lines up with anything.
        const mattes = matteSetRef.current;
        const inUse = mattesInUse();
        const holdTex = footage ? inUse.hold.map((id) => mattes.texture(id)).filter(Boolean) : [];
        const hold = holdTex.length > 0 && !!drawScene;
        wins.forEach((w) => w.setMatte(
            footage && L.mattesOn && w.op.matte ? mattes.texture(w.op.matte) : null, size,
        ));
        // With a holdout, everything up to the front pass is drawn aside, so
        // it can be laid back over the front pass where the matte is.
        const base = hold ? t.holdout.baseRT : out;
        if (hold) t.holdout.build(holdTex, size);

        // three works out the clear colour's encoding for whichever target is
        // bound when it is set (sRGB for the canvas, linear for a buffer), and
        // every render() resets it for its own target. So it is set again for
        // each target cleared here, or a buffer gets the canvas's numbers and
        // the backdrop comes out the wrong colour.
        const bg = t.backdrop || (t.backdrop = new THREE.Color());
        bg.set(L.bgColor);
        const clearTo = (target) => {
            r.setRenderTarget(target);
            r.setClearColor(bg, 1);
            r.clear();
        };

        if (!behindCount && !wins.length) {
            clearTo(base);
            if (footage) {
                r.render(t.bgScene, t.bgCamera);
                r.clearDepth();
            }
            if (!hold) {
                cam.layers.set(LAYER.FRONT);
                r.shadowMap.needsUpdate = true;
                if (drawScene) r.render(t.scene, cam);
            }
        } else {
            const comp = t.compositor;
            comp.ensure();
            const cutWins = footage ? wins.filter((w) => w.op.cut) : [];
            const fxWins = wins.filter((w) => w.hasFx);

            // 1. Behind the video, on its own, over the backdrop.
            clearTo(comp.behindRT);
            if (behindCount) {
                cam.layers.set(LAYER.BEHIND);
                r.shadowMap.needsUpdate = true;
                r.render(t.scene, cam);
            } else {
                // The target is multisampled, and its texture only receives
                // what was drawn (even a clear) when a render() finishes. With
                // nothing behind, it would otherwise never show the backdrop.
                comp.resolve();
            }

            // 2. That, the footage over it, and the windows cutting the
            //    footage back out.
            clearTo(fxWins.length ? comp.compRT : base);
            comp.blit(comp.behindRT.texture);
            if (footage) r.render(t.bgScene, t.bgCamera);
            if (cutWins.length) {
                wins.forEach((w) => { w.cutMesh.visible = cutWins.includes(w); comp.prepareCut(w); });
                cam.layers.set(LAYER.WIN_CUT);
                r.render(t.scene, cam);
            }

            // 3. Window effects, reading what 2 made.
            if (fxWins.length) {
                fxWins.filter((w) => w.op.sortOn).forEach((w) => comp.sortWindow(w, cam, !!opts.sortNow));
                clearTo(base);
                comp.blit(comp.compRT.texture);
                wins.forEach((w) => { w.fxMesh.visible = fxWins.includes(w); comp.prepareFx(w); });
                cam.layers.set(LAYER.WIN_FX);
                r.render(t.scene, cam);
            }

            // 4. In front of the video.
            if (!hold) {
                r.clearDepth();
                cam.layers.set(LAYER.FRONT);
                r.shadowMap.needsUpdate = true;
                if (drawScene) r.render(t.scene, cam);
            }
        }
        if (hold) {
            // 4, held out: the shot so far, the front pass over it, and the
            // shot again over that wherever a matted object is.
            clearTo(out);
            t.compositor.blit(t.holdout.baseRT.texture);
            cam.layers.set(LAYER.FRONT);
            r.shadowMap.needsUpdate = true;
            r.render(t.scene, cam);
            t.holdout.apply(t.holdout.baseRT.texture);
        }
        if (fx) {
            r.setRenderTarget(null);
            t.composer.render();
        }
        // Editing markers last, on the finished frame: never glowed, never
        // exported.
        if (!exportingRef.current) {
            r.setRenderTarget(null);
            cam.layers.set(LAYER.OVERLAY);
            r.render(t.scene, cam);
        }
        cam.layers.set(LAYER.FRONT);
    }, [poseAt, applyIntrinsics, placeSun, assignLayers, placeCornerHandles, sizeHandles, mattesInUse]);

    // Push the spectrum through the scan's own point cloud. Only the points
    // actually being drawn are touched, so the density slider doubles as the
    // cost control on a 300k-point cloud.
    const driveCloud = useCallback((frequencyData, playing) => {
        const t = three.current;
        const L = layersRef.current;

        // Same displacement for the wireframe, except computed per vertex and
        // scattered to both ends of every edge so the mesh stays welded.
        if (t.wire && t.wireState && t.wireBuffer) {
            applyWireReactivity(
                t.wireState, t.wireBuffer, t.wireEdges,
                {
                    reactivity: L.wireOn ? L.wireReact : 0,
                    scatter: L.cloudScatter,
                    freqLow: L.cloudFreqLow,
                    freqHigh: L.cloudFreqHigh,
                    ox: L.cloudPulseX, oy: L.cloudPulseY, oz: L.cloudPulseZ,
                },
                frequencyData, playing,
            );
        }

        if (!t.cloud || !t.cloudReact) return;
        const attr = t.cloud.geometry.getAttribute('position');
        const drawn = t.cloud.geometry.drawRange.count;
        const count = Number.isFinite(drawn) && drawn > 0
            ? drawn : attr.count;
        applyCloudReactivity(
            t.cloudReact, attr,
            {
                reactivity: L.cloudOn ? L.cloudReact : 0,
                scatter: L.cloudScatter,
                freqLow: L.cloudFreqLow,
                freqHigh: L.cloudFreqHigh,
                ox: L.cloudPulseX, oy: L.cloudPulseY, oz: L.cloudPulseZ,
            },
            frequencyData, playing, count,
        );
    }, []);

    // Fade layers with the music. One envelope off a chosen band drives every
    // layer that opted in, so points, wireframe, mesh and the placed scene
    // breathe or flash together rather than drifting apart.
    const driveOpacity = useCallback((frequencyData, playing) => {
        const t = three.current;
        const L = layersRef.current;
        const live = playing && !!frequencyData && L.opacityReact > 0;

        let mult = 1;
        if (live) {
            const level = bandLevel(
                frequencyData, L.opacityFreqLow, L.opacityFreqHigh,
            );
            const env = envelopeFollow(opacityEnvRef.current, level, {
                mode: L.opacityMode,
                threshold: L.opacityThreshold,
                invert: L.opacityInvert,
                smooth: L.opacitySmooth,
            });
            // Depth: at 1 the layer goes all the way out on a quiet band.
            mult = 1 - clamp01(L.opacityReact) * (1 - env);
        } else {
            opacityEnvRef.current.v = 0;
        }

        if (t.cloud) {
            const v = clamp01(L.cloudOpacity * (L.opacityPoints ? mult : 1));
            const m = t.cloud.material;
            m.opacity = v;
            m.transparent = v < 1;
            m.depthWrite = v >= 1;
        }
        if (t.wire) {
            // Fat lines are always blended; only the level moves.
            t.wire.material.opacity = clamp01(
                L.wireOpacity * (L.opacityWire ? mult : 1),
            );
        }
        if (t.mesh && L.meshOn) {
            const v = clamp01(L.meshOpacity * (L.opacityMesh ? mult : 1));
            const m = t.mesh.material;
            m.opacity = v;
            m.transparent = v < 1;
            m.depthWrite = v >= 1;
        }
        if (sceneObjectsRef.current.size) {
            applySceneOpacity(
                sceneObjectsRef.current,
                L.sceneOpacity * (L.opacityScene ? mult : 1),
            );
        }
        modelObjectsRef.current.forEach((rec) => {
            rec.setOpacity(L.sceneOpacity * (L.opacityScene ? mult : 1));
        });
        propObjectsRef.current.forEach((rec) => {
            rec.setOpacity(L.sceneOpacity * (L.opacityScene ? mult : 1));
        });
    }, []);

    // Pose and animate every placed model. `beat` is where the music is, in
    // seconds, for models whose nod follows the track (null: their own clock).
    // `beat` is where the music is (seconds; null with no track), and
    // `music` the decoded track, whose kicks the kick nod is read from.
    const driveModels = useCallback((dt, beat, music = null) => {
        const t = three.current;
        if (!modelObjectsRef.current.size || !t.renderer) return;
        const size = t.renderer.getDrawingBufferSize(new THREE.Vector2());
        modelObjectsRef.current.forEach((rec) => {
            // Reflections of the scan: captured again only when he or the
            // scan has moved, which is rarely, so it costs nothing per frame.
            if (rec.needsEnv && t.envMesh) {
                rec.captureEnv(t.renderer, t.scene, ENV_LAYER, metalEnvironment());
            }
            let kick = null;
            if (rec.op.nodMode === 'kick' && music && beat != null) {
                const env = kickEnvelope(music, rec.op.kickLow, rec.op.kickHigh);
                kick = {
                    hits: kickHits(env, rec.op.kickThreshold, rec.op.kickGap),
                    level: kickLevelAt(env, beat),
                    time: beat,
                };
            }
            rec.update(dt, {
                beatTime: rec.op.nodSync && beat != null ? beat : null,
                drawWidth: size.x,
                drawHeight: size.y,
                kick,
                music,
                musicTime: beat,
            });
        });
    }, []);

    // Props pulse with their modulators and screens follow the clock; windows
    // read theirs. `time` is where the music is (null without a track) and
    // `clock` the screens' clock: the music's, or a free one with no track.
    const driveProps = useCallback((dt, {
        music, time, take = null, clock, playing, exporting = false,
    }) => {
        propObjectsRef.current.forEach((rec) => {
            rec.update(dt, { music, time, clock, playing, exporting });
        });
        // A window shows at its drawn size only while one of its corners is
        // being dragged, so the shape being edited is the one on screen;
        // otherwise it animates, corner markers or not.
        const ed = editRef.current;
        const dragging = !!three.current.moveDragging;
        windowObjectsRef.current.forEach((rec, id) => rec.update(music, time, {
            take,
            hold: dragging && ed.mode === 'corners' && ed.itemId === id,
        }));
    }, []);

    // The selected item's modulator readouts in its panel: the level going
    // in, what comes out of the curve, and a dot on the curve.
    const driveModMeters = useCallback(() => {
        const sel = selectedIdRef.current;
        const ui = modUiRef.current;
        const show = (name, m, curve) => {
            const u = ui[name];
            if (!u) return;
            if (u.meter) u.meter.style.width = `${Math.round(Math.max(0, Math.min(1, m.input)) * 100)}%`;
            if (u.out) u.out.style.width = `${Math.round(Math.max(0, Math.min(1, m.value)) * 100)}%`;
            if (u.flash) u.flash.style.opacity = m.flash || 0;
            if (u.dot) placeCurveDot(u.dot, curve, m.x || 0, m.value > 0.001 || m.input > 0.001);
        };
        const p = propObjectsRef.current.get(sel);
        if (p) show('scale', p.mod, p.op.mod.curve);
        const w = windowObjectsRef.current.get(sel);
        if (w) {
            show('hue', w.hue, w.op.hueMod.curve);
            show('sort', w.sortLevel, w.op.sortMod.curve);
        }
        const m = modelObjectsRef.current.get(sel);
        if (m && m.mouth) show('mouth', m.mouth, m.op.mouth.curve);
    }, []);


    useEffect(() => {
        const t = three.current;
        if (!t.renderer) return undefined;

        const tick = () => {
            t.raf = requestAnimationFrame(tick);
            if (exportingRef.current) return;

            const now = performance.now();
            const dt = Math.min(0.1, (now - (lastTickRef.current || now)) / 1000);
            lastTickRef.current = now;

            const cov = coverageRef.current;
            const trackData = trackRef.current;
            const back = dirRef.current < 0;
            const video = back ? revVideoRef.current : videoRef.current;
            // Both copies are played forwards by the element itself, so the
            // only thing to work out is where in the take we are.
            let time = takeTime(video);

            // Hop over unsolved stretches. Checked every frame rather than on
            // seek, because a gap can be reached by playing into it, by
            // looping round, or by the user scrubbing into it.
            if (video && skipUnsolvedRef.current && cov.unsolved && cov.mask
                && trackData && !handoverRef.current) {
                const fps = trackData.fps;
                const idx = Math.floor(time * fps);
                if (idx >= cov.mask.length || !cov.mask[idx]) {
                    // Running the reversed copy, the next solved frame is the
                    // one behind the playhead rather than ahead of it.
                    const span = back
                        ? [...cov.spans].reverse().find((sp) => sp[1] < idx)
                        : cov.spans.find((sp) => sp[0] > idx);
                    const looping = loopModeRef.current !== 'off';
                    if (span) {
                        // Land just inside the span so rounding cannot drop
                        // the playhead back into the gap.
                        time = (back ? span[1] - 0.25 : span[0] + 0.25) / fps;
                        seekTake(time);
                    } else if (back) {
                        goForward();
                        time = 0;
                    } else if (loopModeRef.current === 'bounce'
                        && revReadyRef.current && playingRef.current
                        && cov.spans.length) {
                        // The solved footage has run out rather than the
                        // clip: turn around here instead of cutting back.
                        time = cov.spans[cov.spans.length - 1][1] / fps;
                        goBackward(time);
                    } else if (looping && cov.spans.length) {
                        time = (cov.spans[0][0] + 0.25) / fps;
                        seekTake(time);
                    } else if (playingRef.current) {
                        playingRef.current = false;
                        video.pause();
                        setIsPlaying(false);
                    }
                }
            }

            // Advance the placed objects from whatever the analyser hears.
            let freq = null;
            if (analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);
                freq = dataArrayRef.current;
            }
            const audioEl = audioRef.current;
            const audioLive = !!audioEl && !audioEl.paused;
            applyAudioReactivity(sceneObjectsRef.current, freq, dt, audioLive);
            driveCloud(freq, audioLive);
            driveOpacity(freq, audioLive);
            // A nod synced to the track reads the track's own clock, so it
            // stays on the beat through pauses, seeks and loops.
            const hasTrack = !!audioEl && !!audioEl.src && !!audioBufferRef.current;
            driveModels(dt, hasTrack ? audioEl.currentTime : null,
                hasTrack ? audioBufferRef.current : null);
            // Screens run on the music's clock, or on their own while the
            // transport plays when there is no track.
            if (!hasTrack && playingRef.current) freeClockRef.current += dt * speedRef.current;
            driveProps(dt, {
                music: hasTrack ? audioBufferRef.current : null,
                time: hasTrack ? audioEl.currentTime : null,
                take: time,
                clock: hasTrack ? audioEl.currentTime : freeClockRef.current,
                playing: playingRef.current,
            });
            driveModMeters();

            // The selected model's kick meter: its band's level, and a flash
            // on every hit the threshold lets through.
            const meter = kickMeterRef.current;
            if (meter) {
                const rec = modelObjectsRef.current.get(selectedIdRef.current);
                const k = rec?.kick;
                meter.style.width = `${Math.round((k ? k.level : 0) * 100)}%`;
                if (kickFlashRef.current) kickFlashRef.current.style.opacity = k ? k.flash : 0;
            }

            // Mattes onto the frame the footage is on.
            const mi = mattesInUse();
            if (mi.all.length && trackData) {
                const idx = Math.max(0, Math.min(trackData.frame_count - 1,
                    Math.floor(time * trackData.fps + 1e-3)));
                matteSetRef.current.follow(mi.all, idx, back);
            }

            renderFrame(time);
        };
        t.raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(t.raf);
    }, [renderFrame, driveCloud, driveOpacity, driveModels, driveProps, driveModMeters,
        track, takeTime, seekTake, goForward, goBackward, mattesInUse]);

    // ---- Views -----------------------------------------------------------

    const savePreset = useCallback((i) => {
        setPresets((prev) => {
            const next = [...prev];
            next[i] = { ...layersRef.current };
            return next;
        });
        setActivePreset(i);
    }, []);

    const recallPreset = useCallback((i) => {
        const snap = presetsRef.current[i];
        if (!snap) return;
        setLayers(snap);
        setActivePreset(i);
    }, []);

    // Editing a recalled view edits that view, so the slots behave like saved
    // looks you keep refining rather than snapshots that drift out of date.
    const setLayer = useCallback((key) => (value) => {
        setLayers((prev) => {
            const next = { ...prev, [key]: value };
            const i = activePresetRef.current;
            if (i != null && presetsRef.current[i]) {
                setPresets((ps) => {
                    const copy = [...ps];
                    copy[i] = next;
                    return copy;
                });
            }
            return next;
        });
    }, []);

    const setRigKey = useCallback((key) => (value) => {
        setRig((prev) => ({ ...prev, [key]: value }));
    }, []);

    const setSunKey = useCallback((key) => (value) => {
        setSun((prev) => ({ ...prev, [key]: value }));
    }, []);

    // ---- Projects --------------------------------------------------------
    // One JSON file holds the whole session: the take, the layer stack and
    // the nine views, the alignment nudge, playback, the free camera, every
    // placed object with its parameters (models with their pose), the track
    // and where it was, and the export settings.

    const saveProject = useCallback(() => {
        const t = three.current;
        const video = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
        const data = {
            format: PROJECT_FORMAT,
            version: PROJECT_VERSION,
            savedAt: new Date().toISOString(),
            take: clipId,
            layers: layersRef.current,
            rig: rigRef.current,
            views: presetsRef.current,
            activeView: activePresetRef.current,
            playback: {
                loopMode, speed, skipUnsolved, muted,
                time: video ? takeTime(video) : 0,
            },
            scene: {
                items: sceneItemsRef.current,
                selectedId,
                occlude,
            },
            camera: t.freeCamera ? {
                position: t.freeCamera.position.toArray(),
                target: t.controls.target.toArray(),
            } : null,
            music: musicSource ? {
                ...musicSource,
                time: audioRef.current ? audioRef.current.currentTime : 0,
            } : null,
            export: {
                scale: exportScale, quality: exportQuality,
                length: exportLength, loops: exportLoops,
                musicStart: exportMusicStart, videoStart: exportVideoStart,
            },
            sun: sunRef.current,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        a.download = `${clipId || 'scan'}-project-${stamp}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setStatus(`Saved project (${sceneItemsRef.current.length} objects)`);
    }, [clipId, loopMode, speed, skipUnsolved, muted, takeTime, selectedId,
        occlude, musicSource, exportScale, exportQuality, exportLength,
        exportLoops, exportMusicStart, exportVideoStart]);

    const openProject = useCallback((data) => {
        if (!data || data.format !== PROJECT_FORMAT) {
            throw new Error('not a Scan Compositor project file');
        }
        const pick = (v, ok, fallback) => (ok(v) ? v : fallback);
        const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

        const layersIn = { ...DEFAULT_LAYERS, ...(data.layers || {}) };
        const rigIn = { ...DEFAULT_RIG, ...(data.rig || {}) };
        setLayers(layersIn);
        layersRef.current = layersIn;
        const views = Array.from({ length: 9 }, (_, i) => {
            const v = Array.isArray(data.views) ? data.views[i] : null;
            return v ? { ...DEFAULT_LAYERS, ...v } : null;
        });
        setPresets(views);
        presetsRef.current = views;
        const av = data.activeView;
        setActivePreset(Number.isInteger(av) && views[av] ? av : null);

        const pb = data.playback || {};
        setLoopMode(pick(pb.loopMode, (v) => LOOP_MODES.some((m) => m.id === v), 'loop'));
        setSpeed(pick(pb.speed, isNum, 1));
        setSkipUnsolved(pb.skipUnsolved !== false);
        setMuted(!!pb.muted);

        const sc = data.scene || {};
        const items = (Array.isArray(sc.items) ? sc.items : []).map(reviveItem).filter(Boolean);
        setSceneItems(items);
        setSelectedId(items.some((i) => i.id === sc.selectedId) ? sc.selectedId : null);
        setOcclude(!!sc.occlude);
        setPoseEdit(false);
        setSun({ ...DEFAULT_SUN, ...(data.sun || {}) });

        const ex = data.export || {};
        setExportScale(pick(ex.scale, (v) => EXPORT_SCALES.some((e) => e.id === v), 1));
        setExportQuality(pick(ex.quality, (v) => EXPORT_QUALITY.some((e) => e.id === v), 0.4));
        setExportLength(pick(ex.length, (v) => EXPORT_LENGTHS.some((e) => e.id === v), 'clip'));
        setExportLoops(pick(ex.loops, isNum, 2));
        setExportMusicStart(pick(ex.musicStart, isNum, 0));
        setExportVideoStart(pick(ex.videoStart, isNum, 0));

        // A bundled track loads again by itself; a file off disk cannot be
        // reopened from a path, so say which one to upload.
        const mu = data.music;
        let note = '';
        if (mu && mu.type === 'bundled' && MUSIC_ASSETS.some((m) => m.id === mu.id)) {
            loadBundledTrack(mu.id);
            const el = audioRef.current;
            if (el && isNum(mu.time)) {
                el.addEventListener('loadedmetadata', () => {
                    el.currentTime = Math.min(mu.time, el.duration || mu.time);
                }, { once: true });
            }
        } else if (mu && mu.type === 'file') {
            note = ` · upload "${mu.name}" again for its music`;
        }

        // The rest has to wait for the take: loading one resets the rig, the
        // free camera and, for an unsolved take, a couple of layers.
        const apply = () => {
            const t = three.current;
            setRig(rigIn);
            rigRef.current = rigIn;
            setLayers(layersIn);
            const cam = data.camera;
            if (cam && t.freeCamera && Array.isArray(cam.position) && Array.isArray(cam.target)) {
                t.freeCamera.position.fromArray(cam.position);
                t.controls.target.fromArray(cam.target);
                t.controls.update();
            }
            const v = videoRef.current;
            if (v && isNum(pb.time)) {
                if (v.readyState >= 1) v.currentTime = pb.time;
                else v.addEventListener('loadedmetadata', () => { v.currentTime = pb.time; }, { once: true });
            }
            t.needsRender = true;
        };
        const take = clips.some((c) => c.id === data.take) ? data.take : clipId;
        if (data.take && take !== data.take) note += ` · take "${data.take}" is not published here`;
        if (take !== clipId) {
            pendingProjectRef.current = { clip: take, apply };
            setClipId(take);
        } else {
            apply();
        }
        setStatus(`Opened project: ${items.length} object${items.length === 1 ? '' : 's'}${note}`);
    }, [clips, clipId, loadBundledTrack]);

    const onProjectFile = useCallback((file) => {
        if (!file) return;
        file.text()
            .then((text) => openProject(JSON.parse(text)))
            .catch((e) => {
                // eslint-disable-next-line no-alert
                window.alert(`Could not open project: ${e.message}`);
            });
    }, [openProject]);

    // ---- Playback --------------------------------------------------------

    // One transport for both: the clip is a few seconds and loops, the music
    // runs its own length underneath, and they start and stop together.
    // Put the preview where the export will start, so the two can be
    // compared: the music at its start point, the take at its own.
    const cueExportStart = useCallback(() => {
        const a = audioRef.current;
        if (a && a.src) {
            try { a.currentTime = exportMusicStart; } catch (e) { /* not loaded */ }
        }
        if (dirRef.current < 0) {
            revVideoRef.current?.pause();
            showVideo(1);
            if (playingRef.current) videoRef.current?.play().catch(() => {});
        }
        seekTake(exportVideoStart);
        three.current.videoDirty = 3;
    }, [exportMusicStart, exportVideoStart, showVideo, seekTake]);

    // Roto mode holds the take still on a frame of the forward copy.
    const seekFrame = useCallback((k) => {
        const trackData = trackRef.current;
        if (!trackData) return;
        const f = Math.max(0, Math.min(trackData.frame_count - 1, Math.round(k)));
        if (dirRef.current < 0) {
            revVideoRef.current?.pause();
            showVideo(1);
        }
        // Mid-frame, so rounding cannot land on its neighbour.
        const at = (f + 0.5) / trackData.fps;
        seekTake(at);
        setCurrentTime(at);
        three.current.videoDirty = 3;
    }, [showVideo, seekTake]);

    useEffect(() => {
        if (!rotoOn) return;
        const v = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
        if (playingRef.current) {
            playingRef.current = false;
            v?.pause();
            audioRef.current?.pause();
            setIsPlaying(false);
        }
        const trackData = trackRef.current;
        if (trackData) seekFrame(Math.floor(takeTime(v) * trackData.fps + 1e-3));
    }, [rotoOn, seekFrame, takeTime]);

    // Leave Roto mode when the take changes; its session is per take.
    useEffect(() => { setRotoOn(false); }, [clipId]);

    const togglePlay = useCallback(() => {
        const v = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
        const a = audioRef.current;
        if (!v || exportingRef.current) return;
        // Roto mode works on one frame at a time.
        if (rotoRef.current.on && !playingRef.current) return;
        if (playingRef.current) {
            playingRef.current = false;
            v.pause();
            a?.pause();
            setIsPlaying(false);
            return;
        }
        playingRef.current = true;
        setIsPlaying(true);
        v.play().catch(() => {});
        if (a && a.src) {
            attachAnalyser();
            audioCtxRef.current?.resume?.();
            a.play().catch(() => {});
        }
    }, [attachAnalyser]);

    useEffect(() => {
        [videoRef.current, revVideoRef.current].forEach((v) => {
            if (v) v.playbackRate = speed;
        });
    }, [speed, clipId]);


    useEffect(() => {
        const onKey = (e) => {
            if (e.target.matches('input, select, textarea')) return;
            if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
            if (e.key >= '1' && e.key <= '9') {
                const i = Number(e.key) - 1;
                if (e.shiftKey) savePreset(i);
                else recallPreset(i);
                return;
            }
            const map = {
                v: 'videoOn', p: 'cloudOn', m: 'meshOn', w: 'wireOn',
            };
            const key = map[e.key.toLowerCase()];
            if (key) setLayer(key)(!layersRef.current[key]);
            if (e.key.toLowerCase() === 'f') {
                setRigKey('cameraMode')(
                    rigRef.current.cameraMode === 'free' ? 'tracked' : 'free',
                );
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, savePreset, recallPreset, setLayer, setRigKey]);

    // ---- Export ----------------------------------------------------------
    // Frame-accurate and independent of playback: the list of frames to write
    // is built first - the take, the way back if it is ping-ponging, repeated
    // to fill the music - and then each entry is decoded, posed from the
    // solve for exactly that frame, rendered and encoded. The soundtrack is
    // encoded from the decoded samples over the same list, so picture and
    // sound cannot drift however long the render takes.
    //
    // Pictures come straight from a WebCodecs decoder walking the file in
    // order (lib/mp4Frames), not from seeking the <video> element: a seek
    // re-decodes from the previous keyframe and round-trips the media
    // pipeline for every frame, which made export many times slower than the
    // preview. The way back of a ping-pong reads the reversed copy forwards,
    // exactly as playback does. Seeking remains as the fallback for a browser
    // or file the decoder cannot take.

    // The clip's own audio, which lives in the take's mp4. Decoded once per
    // take and kept, since the only thing that wants it is the exporter.
    const clipAudio = useCallback(() => {
        const id = clipId;
        const slot = clipAudioRef.current;
        if (!id) return Promise.resolve(null);
        if (slot.id === id) return slot.promise || Promise.resolve(slot.buffer);

        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = audioCtxRef.current || new Ctx();
        audioCtxRef.current = ctx;
        const promise = fetch(`${process.env.PUBLIC_URL}/mv/${id}/${id}.mp4`)
            .then((r) => r.arrayBuffer())
            .then((buf) => ctx.decodeAudioData(buf))
            .then((decoded) => {
                clipAudioRef.current = { id, buffer: decoded, promise: null };
                return decoded;
            })
            .catch(() => {
                // A take published before the pipeline started carrying audio
                // simply has none; that is not an error.
                clipAudioRef.current = { id, buffer: null, promise: null };
                return null;
            });
        clipAudioRef.current = { id, buffer: null, promise };
        return promise;
    }, [clipId]);

    // Lay out the export's soundtrack sample by sample.
    //
    // The clip's own sound is written per output frame, which is what keeps it
    // locked to the picture through everything the frame list can do: dropped
    // unsolved frames, repeats, and the reversed half of a ping-pong, where
    // the frame's audio is reversed with it. Music is read straight through
    // and wraps round, exactly as the <audio> element does in the preview.
    const buildExportAudio = useCallback(({
        frames, dirs, fps, music, musicOffset, clip: clipBuf,
    }) => {
        const rate = (music || clipBuf).sampleRate;
        const channels = Math.min(2, Math.max(
            music ? music.numberOfChannels : 1,
            clipBuf ? clipBuf.numberOfChannels : 1,
        ));
        const step = rate / fps;
        const total = Math.round(frames.length * step);
        if (!total) return null;

        const out = [];
        for (let c = 0; c < channels; c++) out.push(new Float32Array(total));

        if (music) {
            const src = [];
            for (let c = 0; c < channels; c++) {
                src.push(music.getChannelData(Math.min(c, music.numberOfChannels - 1)));
            }
            const start = Math.round(musicOffset * rate);
            const len = music.length;
            for (let i = 0; i < total; i++) {
                // Wrap rather than run out: the preview loops the track.
                const idx = ((start + i) % len + len) % len;
                for (let c = 0; c < channels; c++) out[c][i] += src[c][idx];
            }
        }

        if (clipBuf) {
            const src = [];
            for (let c = 0; c < channels; c++) {
                src.push(clipBuf.getChannelData(
                    Math.min(c, clipBuf.numberOfChannels - 1),
                ));
            }
            const len = clipBuf.length;
            for (let k = 0; k < frames.length; k++) {
                const from = Math.round(k * step);
                const to = Math.round((k + 1) * step);
                const span = to - from;
                const base = Math.round(frames[k] * step);
                const back = dirs[k] < 0;
                for (let j = 0; j < span; j++) {
                    const local = back ? span - 1 - j : j;
                    const idx = base + local;
                    if (idx < 0 || idx >= len) continue;
                    for (let c = 0; c < channels; c++) {
                        out[c][from + j] += src[c][idx];
                    }
                }
            }
        }

        // Two sources summed can exceed full scale; clip rather than let the
        // encoder wrap it round.
        for (let c = 0; c < channels; c++) {
            const a = out[c];
            for (let i = 0; i < a.length; i++) {
                if (a[i] > 1) a[i] = 1;
                else if (a[i] < -1) a[i] = -1;
            }
        }
        return { data: out, sampleRate: rate, channels, length: total };
    }, []);

    const startExport = useCallback(async () => {
        const video = videoRef.current;
        const trackData = trackRef.current;
        const t = three.current;
        if (!video || !trackData || exportingRef.current) return;
        if (typeof window.VideoEncoder === 'undefined'
            || typeof window.VideoFrame === 'undefined') {
            // eslint-disable-next-line no-alert
            window.alert('MP4 export needs WebCodecs support (Chrome / Edge / recent Safari).');
            return;
        }

        const intr = trackData.intrinsics;
        const w = Math.max(2, Math.round((intr.width * exportScale) / 2) * 2);
        const h = Math.max(2, Math.round((intr.height * exportScale) / 2) * 2);
        const fps = trackData.fps;

        // Exporting an unsolved frame would bake a frozen camera over moving
        // footage, so by default those frames are left out.
        const cov = coverageRef.current;
        const solved = (skipUnsolvedRef.current && cov.unsolved && cov.mask)
            ? Array.from(cov.mask).reduce((acc, ok, i) => {
                if (ok) acc.push(i);
                return acc;
            }, [])
            : Array.from({ length: trackData.frame_count }, (_, i) => i);
        if (!solved.length) {
            // eslint-disable-next-line no-alert
            window.alert('Nothing to export: no frames in this take are solved.');
            return;
        }

        // One cycle of the loop. Ping-pong adds the way back without
        // repeating either turnaround frame, so cycles butt together
        // seamlessly however many of them are written.
        const cycle = loopMode === 'bounce' && solved.length > 2
            ? solved.concat(solved.slice(1, -1).reverse())
            : solved.slice();

        const music = audioBufferRef.current;
        const musicOffset = music
            ? Math.max(0, Math.min(exportMusicStart, music.duration - 1 / fps))
            : 0;
        // The take starts at the first frame of the cycle at or after the
        // chosen start (in its forward half, for a ping-pong), and the cycle
        // runs on round from there.
        const startFrame = Math.round(Math.max(0, exportVideoStart) * fps);
        const startIdx = Math.max(0, cycle.findIndex((f) => f >= startFrame));
        let wanted = cycle.length;
        if (exportLength === 'audio' && music) {
            wanted = Math.max(1, Math.round((music.duration - musicOffset) * fps));
        } else if (exportLength === 'loops') {
            wanted = cycle.length * Math.max(1, Math.round(exportLoops));
        }

        const frames = new Int32Array(wanted);
        // Which way the clip is running at each output frame, so the audio
        // (and the picture's decoder) can follow it. Read off the frame's
        // place in the cycle - the second half of a ping-pong runs back -
        // rather than from neighbouring frames: a loop jumping back to its
        // start is not the clip reversing, and calling it that used to send
        // the first frame of every cycle to the reversed copy.
        const dirs = new Int8Array(wanted);
        const bounce = loopMode === 'bounce' && solved.length > 2;
        for (let i = 0; i < wanted; i++) {
            const pos = (i + startIdx) % cycle.length;
            frames[i] = cycle[pos];
            dirs[i] = bounce && pos >= solved.length ? -1 : 1;
        }
        const totalFrames = wanted;

        const bitrate = Math.min(
            120_000_000, Math.round(w * h * fps * exportQuality),
        );

        // A long render is far larger than anything worth holding in memory,
        // so write it straight to disk when the browser can. The picker has to
        // be opened while the click that started the export is still fresh,
        // which is why it comes before the codec probe.
        const estBytes = (bitrate / 8) * (totalFrames / fps);
        let fileStream = null;
        if (estBytes > 500_000_000 && window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: `${clipId}-composite.mp4`,
                    types: [{
                        description: 'MP4 video',
                        accept: { 'video/mp4': ['.mp4'] },
                    }],
                });
                fileStream = await handle.createWritable();
            } catch (e) {
                // Cancelled picker: fall back to assembling it in memory.
                fileStream = null;
            }
        }

        const codecCandidates = ['avc1.640034', 'avc1.640033', 'avc1.640028',
            'avc1.64001f', 'avc1.4d0028', 'avc1.42e01e'];
        let codec = null;
        for (const c of codecCandidates) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const support = await window.VideoEncoder.isConfigSupported({
                    codec: c, width: w, height: h, bitrate, framerate: fps,
                });
                if (support.supported) { codec = c; break; }
            } catch (e) { /* try next */ }
        }
        if (!codec) {
            // eslint-disable-next-line no-alert
            window.alert('No supported H.264 encoder found for this resolution.');
            if (fileStream) await fileStream.close();
            return;
        }

        exportingRef.current = true;
        exportCanceledRef.current = false;
        setIsExporting(true);
        setExportProgress(0);
        setExportStage('Preparing...');

        // Started now so the fetch and parse overlap the audio work below.
        // The reversed copy is only worth opening if the list runs backwards.
        const base = `${process.env.PUBLIC_URL}/mv/${clipId}/${clipId}`;
        const runsBack = dirs.some((d) => d < 0);
        const readersReady = Promise.all([
            Mp4FrameReader.open(`${base}.mp4`),
            runsBack ? Mp4FrameReader.open(`${base}_rev.mp4`) : null,
        ]);

        // A live analyser only hears what is playing now, which is no use to a
        // loop that renders frame 37 whenever it gets there. Analyse the
        // decoded samples up front so each frame gets the spectrum it would
        // have had in the preview.
        let spectrum = null;
        const L0 = layersRef.current;
        const scanReacts = (L0.cloudOn && L0.cloudReact > 0)
            || (L0.wireOn && L0.wireReact > 0)
            || L0.opacityReact > 0;
        if (music && (sceneItemsRef.current.length || scanReacts)) {
            setExportStage('Analysing audio...');
            await new Promise((r) => setTimeout(r, 0)); // let the label paint
            spectrum = computeSpectrogram(music, {
                fps, frameCount: totalFrames, offset: musicOffset,
            });
            spectrogramRef.current = spectrum;
        }

        // The take's own sound, plus the music, mixed over the frame list.
        setExportStage('Laying out audio...');
        const clipBuf = muted ? null : await clipAudio();
        const pcm = (music || clipBuf)
            ? buildExportAudio({
                frames, dirs, fps, music, musicOffset, clip: clipBuf,
            })
            : null;

        let audioCodec = null;
        if (pcm && typeof window.AudioEncoder !== 'undefined') {
            for (const [enc, box] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const sup = await window.AudioEncoder.isConfigSupported({
                        codec: enc,
                        sampleRate: pcm.sampleRate,
                        numberOfChannels: pcm.channels,
                        bitrate: 192_000,
                    });
                    if (sup.supported) { audioCodec = [enc, box]; break; }
                } catch (e) { /* try next */ }
            }
        }

        // Supersample unless the output is already enormous: a frame of points
        // and hairline edges is exactly the detail an encoder discards first,
        // and resolving it before the encoder sees it is most of what makes an
        // export look like the preview.
        const ss = w * h <= 3_600_000 ? EXPORT_SS : 1;
        const down = ss > 1 ? document.createElement('canvas') : null;
        let downCtx = null;
        if (down) {
            down.width = w;
            down.height = h;
            downCtx = down.getContext('2d', { alpha: false });
            downCtx.imageSmoothingEnabled = true;
            downCtx.imageSmoothingQuality = 'high';
        }

        const prevLoop = video.loop;
        const prevTime = video.currentTime;
        const prevSize = t.renderer.getSize(new THREE.Vector2());
        const prevRatio = t.renderer.getPixelRatio();
        const prevLayers = { ...layersRef.current };

        playingRef.current = false;
        revVideoRef.current?.pause();
        showVideo(1);
        video.loop = false;
        video.pause();
        setIsPlaying(false);
        opacityEnvRef.current.v = 0;
        // Models start from a known state, so twitches land the same way
        // every export, and the editing furniture stays out of the picture.
        modelObjectsRef.current.forEach((rec) => { rec.reset(); rec.hideHandles(true); });
        const gizmoWasVisible = t.gizmo?.visible;
        if (t.gizmo) t.gizmo.visible = false;
        const moveWasVisible = t.moveGizmo?.visible;
        if (t.moveGizmo) t.moveGizmo.visible = false;
        // Screens decode their own frames for the export, as the take does.
        setExportStage('Opening screen videos...');
        await Promise.all(Array.from(propObjectsRef.current.values()).map((rec) => rec.openExport()));
        setExportStage('Preparing...');
        t.ss = ss;
        t.renderer.setPixelRatio(1);
        t.renderer.setSize(w * ss, h * ss, false);
        applyLayers(layersRef.current);

        const seekTo = (time) => new Promise((resolve) => {
            if (Math.abs(video.currentTime - time) < 1 / 240 && video.readyState >= 2) {
                resolve();
                return;
            }
            let timer = null;
            const onSeeked = () => {
                clearTimeout(timer);
                video.removeEventListener('seeked', onSeeked);
                resolve();
            };
            timer = setTimeout(onSeeked, 2000); // fail-safe
            video.addEventListener('seeked', onSeeked);
            video.currentTime = time;
        });

        // The muxer takes its frame rate as the track's timescale and insists
        // on an integer, which 29.97 and 59.94 takes are not - they used to
        // fail here outright. NTSC rates are n/1001 exactly, so a timescale of
        // n gives every frame a whole number of ticks.
        const ntsc = Math.abs(fps * 1.001 - Math.round(fps * 1.001)) < 1e-3;
        const timescale = Number.isInteger(fps) ? fps
            : ntsc ? Math.round(fps * 1001) : 90000;
        const target = fileStream
            ? new FileSystemWritableFileStreamTarget(fileStream)
            : new ArrayBufferTarget();
        const muxer = new Muxer({
            target,
            video: { codec: 'avc', width: w, height: h, frameRate: timescale },
            ...(audioCodec ? {
                audio: {
                    codec: audioCodec[1],
                    numberOfChannels: pcm.channels,
                    sampleRate: pcm.sampleRate,
                },
            } : {}),
            // Streaming to disk cannot go back and rewrite the header, so the
            // index lands at the end of the file instead.
            fastStart: fileStream ? false : 'in-memory',
        });

        let encodeFailed = null;
        const encoder = new window.VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => { encodeFailed = e; },
        });
        encoder.configure({
            codec, width: w, height: h, bitrate, framerate: fps,
            latencyMode: 'quality',
        });

        let audioEncoder = null;
        if (audioCodec) {
            audioEncoder = new window.AudioEncoder({
                output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                error: (e) => { encodeFailed = e; },
            });
            audioEncoder.configure({
                codec: audioCodec[0],
                sampleRate: pcm.sampleRate,
                numberOfChannels: pcm.channels,
                bitrate: 192_000,
            });
        }

        // Sound is fed in step with the picture rather than all at once, so
        // the muxer sees both tracks in order and the file can be streamed
        // straight to disk.
        const AUDIO_CHUNK = 1024;
        let audioCursor = 0;
        const pumpAudio = (untilSample) => {
            if (!audioEncoder || !pcm) return;
            while (audioCursor < Math.min(untilSample, pcm.length)) {
                const n = Math.min(AUDIO_CHUNK, pcm.length - audioCursor);
                const planar = new Float32Array(n * pcm.channels);
                for (let c = 0; c < pcm.channels; c++) {
                    planar.set(
                        pcm.data[c].subarray(audioCursor, audioCursor + n),
                        c * n,
                    );
                }
                const data = new window.AudioData({
                    format: 'f32-planar',
                    sampleRate: pcm.sampleRate,
                    numberOfFrames: n,
                    numberOfChannels: pcm.channels,
                    timestamp: Math.round((audioCursor / pcm.sampleRate) * 1e6),
                    data: planar,
                });
                audioEncoder.encode(data);
                data.close();
                audioCursor += n;
            }
        };

        // The decoder path, if this browser and file allow it. Its pictures go
        // onto their own texture for the length of the export; the element's
        // textures are put back afterwards.
        let [fwdReader, revReader] = await readersReady;
        let frameTex = null;
        const prevMap = t.bgQuad.material.map;
        const dropReaders = () => {
            fwdReader?.close();
            revReader?.close();
            fwdReader = null;
            revReader = null;
            if (frameTex) {
                t.bgQuad.material.map = prevMap;
                t.bgQuad.material.needsUpdate = true;
                frameTex.dispose();
                frameTex = null;
            }
        };
        if (!fwdReader) {
            revReader?.close();
            revReader = null;
        }
        const nFwd = fwdReader ? fwdReader.frameCount : 0;
        // Take frame k on the reversed copy. Scaled rather than subtracted,
        // for the same reason as takeTime: a copy a frame short still lines
        // up at both ends.
        const revIndex = (k) => {
            const nRev = revReader.frameCount;
            const x = nFwd > 1 ? (k * (nRev - 1)) / (nFwd - 1) : 0;
            return Math.max(0, Math.min(nRev - 1, nRev - 1 - Math.round(x)));
        };
        // Upload a decoded picture as the footage. WebGL takes a VideoFrame
        // directly; if this one cannot, the GL error says so on the first
        // frame and the export carries on by seeking instead.
        const showDecoded = (vf) => {
            const gl = t.renderer.getContext();
            const probe = !frameTex;
            if (probe) {
                frameTex = new THREE.VideoTexture(vf);
                frameTex.colorSpace = THREE.SRGBColorSpace;
                frameTex.minFilter = THREE.LinearFilter;
                frameTex.magFilter = THREE.LinearFilter;
                t.bgQuad.material.map = frameTex;
                t.bgQuad.material.needsUpdate = true;
                while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
            }
            frameTex.image = vf;
            frameTex.needsUpdate = true;
            if (probe) {
                t.renderer.initTexture(frameTex);
                if (gl.getError() !== gl.NO_ERROR) return false;
            }
            return true;
        };

        // Per frame rather than accumulated, so a rate that is not a whole
        // number of microseconds per frame cannot drift.
        const stampUs = (i) => Math.round((i * 1_000_000) / fps);
        const gop = Math.max(1, Math.round(fps * 2));
        let completed = false;
        // Object mattes decode their exact frame too, from the reversed copy
        // wherever the take runs backwards.
        const matteIds = mattesInUse().all;
        setExportStage('Rendering...');
        // Timed from the end of the first frame, which carries the decoder
        // and texture setup and would make the early estimate wildly long.
        let started = 0;
        let lastReport = 0;
        const failed = () => !!encodeFailed;

        try {
            for (let i = 0; i < totalFrames; i++) {
                if (exportCanceledRef.current || encodeFailed) break;

                // i counts output frames; src is the frame of the take it came
                // from, which differs once unsolved frames are dropped and the
                // loop starts repeating.
                const src = frames[i];
                const time = Math.min(src / fps, Math.max(0, video.duration - 0.001));

                let decoded = false;
                if (fwdReader) {
                    const back = !!revReader && dirs[i] < 0;
                    // eslint-disable-next-line no-await-in-loop
                    const vf = back
                        ? await revReader.frame(revIndex(src))
                        : await fwdReader.frame(src);
                    if (vf && showDecoded(vf)) {
                        decoded = true;
                    } else if (!frameTex || i === 0) {
                        // Never worked: seek for the rest of the export.
                        dropReaders();
                    }
                }
                if (!decoded) {
                    if (frameTex) {
                        // A one-off miss: this frame comes off the element.
                        t.bgQuad.material.map = prevMap;
                        t.bgQuad.material.needsUpdate = true;
                    }
                    // eslint-disable-next-line no-await-in-loop
                    await seekTo(time);
                    if (t.videoTexture) t.videoTexture.needsUpdate = true;
                } else if (t.bgQuad.material.map !== frameTex) {
                    t.bgQuad.material.map = frameTex;
                    t.bgQuad.material.needsUpdate = true;
                }

                // Deterministic per-frame reactivity: the same dt every frame,
                // so an export is reproducible rather than tied to how fast
                // the encode happened to run.
                const freq = spectrum ? spectrum[i] : null;
                applyAudioReactivity(
                    sceneObjectsRef.current, freq, 1 / fps, !!spectrum,
                );
                driveCloud(freq, !!spectrum);
                driveOpacity(freq, !!spectrum);
                // The music wraps round in the export as in the preview.
                const musicTime = music
                    ? (musicOffset + i / fps) % Math.max(1e-6, music.duration)
                    : null;
                driveModels(1 / fps, musicTime, music);
                // Screens on the music's clock, or on the export's own.
                const screenClock = music ? musicTime : i / fps;
                // eslint-disable-next-line no-await-in-loop
                await Promise.all(Array.from(propObjectsRef.current.values())
                    .map((rec) => rec.exportFrame(screenClock)));
                driveProps(1 / fps, {
                    music, time: musicTime, take: time, clock: screenClock, playing: true, exporting: true,
                });

                if (matteIds.length) {
                    // eslint-disable-next-line no-await-in-loop
                    await matteSetRef.current.exact(matteIds, src, dirs[i] < 0);
                }

                renderFrame(time, { sortNow: true });

                let source = t.renderer.domElement;
                if (downCtx) {
                    downCtx.drawImage(t.renderer.domElement, 0, 0, w, h);
                    source = down;
                }
                const vf = new window.VideoFrame(source, {
                    timestamp: stampUs(i),
                    duration: stampUs(i + 1) - stampUs(i),
                });
                encoder.encode(vf, { keyFrame: i % gop === 0 });
                vf.close();

                pumpAudio(Math.round(((i + 1) / fps) * (pcm ? pcm.sampleRate : 0)));

                // eslint-disable-next-line no-await-in-loop
                await drainEncoders([encoder, audioEncoder], [8, 40], failed);

                // Every state update re-renders the whole tool, so the
                // progress readout is kept to a few times a second.
                const now = performance.now();
                if (i === 0) started = now;
                if (i > 0 && now - lastReport > 250) {
                    lastReport = now;
                    const rate = i / Math.max(0.001, (now - started) / 1000);
                    const left = (totalFrames - i - 1) / rate;
                    setExportProgress((i + 1) / totalFrames);
                    setExportStage(`Rendering ${i + 1}/${totalFrames} · `
                        + `${rate.toFixed(0)} fps · ${Math.ceil(left)}s left`);
                }
            }

            if (!exportCanceledRef.current && !encodeFailed) {
                setExportProgress(1);
                setExportStage('Finishing...');
                if (pcm) pumpAudio(pcm.length);
                await encoder.flush();
                if (audioEncoder) await audioEncoder.flush();
                muxer.finalize();
                completed = true;
            }
        } catch (e) {
            encodeFailed = e;
        } finally {
            dropReaders();
            try { encoder.close(); } catch (e) { /* already closed */ }
            try { audioEncoder?.close(); } catch (e) { /* already closed */ }
            if (fileStream) {
                try { await fileStream.close(); } catch (e) { /* gone */ }
            }
            video.loop = prevLoop;
            video.currentTime = prevTime;
            t.ss = 1;
            t.renderer.setPixelRatio(prevRatio);
            t.renderer.setSize(prevSize.x, prevSize.y, true);
            layersRef.current = prevLayers;
            applyLayers(prevLayers);
            modelObjectsRef.current.forEach((rec) => rec.hideHandles(false));
            if (t.gizmo) t.gizmo.visible = !!gizmoWasVisible;
            if (t.moveGizmo) t.moveGizmo.visible = !!moveWasVisible;
            propObjectsRef.current.forEach((rec) => rec.closeExport());
            exportingRef.current = false;
            setIsExporting(false);
            setExportProgress(0);
            setExportStage('');
        }

        if (completed && !fileStream) {
            const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${clipId}-composite.mp4`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } else if (encodeFailed) {
            // eslint-disable-next-line no-alert
            window.alert(`Export failed: ${encodeFailed.message || encodeFailed}`);
        }
        if (completed) {
            const secs = (totalFrames / fps).toFixed(1);
            setStatus(`Exported ${totalFrames} frames (${secs}s) at ${w}x${h}`
                + (audioCodec ? ' with sound' : ' (silent)'));
        }
    }, [clipId, exportScale, exportQuality, exportLength, exportLoops, loopMode,
        exportMusicStart, exportVideoStart,
        muted, renderFrame, applyLayers, driveCloud, driveOpacity, driveModels, driveProps,
        clipAudio, buildExportAudio, showVideo, mattesInUse]);

    // ---- Control helpers -------------------------------------------------

    const slider = (label, key, min, max, step, source = layers, setter = setLayer) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="range"
                className={styles.vfx_slider}
                min={min}
                max={max}
                step={step}
                value={source[key]}
                onChange={(e) => setter(key)(parseFloat(e.target.value))}
            />
            <VfxNumberField
                value={source[key]}
                min={min}
                max={max}
                step={step}
                onCommit={setter(key)}
            />
        </div>
    );

    const toggle = (label, key, source = layers, setter = setLayer) => (
        <div
            className={styles.vfx_checkRow}
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => setter(key)(!source[key])}
            onKeyDown={(e) => { if (e.key === 'Enter') setter(key)(!source[key]); }}
        >
            <span>{label}</span>
            <span className={`${styles.vfx_switch} ${source[key] ? styles.vfx_switchOn : ''}`}>
                <span className={styles.vfx_knob} />
            </span>
        </div>
    );

    const colorRow = (label, key) => (
        <div className={styles.vfx_row} key={key}>
            <span className={styles.vfx_label} title={label}>{label}</span>
            <input
                type="color"
                className={styles.vfx_color}
                style={{ gridColumn: '2 / 4' }}
                value={layers[key]}
                onChange={(e) => setLayer(key)(e.target.value)}
            />
        </div>
    );

    const fmt = (s) => {
        const m = Math.floor(s / 60);
        const r = (s % 60).toFixed(2).padStart(5, '0');
        return `${m}:${r}`;
    };

    // ---- Shared bits of the new panels ----

    const btnRow = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 };

    // A row of buttons picking one value.
    const segRow = (options, value, pick, cols = options.length) => (
        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {options.map(([id, name]) => (
                <button
                    key={String(id)}
                    type="button"
                    className={`${styles.vfx_segBtn} ${value === id ? styles.vfx_segBtnOn : ''}`}
                    onClick={() => pick(id)}
                >
                    {name}
                </button>
            ))}
        </div>
    );

    // Edit one field of an object inside the selected item's parameters
    // (a modulator), in the shape `slider` and `toggle` expect.
    const setNested = (field) => (key) => (value) => updateSelected((i) => ({
        ...i, op: { ...i.op, [field]: { ...MOD_DEFAULTS, ...(i.op[field] || {}), [key]: value } },
    }));

    // In front of the footage or behind it.
    const layerSeg = (op) => (
        <>
            <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>Layer</div>
            {segRow(LAYER_OPTIONS, op.depthLayer || 'front', (v) => setItemParam('depthLayer')(v), 2)}
        </>
    );

    // A modulator: what in the track drives it, and the curve it goes
    // through. `name` keys its live meter and curve dot.
    const meterRef = (name, part) => (el) => {
        modUiRef.current[name] = { ...(modUiRef.current[name] || {}), [part]: el };
    };
    const renderMod = (name, modIn, setMod, hint) => {
        const mod = { ...MOD_DEFAULTS, ...(modIn || {}) };
        const meterBox = {
            gridColumn: '2 / 4', position: 'relative', height: 10, background: 'rgba(255,255,255,0.08)', overflow: 'hidden',
        };
        return (
            <>
                {segRow([['off', 'Off'], ['band', 'Band level'], ['kick', 'Kick hits']], mod.source, (v) => setMod('source')(v))}
                {mod.source !== 'off' && (
                    <>
                        <div className={styles.vfx_row}>
                            <span className={styles.vfx_label}>In / out</span>
                            <div style={{ ...meterBox, height: 14 }}>
                                <div ref={meterRef(name, 'meter')} style={{ position: 'absolute', left: 0, top: 0, height: 7, width: '0%', background: 'var(--fg)', opacity: 0.55 }} />
                                <div ref={meterRef(name, 'out')} style={{ position: 'absolute', left: 0, bottom: 0, height: 7, width: '0%', background: 'var(--accent)', opacity: 0.85 }} />
                                <div ref={meterRef(name, 'flash')} style={{ position: 'absolute', inset: 0, background: 'var(--accent)', opacity: 0 }} />
                                {mod.source === 'kick' && (
                                    <div style={{ position: 'absolute', top: 0, height: 7, width: 2, left: `calc(${mod.threshold * 100}% - 1px)`, background: 'var(--accent)' }} />
                                )}
                            </div>
                        </div>
                        {slider('Low (Hz)', 'low', 20, 8000, 1, mod, setMod)}
                        {slider('High (Hz)', 'high', 30, 16000, 1, mod, setMod)}
                        {mod.source === 'kick' ? (
                            <>
                                {slider('Threshold', 'threshold', 0, 1, 0.005, mod, setMod)}
                                {slider('Min gap (s)', 'gap', 0.05, 1, 0.01, mod, setMod)}
                                {slider('Attack (s)', 'attack', 0.001, 0.3, 0.001, mod, setMod)}
                                {slider('Release (s)', 'release', 0.02, 2, 0.01, mod, setMod)}
                                <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>React to every</div>
                                {segRow([[1, 'kick'], [2, '2nd'], [4, '4th']], mod.every, (v) => setMod('every')(v))}
                            </>
                        ) : (
                            slider('Smoothing (s)', 'smooth', 0, 1, 0.005, mod, setMod)
                        )}
                        <div className={styles.vfx_hint} style={{ margin: '6px 0 5px' }}>
                            {mod.source === 'kick'
                                ? 'Motion after a hit: the curve is read from the hit (right) to fully released (left)'
                                : 'Map: band level in (across) to amount out (up)'}
                        </div>
                        <CurveEditor
                            points={mod.curve}
                            onChange={(pts) => setMod('curve')(pts)}
                            dotRef={meterRef(name, 'dot')}
                            xLabel={mod.source === 'kick' ? 'hit →' : 'level'}
                            yLabel="amount"
                        />
                        {toggle('Invert', 'invert', mod, setMod)}
                    </>
                )}
                {hint && <div className={styles.vfx_hint}>{hint}</div>}
            </>
        );
    };

    // Library sizing and, for screens, where the screen is on the model.
    // Edits here are to the asset, so they apply to every placed copy and
    // are saved apart from projects.
    const renderLibraryPanel = (item, entry, rec) => {
        const screen = { ...DEFAULT_SCREEN, ...(entry.screen || {}) };
        const setEntry = (key) => (v) => editAsset(entry.id, (a) => ({ ...a, [key]: v }));
        const setScreen = (key) => (v) => editAsset(entry.id, (a) => ({ ...a, screen: { ...DEFAULT_SCREEN, ...a.screen, [key]: v } }));
        const savedNote = {
            saving: 'Saving...',
            repo: 'Saved to src/data/scanAssetLibrary.json.',
            browser: 'Saved in this browser. No dev server to write the file here, so download the JSON and drop it over src/data/scanAssetLibrary.json to keep it.',
        }[librarySaved];
        return (
            <div className={styles.vfx_section}>
                <div className={styles.vfx_sectionTitle}>Library · {entry.name}</div>
                {segRow(CATEGORIES.map((c) => [c.id, c.name]), entry.category, (v) => setEntry('category')(v), 2)}
                {slider('Size (m)', 'size', 0.02, 3, 0.005, entry, setEntry)}
                {entry.category === 'screen' && (
                    <>
                        {toggle('Edit screen corners', 'editCorners', { editCorners: editMode === 'corners' },
                            () => (v) => setEditMode(v ? 'corners' : null))}
                        {editMode === 'corners' && (
                            <div className={styles.vfx_hint} style={{ marginBottom: 8 }}>
                                Click a corner marker (orange is picked; blue
                                in the middle moves the whole screen) and drag
                                the arrows. Top-left, top-right, bottom-right,
                                bottom-left as the picture should read.
                            </div>
                        )}
                        {editMode === 'corners' && segRow(
                            [[0, 'TL'], [1, 'TR'], [2, 'BR'], [3, 'BL'], [4, 'All']], cornerHandle, setCornerHandle, 5,
                        )}
                        {rec?.parts?.length > 0 && (
                            <select
                                className={styles.vfx_select}
                                style={{ marginBottom: 9 }}
                                value=""
                                onChange={(e) => {
                                    const part = rec.parts[parseInt(e.target.value, 10)];
                                    const corners = part && fitCornersToMesh(part.mesh, rec.norm);
                                    if (corners) setScreen('corners')(corners);
                                }}
                            >
                                <option value="">Fit the screen to a part...</option>
                                {rec.parts.map((p, i) => (
                                    // eslint-disable-next-line react/no-array-index-key
                                    <option key={i} value={i}>{p.name}{p.material ? ` (${p.material})` : ''}</option>
                                ))}
                            </select>
                        )}
                        {slider('Lift off surface', 'lift', 0, 0.05, 0.0001, screen, setScreen)}
                        <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>Default fit</div>
                        {segRow(VIDEO_FITS.slice(1), screen.fit, (v) => setScreen('fit')(v), 3)}
                    </>
                )}
                <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                    <button type="button" className={styles.vfx_segBtn} style={btnRow} onClick={saveLibraryNow}>
                        <Save size={12} />
                        Save
                    </button>
                    <button type="button" className={styles.vfx_segBtn} style={btnRow} onClick={() => downloadLibrary(libraryRef.current)}>
                        <FileDown size={12} />
                        Download .json
                    </button>
                </div>
                {savedNote && <div className={styles.vfx_fileName} style={{ whiteSpace: 'normal' }}>{savedNote}</div>}
                <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                    The library is the assets themselves, not this shot:
                    category, size and the screen&apos;s corners (in the
                    model&apos;s own units, so they survive any resizing).
                    Every change saves straight into the repo under npm
                    start, and into this browser either way.
                    {entry.credit ? ` ${entry.credit}.` : ''}
                </div>
            </div>
        );
    };

    const renderPropPanel = (item) => {
        const entry = library.assets.find((a) => a.id === item.assetId);
        if (!entry) {
            return (
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_hint}>&quot;{item.assetId}&quot; is not in the asset library.</div>
                </div>
            );
        }
        const op = item.op;
        const set = setItemParam;
        const rec = propObjectsRef.current.get(item.id);
        const isScreen = entry.category === 'screen';
        const takes = clips.map((c) => ({ id: `take:${c.id}`, name: `Take: ${c.label}` }));
        const missing = op.video && rec?.video?.missing;
        return (
            <>
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>{entry.name}</div>
                    {!rec?.ready && <div className={styles.vfx_hint} style={{ marginBottom: 6 }}>Loading...</div>}
                    {slider('Pos X', 'posX', -10, 10, 0.005, op, set)}
                    {slider('Pos Y', 'posY', -10, 10, 0.005, op, set)}
                    {slider('Pos Z', 'posZ', -10, 10, 0.005, op, set)}
                    {slider('Turn', 'rotY', -180, 180, 0.5, op, set)}
                    {slider('Tilt X', 'rotX', -180, 180, 0.5, op, set)}
                    {slider('Tilt Z', 'rotZ', -180, 180, 0.5, op, set)}
                    {slider('Scale', 'scale', 0.05, 8, 0.01, op, set)}
                    {toggle('Move in viewport', 'editMove', { editMove: editMode === 'move' },
                        () => (v) => setEditMode(v ? 'move' : null))}
                    {toggle('Casts a shadow', 'castShadow', op, set)}
                    {slider('Opacity', 'opacity', 0, 1, 0.01, op, set)}
                    {layerSeg(op)}
                    <div className={styles.vfx_hint}>
                        Stands with its base at the position, in the
                        scan&apos;s own frame. Behind the video, it only shows
                        through a window (or where the footage is faded).
                    </div>
                </div>

                {isScreen && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Screen</div>
                        {toggle('Screen on', 'screenOn', op, set)}
                        <select
                            className={styles.vfx_select}
                            style={{ marginBottom: 9 }}
                            value={op.video || ''}
                            onChange={(e) => {
                                if (e.target.value === '__upload') { videoInputRef.current.click(); return; }
                                set('video')(e.target.value || null);
                            }}
                        >
                            <option value="">No video</option>
                            <optgroup label="Takes">
                                {takes.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                            </optgroup>
                            <optgroup label="Bundled">
                                {PUBLIC_VIDEOS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                            </optgroup>
                            {uploads.length > 0 && (
                                <optgroup label="Uploaded (kept in this browser)">
                                    {uploads.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                                </optgroup>
                            )}
                            <option value="__upload">Upload a video...</option>
                        </select>
                        {missing && (
                            <div className={styles.vfx_hint} style={{ marginBottom: 8 }}>
                                That upload is not in this browser any more; upload it again.
                            </div>
                        )}
                        {op.video && op.video.startsWith('upload:') && (
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ ...btnRow, marginBottom: 9 }}
                                onClick={async () => {
                                    await deleteUpload(op.video);
                                    setUploads(await listUploads());
                                    set('video')(null);
                                }}
                            >
                                <Trash2 size={12} />
                                Forget this upload
                            </button>
                        )}
                        {slider('Start (s)', 'videoOffset', 0, Math.max(1, rec?.video?.duration || 30), 0.01, op, set)}
                        {slider('Rate', 'videoRate', 0, 4, 0.01, op, set)}
                        {slider('Brightness', 'brightness', 0, 4, 0.01, op, set)}
                        <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>Fit</div>
                        {segRow(VIDEO_FITS, op.fit ?? null, (v) => set('fit')(v), 4)}
                        <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>Turn the picture</div>
                        {segRow([[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], op.rotate || 0, (v) => set('rotate')(v), 4)}
                        {toggle('Mirror', 'flipX', op, set)}
                        <div className={styles.vfx_hint}>
                            Plays on the music&apos;s clock (its own with no
                            track), looping, from Start; an export decodes
                            the exact frame for every frame it writes. Uploads
                            are kept in this browser, so the screen still has
                            its picture after a reload. Brightness over 1
                            makes it glow with Glow on.
                        </div>
                    </div>
                )}

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Pulse</div>
                    {slider('Amount', 'reactAmount', -0.5, 1, 0.005, op, set)}
                    {slider('Width (X)', 'reactX', 0, 1, 0.01, op, set)}
                    {slider('Height (Y)', 'reactY', 0, 1, 0.01, op, set)}
                    {slider('Depth (Z)', 'reactZ', 0, 1, 0.01, op, set)}
                    {renderMod('scale', op.mod, setNested('mod'),
                        'Scale grows by Amount times the curve’s output, from the base up, on whichever axes you weight. Read from the decoded track, so the export pulses on exactly the frames the preview does.')}
                </div>

                {renderLibraryPanel(item, entry, rec)}
            </>
        );
    };

    const renderWindowPanel = (item) => {
        const op = item.op;
        const set = setItemParam;
        const selectRow = (label, key, options) => (
            <div className={styles.vfx_row} key={key}>
                <span className={styles.vfx_label}>{label}</span>
                <select
                    className={styles.vfx_select}
                    style={{ gridColumn: '2 / 4' }}
                    value={op[key]}
                    onChange={(e) => set(key)(e.target.value)}
                >
                    {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
            </div>
        );
        return (
            <>
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Window</div>
                    {toggle('Edit corners', 'editCorners', { editCorners: editMode === 'corners' },
                        () => (v) => setEditMode(v ? 'corners' : null))}
                    {editMode === 'corners' && segRow(
                        [[0, 'TL'], [1, 'TR'], [2, 'BR'], [3, 'BL'], [4, 'All']], cornerHandle, setCornerHandle, 5,
                    )}
                    {toggle('Show outline', 'outline', op, set)}
                    <button
                        type="button"
                        className={styles.vfx_select}
                        style={btnRow}
                        onClick={() => {
                            const t = three.current;
                            const cam = t.activeCamera || t.camera;
                            const C = op.corners.map((c) => t.modelRoot.localToWorld(new THREE.Vector3().fromArray(c)));
                            const mid = C.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(0.25);
                            const dist = Math.max(0.05, mid.distanceTo(cam.getWorldPosition(new THREE.Vector3())));
                            const size = (C[0].distanceTo(C[1]) + C[3].distanceTo(C[2])) / 2;
                            set('corners')(cornersFacing(cam, t.modelRoot, dist, size));
                        }}
                    >
                        <RotateCcw size={12} />
                        Square up to the camera
                    </button>
                    <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                        Four corners in the scan&apos;s own space, so the
                        window stays on its patch of the take as the camera
                        moves. Click a corner marker to move that corner, or
                        the middle one to move the whole window.
                    </div>
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Size over time</div>
                    {toggle('Animate', 'sizeOn', op, set)}
                    {op.sizeOn && (() => {
                        const hasMusic = !!audioBufferRef.current;
                        const music = hasMusic && op.sizeClock === 'music';
                        const dur = music
                            ? audioBufferRef.current.duration
                            : (videoRef.current?.duration || 0);
                        const max = Number.isFinite(dur) && dur > 0 ? Math.ceil(dur * 100) / 100 : 60;
                        const now = () => {
                            const v = music
                                ? audioRef.current?.currentTime || 0
                                : takeTime(dirRef.current < 0 ? revVideoRef.current : videoRef.current);
                            return Math.round(v * 100) / 100;
                        };
                        return (
                            <>
                                {hasMusic && segRow(
                                    [['take', 'Footage clock'], ['music', 'Music clock']],
                                    op.sizeClock, (v) => set('sizeClock')(v), 2,
                                )}
                                {slider('Start (s)', 'sizeFrom', 0, max, 0.01, op, set)}
                                {slider('End (s)', 'sizeTo', 0, max, 0.01, op, set)}
                                <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                                    <button type="button" className={styles.vfx_segBtn} onClick={() => set('sizeFrom')(now())}>
                                        Start at playhead
                                    </button>
                                    <button type="button" className={styles.vfx_segBtn} onClick={() => set('sizeTo')(now())}>
                                        End at playhead
                                    </button>
                                </div>
                                {slider('Start width', 'startW', 0, 3, 0.01, op, set)}
                                {slider('Start height', 'startH', 0, 3, 0.01, op, set)}
                                {slider('End width', 'endW', 0, 3, 0.01, op, set)}
                                {slider('End height', 'endH', 0, 3, 0.01, op, set)}
                                <div className={styles.vfx_hint} style={{ margin: '6px 0 5px' }}>Grows from</div>
                                {segRow(
                                    [['centre', 'Centre'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']],
                                    op.sizeAnchor, (v) => set('sizeAnchor')(v), 5,
                                )}
                                <div className={styles.vfx_hint} style={{ margin: '6px 0 5px' }}>Easing</div>
                                {segRow(
                                    [['linear', 'Linear'], ['in', 'In'], ['out', 'Out'], ['inOut', 'In-out']],
                                    op.sizeEase, (v) => set('sizeEase')(v), 4,
                                )}
                                <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                                    Width and height are multiples of the
                                    window as drawn (1 is its corners, 0 shut).
                                    It holds the start size before Start and
                                    the end size after End
                                    {music ? ', timed on the music' : ', timed on the footage, so a bounced or looped take plays it back with the footage'}.
                                    The corner markers stay on the drawn
                                    corners, and while you drag one the
                                    window shows at its drawn size.
                                </div>
                            </>
                        );
                    })()}
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Cut out the footage</div>
                    {toggle('Cut', 'cut', op, set)}
                    {slider('Opacity', 'cutOpacity', 0, 1, 0.01, op, set)}
                    {slider('Feather', 'feather', 0, 0.5, 0.005, op, set)}
                    <div className={styles.vfx_hint}>
                        Takes the footage out inside the window, so anything
                        set to Behind video shows through (and the backdrop
                        where there is nothing).
                    </div>
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Hold to a matte</div>
                    <div className={styles.vfx_row}>
                        <span className={styles.vfx_label}>Matte</span>
                        <select
                            className={styles.vfx_select}
                            style={{ gridColumn: '2 / 4' }}
                            value={op.matte || ''}
                            onChange={(e) => set('matte')(e.target.value)}
                        >
                            <option value="">None: the whole window</option>
                            {takeMattes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            {op.matte && !takeMattes.some((m) => m.id === op.matte) && (
                                <option value={op.matte}>(missing matte)</option>
                            )}
                        </select>
                    </div>
                    {op.matte && segRow(
                        [['inside', 'Inside the object'], ['outside', 'Outside it']],
                        op.matteMode, (v) => set('matteMode')(v), 2,
                    )}
                    <div className={styles.vfx_hint}>
                        {takeMattes.length
                            ? 'Keeps the cut and the effects to where an object matte is (or is not), within the window.'
                            : 'This take has no object mattes yet; make them in Roto mode, in the Scene panel.'}
                    </div>
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Hue shift</div>
                    {toggle('On', 'hueOn', op, set)}
                    {op.hueOn && (
                        <>
                            {slider('Base (°)', 'hueBase', -180, 180, 1, op, set)}
                            {slider('Swing (°)', 'hueAmount', -360, 360, 1, op, set)}
                            {slider('Saturation', 'hueSat', 0, 3, 0.01, op, set)}
                            {renderMod('hue', op.hueMod, setNested('hueMod'),
                                'The hue turns by Swing times the curve’s output, on top of Base.')}
                        </>
                    )}
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Pixel sort</div>
                    {toggle('On', 'sortOn', op, set)}
                    {op.sortOn && (
                        <>
                            {selectRow('Sort by', 'sortBy', SORT_BY)}
                            {selectRow('Threshold', 'thresholdMode', SORT_THRESHOLD)}
                            {op.thresholdMode !== 'none' && (
                                <>
                                    {slider('Low %', 'low', 0, 100, 1, op, set)}
                                    {slider('High %', 'high', 0, 100, 1, op, set)}
                                </>
                            )}
                            {segRow([['vertical', 'Vertical'], ['horizontal', 'Horizontal']], op.direction, (v) => set('direction')(v), 2)}
                            {slider('Seg max px', 'segmentMaxLength', 0, 2000, 10, op, set)}
                            {toggle('Reverse', 'reverse', op, set)}
                            {slider('RGB shift', 'rgbShift', 0, 64, 1, op, set)}
                            {slider('Resolution', 'sortScale', 0.1, 1, 0.05, op, set)}
                            {slider('Mix', 'sortMix', 0, 1, 0.01, op, set)}
                            <div className={styles.vfx_hint} style={{ margin: '6px 0 5px' }}>The music moves</div>
                            {segRow([['mix', 'Mix'], ['low', 'Threshold'], ['length', 'Length']], op.sortModTarget, (v) => set('sortModTarget')(v), 3)}
                            {slider('Depth', 'sortModAmount', 0, 1, 0.01, op, set)}
                            {renderMod('sort', op.sortMod, setNested('sortMod'),
                                'The Pixel Sorter’s engine on whatever is under the window: the footage, or what the cut reveals. Mix fades the sort in with the music; Threshold opens the band so more of the picture sorts; Length grows the streaks. The preview sorts a frame behind on a worker; an export sorts every frame exactly.')}
                        </>
                    )}
                </div>
            </>
        );
    };

    // The selected model's controls: how it is drawn, where it is, its pose,
    // the nod and the ears, and the body itself.
    const renderModelPanel = (item) => {
        // Sackboy shares this panel: the pose editor, nod and views are the
        // same idea on a different rig.
        const sack = item.modelId === 'sackboy';
        const op = { ...(sack ? SACKBOY_DEFAULTS : MODEL_DEFAULTS), ...item.op };
        const set = setItemParam;
        const btnStyle = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 };
        const seg = (key, options, cols = options.length) => (
            <div className={styles.vfx_segRow} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                {options.map(([id, name]) => (
                    <button
                        key={String(id)}
                        type="button"
                        className={`${styles.vfx_segBtn} ${op[key] === id ? styles.vfx_segBtnOn : ''}`}
                        onClick={() => set(key)(id)}
                    >
                        {name}
                    </button>
                ))}
            </div>
        );
        const colour = (label, key) => (
            <div className={styles.vfx_row} key={key}>
                <span className={styles.vfx_label} title={label}>{label}</span>
                <input
                    type="color"
                    className={styles.vfx_color}
                    style={{ gridColumn: '2 / 4' }}
                    value={op[key]}
                    onChange={(e) => set(key)(e.target.value)}
                />
            </div>
        );
        const ang = item.pose[poseJoint] || [0, 0, 0];
        const angSrc = { x: ang[0], y: ang[1], z: ang[2] };
        const angSet = (k) => setJointAngle(poseJoint, { x: 0, y: 1, z: 2 }[k]);
        const legLocked = op.plantFeet && LEG_JOINTS.includes(poseJoint);
        const other = mirrorJoint(poseJoint);
        const spawn = sack ? SACKBOY_SPAWNS[clipId] : MODEL_SPAWNS[clipId];
        const rec = modelObjectsRef.current.get(item.id);
        const poses = sack ? SACKBOY_POSES : POSES;
        const jointMenu = sack ? SACKBOY_JOINT_MENU : JOINTS;
        const colourName = sack ? 'Texture' : 'Part colours';

        return (
            <>
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>{sack ? 'Sackboy' : 'Protagonist'}</div>
                    {sack && !rec?.ready && <div className={styles.vfx_hint} style={{ marginBottom: 6 }}>Loading...</div>}
                    {/* Toggles rather than one choice: any mix can be on. */}
                    <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                        {MODEL_VIEWS.map((v) => (
                            <button
                                key={v.key}
                                type="button"
                                aria-pressed={!!op[v.key]}
                                className={`${styles.vfx_segBtn} ${op[v.key] ? styles.vfx_segBtnOn : ''}`}
                                onClick={() => set(v.key)(!op[v.key])}
                            >
                                {v.name}
                            </button>
                        ))}
                    </div>
                    {op.viewWire && (
                        <>
                            <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Wireframe</div>
                            {sack && seg('wireMode', [['all', 'Every edge'], ['feature', 'Creases only']], 2)}
                            {sack && op.wireMode === 'feature' && slider('Crease angle', 'wireAngle', 1, 90, 1, op, set)}
                            {seg('wireColorMode', [['model', colourName], ['solid', 'Solid']], 2)}
                            {op.wireColorMode === 'solid' && colour('Colour', 'wireColor')}
                            {slider('Thickness', 'wireThickness', 0.0002, 0.008, 0.0001, op, set)}
                        </>
                    )}
                    {op.viewPoints && (
                        <>
                            <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Points</div>
                            {seg('pointColorMode', [['model', colourName], ['solid', 'Solid']], 2)}
                            {op.pointColorMode === 'solid' && colour('Colour', 'pointColor')}
                            {slider('Points', 'pointCount', 2000, 150000, 1000, op, set)}
                            {slider('Size', 'pointSize', 0.001, 0.05, 0.0005, op, set)}
                        </>
                    )}
                    {!op.viewTextured && (op.viewWire || op.viewPoints)
                        && toggle('Hide far side', 'selfOcclude', op, set)}
                    {slider('Opacity', 'opacity', 0, 1, 0.01, op, set)}
                    {layerSeg(op)}
                    {sack ? (
                        <div className={styles.vfx_hint}>
                            Turn on any mix. Textured is his own knitted
                            skin; the wireframe is every edge of his mesh (or
                            only its creases); points are scattered over him by
                            area. Lines and points are skinned to his bones, so
                            they follow every pose and nod.
                        </div>
                    ) : (
                    <div className={styles.vfx_hint}>
                        Turn on any mix. Textured is the game&apos;s own hull;
                        wireframe is every part&apos;s feature edges; points are
                        scattered over the surface by area. With the hull on,
                        lines and points draw over it; without it, Hide far
                        side lays the body&apos;s depth down first so only the
                        near side shows.
                        {!op.viewTextured && !op.viewWire && !op.viewPoints
                            && ' (All three are off, so he is invisible.)'}
                    </div>
                    )}
                </div>

                {!sack && (
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Finish</div>
                    <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Reflects</div>
                    {seg('reflectSource', [['scan', 'The scan'], ['sky', 'Banded sky']], 2)}
                    {FINISH_FIELDS.map(([key, label, min, max, step]) => slider(label, key, min, max, step, op, set))}
                    {toggle('Casts a shadow', 'castShadow', op, set)}
                    <div className={styles.vfx_hint} style={{ margin: '10px 0 5px' }}>Hull texture</div>
                    {TEXTURE_FIELDS.map(([key, label, min, max, step]) => slider(label, key, min, max, step, op, set))}
                    {toggle('Dither', 'texDither', op, set)}
                    <button
                        type="button"
                        className={styles.vfx_select}
                        style={btnStyle}
                        onClick={() => updateSelected((i) => {
                            const reset = Object.fromEntries([...FINISH_FIELDS, ...TEXTURE_FIELDS]
                                .map(([k]) => [k, MODEL_DEFAULTS[k]]));
                            return { ...i, op: { ...i.op, ...reset, texDither: MODEL_DEFAULTS.texDither } };
                        })}
                    >
                        <RotateCcw size={12} />
                        Reset finish
                    </button>
                    <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                        tetra&apos;s hull: periodic noise, posterized and
                        dithered, darkening the panel colours, under a Phong
                        highlight from the sun. Reflecting the scan captures
                        the take&apos;s own textured surroundings from where he
                        stands (again whenever he moves), over the sky where
                        the scan has nothing.
                    </div>
                </div>
                )}

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Placement</div>
                    {slider('Pos X', 'posX', -10, 10, 0.005, op, set)}
                    {slider('Pos Y', 'posY', -10, 10, 0.005, op, set)}
                    {slider('Pos Z', 'posZ', -10, 10, 0.005, op, set)}
                    {slider('Turn', 'rotY', -180, 180, 0.5, op, set)}
                    {slider('Tilt X', 'rotX', -45, 45, 0.5, op, set)}
                    {slider('Tilt Z', 'rotZ', -45, 45, 0.5, op, set)}
                    {slider('Scale', 'scale', 0.1, 3, 0.01, op, set)}
                    {sack && slider('Height (m)', 'height', 0.1, 2.5, 0.01, op, set)}
                    {sack && toggle('Casts a shadow', 'castShadow', op, set)}
                    {toggle('Move in viewport', 'editMove', { editMove: editMode === 'move' },
                        () => (v) => setEditMode(v ? 'move' : null))}
                    {spawn && (
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={btnStyle}
                            onClick={() => updateSelected((i) => ({ ...i, op: { ...i.op, ...spawn.op, rotX: 0, rotZ: 0, scale: 1 } }))}
                        >
                            <RotateCcw size={12} />
                            Back on the bench
                        </button>
                    )}
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Pose</div>
                    <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                        {Object.entries(poses).map(([id, p]) => (
                            <button key={id} type="button" className={styles.vfx_segBtn} onClick={() => applyPosePreset(id)}>
                                {p.name}
                            </button>
                        ))}
                    </div>
                    {toggle('Edit in viewport', 'poseEdit', { poseEdit }, () => setPoseEdit)}
                    <select
                        className={styles.vfx_select}
                        style={{ marginBottom: 9 }}
                        value={poseJoint}
                        onChange={(e) => pickJoint(e.target.value)}
                    >
                        {jointMenu.map(([id, label]) => (
                            <option key={id} value={id}>{label}</option>
                        ))}
                    </select>
                    {legLocked ? (
                        <div className={styles.vfx_hint} style={{ marginBottom: 9 }}>
                            Planted feet are driving this joint. Turn them off
                            below (or pick the joint again) to pose it by hand.
                        </div>
                    ) : (
                        <>
                            {slider('Pitch (X)', 'x', -180, 180, 0.5, angSrc, angSet)}
                            {slider('Yaw (Y)', 'y', -180, 180, 0.5, angSrc, angSet)}
                            {slider('Roll (Z)', 'z', -180, 180, 0.5, angSrc, angSet)}
                        </>
                    )}
                    <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                        <button
                            type="button"
                            className={styles.vfx_segBtn}
                            disabled={!other}
                            title={other ? `Copy onto the ${JOINTS.find(([j]) => j === other)?.[1].toLowerCase()}` : 'No other side'}
                            onClick={() => mirrorPose(poseJoint)}
                        >
                            Mirror across
                        </button>
                        <button
                            type="button"
                            className={styles.vfx_segBtn}
                            onClick={() => {
                                const rest = sack
                                    ? SACKBOY_POSES.stand.make().pose[poseJoint]
                                    : POSES.stand.make(bodyDims(specOf(op).body)).pose[poseJoint];
                                updateSelected((i) => ({ ...i, pose: { ...i.pose, [poseJoint]: rest } }));
                            }}
                        >
                            Reset joint
                        </button>
                    </div>
                    {sack ? (
                        <>
                            {slider('Hip height', 'hipHeight', -0.1, 0.6, 0.002, op, set)}
                            {slider('Hips fwd', 'hipForward', -0.2, 0.2, 0.002, op, set)}
                            {toggle('Plant feet', 'plantFeet', op, set)}
                            {op.plantFeet && (
                                <>
                                    {slider('Feet fwd', 'footForward', -0.2, 0.4, 0.002, op, set)}
                                    {slider('Feet apart', 'footSpread', -0.06, 0.2, 0.002, op, set)}
                                </>
                            )}
                        </>
                    ) : (
                        <>
                            {slider('Hip height', 'hipHeight', 0.2, 1.3, 0.005, op, set)}
                            {slider('Hips fwd', 'hipForward', -0.4, 0.4, 0.005, op, set)}
                            {toggle('Plant feet', 'plantFeet', op, set)}
                            {op.plantFeet && (
                                <>
                                    {slider('Feet fwd', 'footForward', -0.3, 0.9, 0.005, op, set)}
                                    {slider('Feet apart', 'footSpread', -0.1, 0.35, 0.005, op, set)}
                                </>
                            )}
                        </>
                    )}
                    {slider('Breathing', 'breathe', 0, 2, 0.01, op, set)}
                    <div className={styles.vfx_hint}>
                        {sack
                            ? 'Angles are in his body\u2019s frame (X pitches about his left-right axis, Y turns, Z rolls) on top of the T-pose he was rigged in; hip height is in his own units above his feet (0.29 standing). '
                            : 'Angles are on top of standing with the arms hanging. '}
                        With Edit in viewport on, click a joint marker (blue
                        left, pink right) and drag the rings. Planted feet keep
                        the feet on the ground while the hips move; grabbing a
                        leg joint hands the legs back to you.
                    </div>
                </div>

                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Head nod</div>
                    {toggle('Nod', 'nodOn', op, set)}
                    {seg('nodMode', [['bpm', 'To a tempo'], ['kick', 'On the kick']], 2)}
                    {op.nodMode === 'kick' && (
                        <>
                            <div className={styles.vfx_row}>
                                <span className={styles.vfx_label}>Kick level</span>
                                <div
                                    style={{
                                        gridColumn: '2 / 4',
                                        position: 'relative',
                                        height: 10,
                                        background: 'rgba(255,255,255,0.08)',
                                        overflow: 'hidden',
                                    }}
                                >
                                    <div
                                        ref={kickMeterRef}
                                        style={{ position: 'absolute', inset: '0 auto 0 0', width: '0%', background: 'var(--fg)', opacity: 0.55 }}
                                    />
                                    <div
                                        ref={kickFlashRef}
                                        style={{ position: 'absolute', inset: 0, background: 'var(--accent)', opacity: 0 }}
                                    />
                                    <div
                                        style={{
                                            position: 'absolute', top: 0, bottom: 0, width: 2,
                                            left: `calc(${op.kickThreshold * 100}% - 1px)`,
                                            background: 'var(--accent)',
                                        }}
                                    />
                                </div>
                            </div>
                            {slider('Threshold', 'kickThreshold', 0, 1, 0.005, op, set)}
                            {slider('Low (Hz)', 'kickLow', 20, 300, 1, op, set)}
                            {slider('High (Hz)', 'kickHigh', 40, 500, 1, op, set)}
                            {slider('Min gap (s)', 'kickGap', 0.05, 1, 0.01, op, set)}
                            {slider('Release (s)', 'nodRelease', 0.05, 1.2, 0.01, op, set)}
                            {op.nodOn && (
                                <>
                                    {slider('Depth', 'nodDepth', 0, 40, 0.5, op, set)}
                                    {slider('Groove', 'nodGroove', 0, 1.5, 0.01, op, set)}
                                    <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>Nod on every</div>
                                    {seg('nodEvery', [[1, 'kick'], [2, '2nd kick'], [4, '4th kick']])}
                                </>
                            )}
                            <div className={styles.vfx_hint}>
                                Play the track and watch the meter: the bar is
                                the kick band&apos;s level and flashes on every
                                hit. Set the threshold just under where the
                                kicks peak and above everything else. A hit
                                counts on the way up, so a long kick is one nod;
                                min gap stops a flam counting twice. The kicks
                                are found once from the whole track, not from
                                what is playing, so an export nods on exactly
                                the kicks the preview does, sound or no sound.
                                1 on the meter is the track&apos;s loudest kicks.
                            </div>
                        </>
                    )}
                    {op.nodOn && op.nodMode !== 'kick' && (
                        <>
                            <div className={styles.vfx_row}>
                                <span className={styles.vfx_label}>BPM</span>
                                <input
                                    type="range"
                                    className={styles.vfx_slider}
                                    min={40}
                                    max={200}
                                    step={0.5}
                                    value={op.bpm}
                                    onChange={(e) => set('bpm')(parseFloat(e.target.value))}
                                />
                                <VfxNumberField value={op.bpm} min={20} max={300} step={0.1} onCommit={set('bpm')} />
                            </div>
                            <button type="button" className={styles.vfx_select} style={{ ...btnStyle, marginBottom: 9 }} onClick={tapTempo}>
                                Tap tempo
                            </button>
                            {slider('Depth', 'nodDepth', 0, 40, 0.5, op, set)}
                            {slider('Snap', 'nodSharpness', 0.5, 6, 0.05, op, set)}
                            {slider('Beat offset', 'nodPhase', 0, 1, 0.01, op, set)}
                            {slider('Groove', 'nodGroove', 0, 1.5, 0.01, op, set)}
                            <div className={styles.vfx_hint} style={{ margin: '4px 0 5px' }}>Nod every</div>
                            {seg('nodEvery', [[1, '1 beat'], [2, '2 beats'], [4, '4 beats']])}
                            {toggle('Follow the track', 'nodSync', op, set)}
                        </>
                    )}
                    {op.nodMode !== 'kick' && (
                        <div className={styles.vfx_hint}>
                            Head down on the beat. Following the track reads the
                            beat off the loaded music&apos;s clock, so the nod stays
                            on it through pauses, seeks and exports; beat offset
                            lines it up with the downbeat. Snap shortens the dip.
                        </div>
                    )}
                </div>

                {sack && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Mouth</div>
                        {slider('Opens (°)', 'mouthDepth', 0, 45, 0.5, op, set)}
                        {renderMod('mouth', op.mouth, setNested('mouth'), 'The jaw drops with the band, as if he is singing along.')}
                    </div>
                )}

                {!sack && (
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Ears</div>
                    {toggle('Twitch', 'twitchOn', op, set)}
                    {slider('Every (s)', 'twitchEvery', 0.5, 15, 0.1, op, set)}
                    {slider('Strength', 'twitchStrength', 0, 3, 0.01, op, set)}
                    {slider('Bounce', 'earBounce', 0, 3, 0.01, op, set)}
                    <button type="button" className={styles.vfx_select} style={btnStyle} onClick={() => rec?.twitchNow()}>
                        Twitch now
                    </button>
                    <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                        Springs, as in the game: now and then one ear or both
                        flick and ring out. Bounce is how much they swing
                        with the nod. Their resting angle is a joint in the
                        pose editor.
                    </div>
                </div>
                )}

                {!sack && (
                <div className={styles.vfx_section}>
                    <div className={styles.vfx_sectionTitle}>Body</div>
                    {BODY_FIELDS.map(([key, label, min, max, step]) => slider(label, key, min, max, step, op, set))}
                    {COLOUR_FIELDS.map(([key, label]) => colour(label, key))}
                    {SLOTS.map((slot) => (
                        <div className={styles.vfx_row} key={slot}>
                            <span className={styles.vfx_label} title={SLOT_INFO[slot].hint}>{SLOT_INFO[slot].label}</span>
                            <select
                                className={styles.vfx_select}
                                style={{ gridColumn: '2 / 4' }}
                                value={op[slot]}
                                onChange={(e) => set(slot)(parseInt(e.target.value, 10))}
                            >
                                <option value={-1}>Stock</option>
                                {RARITIES.map((r, i) => (
                                    <option key={r.name} value={i}>{r.name}</option>
                                ))}
                            </select>
                        </div>
                    ))}
                    <button
                        type="button"
                        className={styles.vfx_select}
                        style={btnStyle}
                        onClick={() => updateSelected((i) => {
                            const reset = Object.fromEntries([
                                ...BODY_FIELDS.map(([k]) => k), ...COLOUR_FIELDS.map(([k]) => k), ...SLOTS,
                            ].map((k) => [k, MODEL_DEFAULTS[k]]));
                            return { ...i, op: { ...i.op, ...reset } };
                        })}
                    >
                        <RotateCcw size={12} />
                        Reset body
                    </button>
                    <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                        tetra&apos;s protagonist, built from its spec: the
                        rarer a part, the bigger it gets and the more of the
                        rarity&apos;s colour it wears. Body changes rebuild
                        him; the pose carries over.
                    </div>
                </div>
                )}
                {sack && RIGS.find((r) => r.id === 'sackboy')?.credit && (
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_hint}>{RIGS.find((r) => r.id === 'sackboy').credit}</div>
                    </div>
                )}
            </>
        );
    };

    // ---- Render ----------------------------------------------------------

    return (
        <div className={styles.vfx}>
            <div className={styles.vfx_stage}>
                <div className={styles.vfx_scanWrap}>
                    <div ref={mountCallback} className={styles.vfx_scanCanvas} />
                    {/* The element is the texture source and the clock; it is
                        never shown, since the composite is drawn in WebGL. */}
                    {clip && (
                        <>
                            <video
                                ref={attachVideo}
                                key={clip.id}
                                src={`${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}.mp4`}
                                style={{ display: 'none' }}
                                muted={muted}
                                playsInline
                                loop={loopMode === 'loop'}
                                crossOrigin="anonymous"
                                onPlay={() => setIsPlaying(true)}
                                onPause={(e) => {
                                    // Running out of clip pauses the element
                                    // and fires 'pause' and 'ended' in an
                                    // order not worth relying on, so both are
                                    // read as the same thing.
                                    if (atEnd(e.target)) {
                                        goBackward();
                                        return;
                                    }
                                    if (!exportingRef.current) {
                                        playingRef.current = false;
                                        setIsPlaying(false);
                                    }
                                }}
                                onEnded={() => goBackward()}
                                onTimeUpdate={(e) => {
                                    if (dirRef.current > 0) {
                                        setCurrentTime(e.target.currentTime);
                                    }
                                }}
                                onSeeked={() => { three.current.videoDirty = 3; }}
                                onLoadedData={() => { three.current.videoDirty = 3; }}
                                onLoadedMetadata={(e) => {
                                    setDuration(e.target.duration);
                                    e.target.playbackRate = speed;
                                }}
                            />
                            {/* The take reversed. Ping-pong plays this
                                forwards, which is ordinary playback at full
                                rate - the only alternative is seeking the
                                take backwards a frame at a time, and no
                                browser can do that smoothly. A take published
                                before the pipeline wrote one simply has no
                                ping-pong. */}
                            <video
                                ref={attachRevVideo}
                                key={`${clip.id}-rev`}
                                src={`${process.env.PUBLIC_URL}/mv/${clip.id}/${clip.id}_rev.mp4`}
                                style={{ display: 'none' }}
                                muted={muted}
                                playsInline
                                preload="auto"
                                crossOrigin="anonymous"
                                onLoadedMetadata={(e) => {
                                    setRevReady(true);
                                    e.target.playbackRate = speed;
                                }}
                                onError={() => setRevReady(false)}
                                onEnded={() => goForward()}
                                onTimeUpdate={(e) => {
                                    if (dirRef.current < 0) {
                                        setCurrentTime(takeTime(e.target));
                                    }
                                }}
                                onSeeked={() => { three.current.videoDirty = 3; }}
                                onLoadedData={() => { three.current.videoDirty = 3; }}
                            />
                        </>
                    )}
                    <div className={styles.vfx_scanStatus}>{status}</div>
                </div>
            </div>

            <audio ref={audioRef} loop style={{ display: 'none' }} />
            <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg"
                style={{ display: 'none' }}
                onChange={(e) => { onAudioFile(e.target.files[0]); e.target.value = ''; }}
            />
            <input
                ref={projectInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => { onProjectFile(e.target.files[0]); e.target.value = ''; }}
            />
            <input
                ref={videoInputRef}
                type="file"
                accept="video/*,.mp4,.mov,.webm"
                style={{ display: 'none' }}
                onChange={(e) => { onVideoFile(e.target.files[0]); e.target.value = ''; }}
            />

            {!menuOpen && (
                <button
                    type="button"
                    aria-label="Open controls"
                    onClick={() => setMenuOpen(true)}
                    style={slide(layout.menuToggle)}
                    className={`${styles.vfx_toggle} ${styles.vfx_slide} ${styles.vfx_visible}`}
                >
                    <SlidersHorizontal size={18} />
                </button>
            )}

            {!sceneOpen && (
                <button
                    type="button"
                    aria-label="Open scene controls"
                    onClick={() => setSceneOpen(true)}
                    style={slide(layout.sceneToggle)}
                    className={`${styles.vfx_toggle} ${styles.vfx_slide} ${styles.vfx_visible}`}
                >
                    <Boxes size={18} />
                </button>
            )}

            {sceneOpen && (
                <div
                    style={slide(layout.scenePanel)}
                    className={`${styles.vfx_panel} ${styles.vfx_slide}`}
                >
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Scene</span>
                        <button
                            type="button"
                            aria-label="Close scene controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setSceneOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Audio */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Audio</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                disabled={isExporting}
                                onClick={() => fileInputRef.current.click()}
                            >
                                <Upload size={13} />
                                Upload MP3
                            </button>
                        </div>
                        <select
                            className={styles.vfx_select}
                            value=""
                            disabled={isExporting}
                            onChange={(e) => loadBundledTrack(e.target.value)}
                        >
                            <option value="">Or pick a bundled track...</option>
                            {MUSIC_ASSETS.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                        {trackName && (
                            <div className={styles.vfx_fileName} title={trackName}>
                                <Music size={9} style={{ marginRight: 4 }} />
                                {trackName}
                                {audioReady ? '' : ' (decoding...)'}
                            </div>
                        )}
                        <div className={styles.vfx_hint} style={{ marginTop: 8 }}>
                            Plays with the clip, and is mixed into the export
                            alongside the take&apos;s own sound. An export
                            starts from wherever the track is sitting now, and
                            re-analyses it offline so every frame reacts
                            exactly as previewed.
                        </div>
                    </div>

                    {/* Roto */}
                    <RotoEditor
                        take={clipId}
                        info={track && !track.unsolved ? { fps: track.fps, frames: track.frame_count } : null}
                        frame={track && !track.unsolved
                            ? Math.max(0, Math.min(track.frame_count - 1, Math.floor(currentTime * track.fps + 1e-3)))
                            : 0}
                        seekFrame={seekFrame}
                        active={rotoOn}
                        setActive={setRotoOn}
                        plain={rotoPlain}
                        setPlain={setRotoPlain}
                        mountEl={mountEl}
                        holdout={layers.matteHoldout || {}}
                        setHoldout={(id, on) => setLayers((p) => ({
                            ...p, matteHoldout: { ...(p.matteHoldout || {}), [id]: on },
                        }))}
                        onWritten={() => setMattesTick((v) => v + 1)}
                    />
                    {takeMattes.length > 0 && (
                        <div className={styles.vfx_section} style={{ paddingTop: 0 }}>
                            {toggle('Use mattes', 'mattesOn')}
                        </div>
                    )}

                    {/* Occlusion */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Realism</div>
                        {toggle('Hide behind scan', 'occlude', { occlude },
                            () => setOcclude)}
                        <div className={styles.vfx_hint}>
                            Depth-tests every overlay against the scanned mesh,
                            even when the mesh is not drawn, so points and
                            objects go behind the real object.
                        </div>
                    </div>

                    {/* Sun */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Sun</div>
                        {slider('Azimuth', 'azimuth', -180, 180, 1, sun, setSunKey)}
                        {slider('Elevation', 'elevation', 2, 90, 0.5, sun, setSunKey)}
                        {slider('Intensity', 'intensity', 0, 4, 0.01, sun, setSunKey)}
                        <div className={styles.vfx_row}>
                            <span className={styles.vfx_label}>Colour</span>
                            <input
                                type="color"
                                className={styles.vfx_color}
                                style={{ gridColumn: '2 / 4' }}
                                value={sun.color}
                                onChange={(e) => setSunKey('color')(e.target.value)}
                            />
                        </div>
                        {slider('Sky fill', 'ambient', 0, 2, 0.01, sun, setSunKey)}
                        {toggle('Shadows on the scan', 'shadows', sun, setSunKey)}
                        {sun.shadows && (
                            <>
                                {slider('Darkness', 'shadowOpacity', 0, 1, 0.01, sun, setSunKey)}
                                {slider('Softness', 'shadowSoftness', 0, 8, 0.1, sun, setSunKey)}
                            </>
                        )}
                        <div className={styles.vfx_hint}>
                            A directional light, infinitely far off, in the
                            scan&apos;s frame: azimuth from +X towards +Z,
                            elevation above the ground. Lights the placed
                            models, and their shadows land on the scanned
                            surfaces over the footage. Line the shadows up with
                            the real ones in the take.
                        </div>
                    </div>

                    {/* Add */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Add to scene</div>
                        <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Point clouds</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <select
                                className={styles.vfx_select}
                                value={addAssetId}
                                onChange={(e) => setAddAssetId(e.target.value)}
                            >
                                {ASSETS.filter((a) => a.type !== 'glb').map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add asset"
                                className={styles.vfx_iconBtn}
                                onClick={addAsset}
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                        <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Curves</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <select
                                className={styles.vfx_select}
                                value={addCurveId}
                                onChange={(e) => setAddCurveId(e.target.value)}
                            >
                                {CURVES.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add curve"
                                className={styles.vfx_iconBtn}
                                onClick={addCurve}
                            >
                                <Spline size={14} />
                            </button>
                        </div>
                        <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Models</div>
                        <div className={styles.vfx_playRow}>
                            <select
                                className={styles.vfx_select}
                                value={addModelId}
                                onChange={(e) => setAddModelId(e.target.value)}
                            >
                                {MODELS.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add model"
                                className={styles.vfx_iconBtn}
                                disabled={!track}
                                onClick={addModel}
                            >
                                <PersonStanding size={14} />
                            </button>
                        </div>
                        {MODEL_SPAWNS[clipId] && (
                            <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                                On this take a model arrives sitting on the bench.
                            </div>
                        )}
                        <div className={styles.vfx_hint} style={{ margin: '9px 0 5px' }}>Props</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <select
                                className={styles.vfx_select}
                                value={addPropId}
                                onChange={(e) => setAddPropId(e.target.value)}
                            >
                                <option value="">Pick a prop...</option>
                                {library.assets.filter((a) => a.category !== 'screen').map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add prop"
                                className={styles.vfx_iconBtn}
                                disabled={!track || !addPropId}
                                onClick={() => addProp(addPropId)}
                            >
                                <Shapes size={14} />
                            </button>
                        </div>
                        <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Screens</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <select
                                className={styles.vfx_select}
                                value={addScreenId}
                                onChange={(e) => setAddScreenId(e.target.value)}
                            >
                                <option value="">Pick a screen...</option>
                                {library.assets.filter((a) => a.category === 'screen').map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Add screen"
                                className={styles.vfx_iconBtn}
                                disabled={!track || !addScreenId}
                                onClick={() => addProp(addScreenId)}
                            >
                                <Monitor size={14} />
                            </button>
                        </div>
                        <div className={styles.vfx_hint} style={{ margin: '0 0 5px' }}>Windows</div>
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={btnRow}
                            disabled={!track}
                            onClick={addWindow}
                        >
                            <Frame size={13} />
                            Add a window
                        </button>
                        <div className={styles.vfx_hint} style={{ marginTop: 6 }}>
                            Props pulse with the music; screens carry a video
                            (which assets are screens, and where the screen
                            is on each, is set in the asset library under any
                            placed one). A window cuts the footage away to
                            show what is behind it, and can hue-shift or
                            pixel-sort its patch.
                        </div>
                    </div>

                    {/* Items */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>
                            Objects ({sceneItems.length})
                        </div>
                        {!sceneItems.length && (
                            <div className={styles.vfx_hint}>
                                Nothing placed yet. Objects sit in the scan&apos;s
                                own space, so they stay locked to the scene as
                                the camera moves.
                            </div>
                        )}
                        {sceneItems.map((item) => {
                            let name;
                            if (item.kind === 'curve') name = CURVES.find((c) => c.id === item.funcId)?.name;
                            else if (item.kind === 'model') name = MODELS.find((m) => m.id === item.modelId)?.name;
                            else if (item.kind === 'prop') name = library.assets.find((a) => a.id === item.assetId)?.name;
                            else if (item.kind === 'window') name = 'Window';
                            else name = ASSETS.find((a) => a.id === item.assetId)?.name;
                            const screen = item.kind === 'prop' && library.assets.find((a) => a.id === item.assetId)?.category === 'screen';
                            const behind = item.op?.depthLayer === 'behind';
                            return (
                                <div className={styles.vfx_cutRow} key={item.id}>
                                    <button
                                        type="button"
                                        className={styles.vfx_cutJump}
                                        style={{
                                            color: selectedId === item.id
                                                ? 'var(--accent)' : 'var(--fg)',
                                        }}
                                        onClick={() => setSelectedId(
                                            selectedId === item.id ? null : item.id,
                                        )}
                                    >
                                        {screen ? '▭ ' : ({ curve: '~ ', model: '☺ ', prop: '◆ ', window: '⬚ ' }[item.kind] || '• ')}
                                        {name || item.assetId || item.funcId || item.modelId}
                                        {behind ? ' (behind)' : ''}
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Remove object"
                                        className={styles.vfx_iconBtn}
                                        style={{ width: 20, height: 20 }}
                                        onClick={() => removeItem(item.id)}
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {/* Selected object parameters, straight from the shared
                        menu definition so both tools expose the same knobs. */}
                    {selected && selected.kind === 'model' && renderModelPanel(selected)}
                    {selected && selected.kind === 'prop' && renderPropPanel(selected)}
                    {selected && selected.kind === 'window' && renderWindowPanel(selected)}

                    {selected && (selected.kind === 'asset' || selected.kind === 'curve') && (
                        <div className={styles.vfx_section}>
                            <div className={styles.vfx_sectionTitle}>Layer</div>
                            {segRow(LAYER_OPTIONS, selected.op.depthLayer || 'front', (v) => setItemParam('depthLayer')(v), 2)}
                            {toggle('Move in viewport', 'editMove', { editMove: editMode === 'move' },
                                () => (v) => setEditMode(v ? 'move' : null))}
                        </div>
                    )}

                    {selected && (selected.kind === 'asset' || selected.kind === 'curve') && PARAM_GROUPS
                        .filter((g) => g.scope === 'object'
                            && (g.kind === 'both' || g.kind === selected.kind
                                || (g.kind === 'asset' && selected.kind === 'asset'))
                            && (!g.sphereOnly || selectedAssetType === 'sphere'))
                        .map((group) => (
                            <div className={styles.vfx_section} key={`${group.title}-${group.kind}`}>
                                <div className={styles.vfx_sectionTitle}>{group.title}</div>
                                {group.params.map((prm) => {
                                    if (prm.type === 'gizmoButtons') return null;
                                    if (prm.sphereOnly && selectedAssetType !== 'sphere') return null;
                                    if (prm.cloudOnly && selected.kind !== 'asset') return null;
                                    if (prm.type === 'color') {
                                        return (
                                            <div className={styles.vfx_row} key={prm.key}>
                                                <span className={styles.vfx_label}>{prm.label}</span>
                                                <input
                                                    type="color"
                                                    className={styles.vfx_color}
                                                    style={{ gridColumn: '2 / 4' }}
                                                    value={selected.op[prm.key]
                                                        ?? OBJECT_DEFAULTS[prm.key] ?? '#ffffff'}
                                                    onChange={(e) => setItemParam(prm.key)(e.target.value)}
                                                />
                                            </div>
                                        );
                                    }
                                    return (
                                        <div className={styles.vfx_row} key={prm.key}>
                                            <span className={styles.vfx_label} title={prm.label}>
                                                {prm.label}
                                            </span>
                                            <input
                                                type="range"
                                                className={styles.vfx_slider}
                                                min={prm.min}
                                                max={prm.max}
                                                step={prm.step}
                                                value={selected.op[prm.key] ?? OBJECT_DEFAULTS[prm.key] ?? 0}
                                                onChange={(e) => setItemParam(prm.key)(
                                                    parseFloat(e.target.value),
                                                )}
                                            />
                                            <VfxNumberField
                                                value={selected.op[prm.key] ?? OBJECT_DEFAULTS[prm.key] ?? 0}
                                                min={prm.min}
                                                max={prm.max}
                                                step={prm.step}
                                                onCommit={setItemParam(prm.key)}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                </div>
            )}

            {menuOpen && (
                <div
                    style={slide(layout.menuPanel)}
                    className={`${styles.vfx_panel} ${styles.vfx_slide}`}
                >
                    <div className={styles.vfx_head}>
                        <span className={styles.vfx_title}>Scan Compositor</span>
                        <button
                            type="button"
                            aria-label="Close controls"
                            className={styles.vfx_iconBtn}
                            onClick={() => setMenuOpen(false)}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Take */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Take</div>
                        <select
                            className={styles.vfx_select}
                            value={clipId || ''}
                            disabled={isExporting || !clips.length}
                            onChange={(e) => setClipId(e.target.value)}
                        >
                            {clips.map((c) => (
                                <option key={c.id} value={c.id}>{c.label}</option>
                            ))}
                        </select>
                        <div className={styles.vfx_fileName} title={status}>{status}</div>
                    </div>

                    {/* Project */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Project</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            <button
                                type="button"
                                className={styles.vfx_segBtn}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                disabled={isExporting || !clipId}
                                onClick={saveProject}
                            >
                                <FileDown size={12} />
                                Save .json
                            </button>
                            <button
                                type="button"
                                className={styles.vfx_segBtn}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                disabled={isExporting}
                                onClick={() => projectInputRef.current.click()}
                            >
                                <FolderOpen size={12} />
                                Open
                            </button>
                        </div>
                        <div className={styles.vfx_hint}>
                            Saves the take, every layer and view, the nudge,
                            playback, the free camera, all placed objects
                            (models with their poses), the track and the export
                            settings. A track uploaded from disk has to be
                            uploaded again after opening.
                        </div>
                    </div>

                    {/* Playback */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Playback</div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 10 }}>
                            <button
                                type="button"
                                className={styles.vfx_iconBtn}
                                aria-label={isPlaying ? 'Pause' : 'Play'}
                                disabled={isExporting || !track}
                                onClick={togglePlay}
                            >
                                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                            </button>
                            <input
                                type="range"
                                className={styles.vfx_slider}
                                min={0}
                                max={Math.max(0.01, duration)}
                                step={0.001}
                                value={currentTime}
                                disabled={isExporting || !track}
                                onChange={(e) => {
                                    // Always in the take's own time: dragging
                                    // during the return hands the clip back
                                    // to the forward copy first.
                                    const at = parseFloat(e.target.value);
                                    if (dirRef.current < 0) {
                                        revVideoRef.current?.pause();
                                        showVideo(1);
                                        if (playingRef.current) {
                                            videoRef.current?.play().catch(() => {});
                                        }
                                    }
                                    seekTake(at);
                                }}
                            />
                            <span className={styles.vfx_value}>{fmt(currentTime)}</span>
                        </div>
                        {slider('Speed', 'speed', 0.1, 2, 0.05,
                            { speed }, () => setSpeed)}
                        <div className={styles.vfx_segRow}>
                            {LOOP_MODES.map((m) => (
                                <button
                                    key={m.id}
                                    type="button"
                                    disabled={m.id === 'bounce' && !revReady}
                                    title={m.id === 'bounce' && !revReady
                                        ? 'This take has no reversed copy; re-run the export stage'
                                        : m.name}
                                    className={`${styles.vfx_segBtn} ${loopMode === m.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLoopMode(m.id)}
                                >
                                    {m.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_hint}>
                            Ping-pong plays the take&apos;s reversed copy back
                            to its start instead of cutting back, which turns a
                            few seconds of footage into a seamless loop.
                            Exports follow whichever mode is set here.
                        </div>
                        {!!coverage.unsolved && (
                            <>
                                {toggle('Skip unsolved', 'skipUnsolved',
                                    { skipUnsolved }, () => setSkipUnsolved)}
                                <div className={styles.vfx_hint}>
                                    {coverage.unsolved} frame
                                    {coverage.unsolved === 1 ? '' : 's'} have no
                                    camera. Skipped in playback and left out of
                                    the export.
                                </div>
                            </>
                        )}
                        {toggle('Audio', 'audio', { audio: !muted },
                            () => (v) => setMuted(!v))}
                    </div>

                    {/* Camera */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Camera</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {['tracked', 'free'].map((m) => (
                                <button
                                    key={m}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${rig.cameraMode === m ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setRigKey('cameraMode')(m)}
                                >
                                    {m === 'tracked' ? 'Solved' : 'Free orbit'}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_hint}>
                            Free orbit drops the footage and lets you inspect the
                            fit from any angle.
                        </div>
                    </div>

                    {/* Video layer */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Video</div>
                        {toggle('Show footage', 'videoOn')}
                        {slider('Opacity', 'videoOpacity', 0, 1, 0.01)}
                        {colorRow('Backdrop', 'bgColor')}
                        {toggle('Scan layers behind video', 'scanBehind')}
                        <div className={styles.vfx_hint}>
                            Puts the scan&apos;s points, mesh and wireframe
                            behind the footage, so they only show through
                            windows (or where the footage is faded).
                        </div>
                    </div>

                    {/* Point cloud */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Point cloud</div>
                        {toggle('Show points', 'cloudOn')}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {[['scan', 'Scan colour'], ['solid', 'Solid']].map(([id, name]) => (
                                <button
                                    key={id}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${layers.cloudColorMode === id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLayer('cloudColorMode')(id)}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                        {layers.cloudColorMode === 'solid' && colorRow('Colour', 'cloudColor')}
                        {slider('Size', 'cloudSize', 0.1, 8, 0.1)}
                        {slider('Density', 'cloudDensity', 0.01, 1, 0.01)}
                        {slider('Opacity', 'cloudOpacity', 0, 1, 0.01)}
                        {toggle('Perspective size', 'cloudAttenuate')}
                    </div>

                    {/* The scan's own points, driven by whatever is loaded in
                        the Scene panel. Lives in the layer stack, so a cut can
                        switch the object itself into motion. */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Point reactivity</div>
                        {slider('Amount', 'cloudReact', 0, 3, 0.01)}
                        {layers.cloudReact > 0 && (
                            <>
                                {slider('Scatter', 'cloudScatter', 0, 1, 0.001)}
                                {slider('Freq low', 'cloudFreqLow', 0, 1, 0.01)}
                                {slider('Freq high', 'cloudFreqHigh', 0, 1, 0.01)}
                                {slider('Pulse X', 'cloudPulseX', -4, 4, 0.01)}
                                {slider('Pulse Y', 'cloudPulseY', -4, 4, 0.01)}
                                {slider('Pulse Z', 'cloudPulseZ', -4, 4, 0.01)}
                            </>
                        )}
                        <div className={styles.vfx_hint}>
                            {layers.cloudReact > 0
                                ? 'Points push out from the pulse point by the band their distance maps to.'
                                : 'Load a track in the Scene panel, then raise this to make the scanned object itself move.'}
                        </div>
                    </div>

                    {/* Opacity, driven by the music rather than by hand */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Audio opacity</div>
                        {slider('Depth', 'opacityReact', 0, 1, 0.01)}
                        {layers.opacityReact > 0 && (
                            <>
                                <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                                    {[['band', 'Follow band'], ['gate', 'Threshold']].map(([id, name]) => (
                                        <button
                                            key={id}
                                            type="button"
                                            className={`${styles.vfx_segBtn} ${layers.opacityMode === id ? styles.vfx_segBtnOn : ''}`}
                                            onClick={() => setLayer('opacityMode')(id)}
                                        >
                                            {name}
                                        </button>
                                    ))}
                                </div>
                                {slider('Freq low', 'opacityFreqLow', 0, 1, 0.01)}
                                {slider('Freq high', 'opacityFreqHigh', 0, 1, 0.01)}
                                {slider(layers.opacityMode === 'gate' ? 'Threshold' : 'Floor',
                                    'opacityThreshold', 0, 0.99, 0.01)}
                                {slider('Smoothing', 'opacitySmooth', 0, 0.95, 0.01)}
                                {toggle('Invert', 'opacityInvert')}
                                {toggle('Points', 'opacityPoints')}
                                {toggle('Wireframe', 'opacityWire')}
                                {toggle('Mesh', 'opacityMesh')}
                                {toggle('Placed scene', 'opacityScene')}
                            </>
                        )}
                        {slider('Scene opacity', 'sceneOpacity', 0, 1, 0.01)}
                        <div className={styles.vfx_hint}>
                            {layers.opacityReact > 0
                                ? (layers.opacityMode === 'gate'
                                    ? 'On while the band sits above the threshold, off below it. Smoothing softens the edge.'
                                    : 'Follows the band\u2019s level above the floor, so the layer breathes with the track.')
                                : 'Fades the layers you pick with a slice of the spectrum. Scene opacity below sets the base level for everything placed in the Scene panel.'}
                        </div>
                    </div>

                    {/* Mesh */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Mesh</div>
                        {toggle('Show mesh', 'meshOn')}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {SHADING.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${layers.meshShading === s.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLayer('meshShading')(s.id)}
                                >
                                    {s.name}
                                </button>
                            ))}
                        </div>
                        {layers.meshShading !== 'textured' && layers.meshShading !== 'normal'
                            && colorRow('Colour', 'meshColor')}
                        {slider('Opacity', 'meshOpacity', 0, 1, 0.01)}
                    </div>

                    {/* Wireframe */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Wireframe</div>
                        {toggle('Show wireframe', 'wireOn')}
                        <div className={styles.vfx_segRow}>
                            {WIRE_LEVELS.map((w) => (
                                <button
                                    key={w.id}
                                    type="button"
                                    className={`${styles.vfx_segBtn} ${layers.wireLevel === w.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setLayer('wireLevel')(w.id)}
                                >
                                    {w.name}
                                </button>
                            ))}
                        </div>
                        {colorRow('Colour', 'wireColor')}
                        {slider('Thickness', 'wireThickness', 0.0002, 0.012, 0.0002)}
                        {slider('Opacity', 'wireOpacity', 0, 1, 0.01)}
                        {slider('Reactivity', 'wireReact', 0, 3, 0.01)}
                        <div className={styles.vfx_hint}>
                            Vertices move with the music like the points do,
                            but edges keep hold of both ends so the mesh stays
                            welded. Shares the point cloud&apos;s pulse point
                            and frequency band.
                        </div>
                    </div>

                    {/* Post FX */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Glow &amp; haze</div>
                        {slider('Glow', 'bloomStrength', 0, 3, 0.01)}
                        {slider('Glow spread', 'bloomRadius', 0, 2, 0.01)}
                        {slider('Glow floor', 'bloomThreshold', 0, 1, 0.01)}
                        {slider('Haze', 'haze', 0, 2, 0.01)}
                        <div className={styles.vfx_hint}>
                            The audio visualizer&apos;s post FX, over the whole
                            composite: anything brighter than the floor glows,
                            footage included. Views and exports keep both.
                        </div>
                    </div>

                    {/* Saved looks */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Views</div>
                        <div className={styles.vfx_presetGrid}>
                            {presets.map((p, i) => (
                                <button
                                    // eslint-disable-next-line react/no-array-index-key
                                    key={i}
                                    type="button"
                                    title={p ? `Recall view ${i + 1}` : `Save view ${i + 1}`}
                                    className={`${styles.vfx_segBtn} ${activePreset === i ? styles.vfx_segBtnOn : ''}`}
                                    style={{ opacity: p ? 1 : 0.4 }}
                                    onClick={() => (p ? recallPreset(i) : savePreset(i))}
                                >
                                    {i + 1}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_playRow} style={{ marginBottom: 9 }}>
                            <button
                                type="button"
                                className={styles.vfx_select}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                onClick={() => {
                                    // Overwrite the live view if there is one,
                                    // otherwise take the first empty slot.
                                    const empty = presets.findIndex((p) => !p);
                                    savePreset(activePreset ?? (empty === -1 ? 0 : empty));
                                }}
                            >
                                <Save size={12} />
                                Save view
                            </button>
                        </div>
                        <div className={styles.vfx_hint}>
                            A view is the whole layer stack. Recalling one and
                            then editing updates it, so the slots are looks you
                            keep refining. 1–9 recall, shift+1–9 saves. Space
                            plays, V/P/M/W toggle layers, F frees the camera.
                        </div>
                    </div>

                    {/* Alignment */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Alignment nudge</div>
                        <div className={styles.vfx_hint} style={{ marginBottom: 10 }}>
                            The solve is automatic; trim it here if the overlay
                            sits slightly off the object.
                        </div>
                        {slider('Offset X', 'offsetX', -0.5, 0.5, 0.001, rig, setRigKey)}
                        {slider('Offset Y', 'offsetY', -0.5, 0.5, 0.001, rig, setRigKey)}
                        {slider('Offset Z', 'offsetZ', -0.5, 0.5, 0.001, rig, setRigKey)}
                        {slider('Rotate X', 'rotX', -15, 15, 0.1, rig, setRigKey)}
                        {slider('Rotate Y', 'rotY', -15, 15, 0.1, rig, setRigKey)}
                        {slider('Rotate Z', 'rotZ', -15, 15, 0.1, rig, setRigKey)}
                        {slider('Scale', 'scale', 0.8, 1.25, 0.001, rig, setRigKey)}
                        {slider('Swell', 'overscale', 1, 1.08, 0.0005, rig, setRigKey)}
                        <div className={styles.vfx_hint} style={{ marginTop: 10, marginBottom: 10 }}>
                            Swell lifts the points and edges off the surface
                            evenly; these slide them bodily, which is how you
                            get a drifting double of the object rather than a
                            slightly inflated one. Neither moves the mesh.
                        </div>
                        {slider('Overlay X', 'overlayX', -0.3, 0.3, 0.001, rig, setRigKey)}
                        {slider('Overlay Y', 'overlayY', -0.3, 0.3, 0.001, rig, setRigKey)}
                        {slider('Overlay Z', 'overlayZ', -0.3, 0.3, 0.001, rig, setRigKey)}
                        <button
                            type="button"
                            className={styles.vfx_select}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            onClick={() => setRig((p) => ({ ...DEFAULT_RIG, cameraMode: p.cameraMode }))}
                        >
                            <RotateCcw size={12} />
                            Reset nudge
                        </button>
                    </div>

                    {/* Export */}
                    <div className={styles.vfx_section}>
                        <div className={styles.vfx_sectionTitle}>Export</div>
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                            {EXPORT_SCALES.map((sc) => (
                                <button
                                    key={sc.id}
                                    type="button"
                                    disabled={isExporting}
                                    className={`${styles.vfx_segBtn} ${exportScale === sc.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportScale(sc.id)}
                                >
                                    {sc.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_segRow}>
                            {EXPORT_QUALITY.map((q) => (
                                <button
                                    key={q.id}
                                    type="button"
                                    disabled={isExporting}
                                    className={`${styles.vfx_segBtn} ${exportQuality === q.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportQuality(q.id)}
                                >
                                    {q.name}
                                </button>
                            ))}
                        </div>
                        <div className={styles.vfx_segRow}>
                            {EXPORT_LENGTHS.map((len) => (
                                <button
                                    key={len.id}
                                    type="button"
                                    disabled={isExporting
                                        || (len.id === 'audio' && !audioReady)}
                                    title={len.id === 'audio' && !audioReady
                                        ? 'Load a track in the Scene panel first'
                                        : len.name}
                                    className={`${styles.vfx_segBtn} ${exportLength === len.id ? styles.vfx_segBtnOn : ''}`}
                                    onClick={() => setExportLength(len.id)}
                                >
                                    {len.name}
                                </button>
                            ))}
                        </div>
                        {exportLength === 'loops' && slider('Cycles', 'exportLoops',
                            1, 40, 1, { exportLoops }, () => setExportLoops)}
                        {slider('Music from (s)', 'exportMusicStart', 0,
                            Math.max(1, audioBufferRef.current?.duration || 0), 0.001,
                            { exportMusicStart }, () => (v) => setExportMusicStart(Math.max(0, v)))}
                        {slider('Take from (s)', 'exportVideoStart', 0,
                            Math.max(0.01, duration), 0.001,
                            { exportVideoStart }, () => (v) => setExportVideoStart(Math.max(0, v)))}
                        <div className={styles.vfx_segRow} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                            <button
                                type="button"
                                className={styles.vfx_segBtn}
                                disabled={isExporting}
                                title="Start both from the very beginning"
                                onClick={() => { setExportMusicStart(0); setExportVideoStart(0); }}
                            >
                                From 0
                            </button>
                            <button
                                type="button"
                                className={styles.vfx_segBtn}
                                disabled={isExporting}
                                title="Take both starts from where the preview is now"
                                onClick={() => {
                                    const v = dirRef.current < 0 ? revVideoRef.current : videoRef.current;
                                    setExportVideoStart(Math.round((v ? takeTime(v) : 0) * 1000) / 1000);
                                    setExportMusicStart(Math.round((audioRef.current?.currentTime || 0) * 1000) / 1000);
                                }}
                            >
                                Playhead
                            </button>
                            <button
                                type="button"
                                className={styles.vfx_segBtn}
                                disabled={isExporting}
                                title="Put the preview at the export's start, to check it"
                                onClick={cueExportStart}
                            >
                                Cue
                            </button>
                        </div>
                        <button
                            type="button"
                            className={`${styles.vfx_select} ${isExporting ? styles.vfx_recActive : ''}`}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                            disabled={!track}
                            onClick={() => {
                                if (isExporting) exportCanceledRef.current = true;
                                else startExport();
                            }}
                        >
                            {isExporting ? <Camera size={13} /> : <Download size={13} />}
                            {isExporting
                                ? `Cancel (${Math.round(exportProgress * 100)}%)`
                                : 'Export MP4'}
                        </button>
                        {isExporting && (
                            <>
                                <div className={styles.vfx_progress} style={{ marginTop: 10 }}>
                                    <div
                                        className={styles.vfx_progressFill}
                                        style={{ width: `${exportProgress * 100}%` }}
                                    />
                                </div>
                                <div className={styles.vfx_fileName}>{exportStage}</div>
                            </>
                        )}
                        <div className={styles.vfx_hint} style={{ marginTop: 10 }}>
                            The export starts the music and the take from the
                            points above (0 for both by default), whatever the
                            preview is doing. Cue puts the preview there.
                            Every frame is rendered at
                            {' '}
                            {Math.round(track ? track.intrinsics.width * exportScale : 0)}
                            x
                            {Math.round(track ? track.intrinsics.height * exportScale : 0)}
                            {', '}
                            supersampled, with the clip&apos;s own sound and any
                            loaded track mixed in. Ping-pong and the cycle count
                            are written out in full, so a few seconds of footage
                            can carry a whole song.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ScanCompositor;
