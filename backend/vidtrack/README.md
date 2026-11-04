# vidtrack — camera tracking for scanned objects

Takes a video of an object and the GLB you scanned it into, and works out where
the camera was for every frame **in the GLB's own coordinate system**. The web
tool at `/vfx/scan-compositor` then renders the scan through that camera, so the
mesh, its wireframe or its point cloud sit locked onto the real object in the
footage, and exports the result with its sound.

## Why it does not use structure from motion

The obvious approach is SfM (COLMAP): solve the camera from the footage, then
register the result onto the mesh. That was tried first and it does not work on
this material, for a reason worth recording.

SfM recovers geometry from parallax, so it needs the camera to travel. These
clips barely move — tracking features from the first frame to the last gives a
median displacement of about **70px out of 1920**, roughly 4% of frame width,
and most of that is rotation rather than translation. COLMAP's own two-view
geometry agrees: nearly every image pair comes back classified `PLANAR` or
`WATERMARK` rather than `CALIBRATED`, and the mapper cannot even choose an
initial pair. Filming an object you have just scanned tends to produce exactly
this — you stand in front of it and film, you do not orbit it.

So the structure is never recovered. It does not need to be: the scan already
*is* the structure, and the camera can be solved against it directly.

## What it does instead

`localize.py` solves each frame against the model:

1. **Find the shot.** The mesh is rendered from viewpoints spread over a sphere
   and each render is matched against one keyframe. A render looks like a
   photograph — contiguous and correctly perspectived — which is exactly what
   the texture atlas does not, its charts being small, rotated and resampled.
   Matching against the raw atlas was tried and yields almost nothing; matching
   against renders works. The winning viewpoint is then re-rendered from the
   pose it implies and rematched, which tightens it further.
2. **Densify.** Matching alone yields as few as 60 correspondences, and
   optical flow sheds them steadily — which on a longer take starves the solve
   partway through. But at the converged pose the render is aligned with the
   frame, so *any* trackable corner can be given a 3D position by reading the
   render's world buffer underneath it. That turns tens of points into ~1200,
   spread over the whole object. On these clips it lifted the median inlier
   count from ~65 to ~1180.
3. **Carry it through the take.** Those 2D points are tracked with optical flow,
   which preserves the correspondence; over this little motion LK is near-exact.
   Several anchors are located *independently* across the clip (one per ~70
   frames) and each tracks outwards, with every frame taking the pose from
   whichever anchor has the most inliers on it. Because each anchor is solved
   against the model from scratch, they cannot drift relative to one another.
4. **Solve each frame by PnP** on the tracked correspondences. One view is
   enough, so zero camera translation is fine, and the pose arrives *already in
   the mesh's frame* — there is no similarity transform left to solve, which is
   where the two-stage SfM approach is most likely to fail.
5. **Refine by optical flow** (`refine.py`). Everything above steers by SIFT,
   and SIFT only fires on the scan's most distinctive patches — a sign, some
   lettering. On an object that is mostly plain material, that anchors the
   solve by one small region and leaves the rest free to swing: on Galbraith
   the two signs at the foot of a concrete column sat within a few pixels
   while the street number higher up was 40px adrift. Densifying does not
   help, since it reads its 3D from a render at the solve's own pose. Flow
   needs no features: DIS flow from the scan rendered at the solved pose to
   the real frame gives an offset at every textured pixel, plain concrete
   included, and each vector is a 2D-3D correspondence through the render's
   world buffer. Refining the pose on those, re-rendering and repeating pulls
   the whole object into line. It also refits the focal on them, pooled over
   a spread of frames, which is the measurement a wrong focal actually fails;
   Galbraith's moved from 1350 to about 1400. A frame keeps its solved pose
   whenever refining does not lower its flow residual, so a blurred pan is
   never made worse.

Two details that matter:

- **Matching happens at the render's resolution.** SIFT tolerates a scale gap
  but does not relish one, and 1920px frames against 720px renders cost most of
  the matches. Downscaling the frame roughly doubled the correspondence count.
- **Focal length is swept against the model.** The clips carry no usable EXIF,
  and with this little motion the focal cannot be recovered from the trajectory
  either. Testing candidates against known 3D gives a clear optimum — both
  clips independently landed on 1536px, which is a good sign given they came
  from the same phone. The grid reaches down to the 0.5x ultrawide; it used
  to stop at 0.55x the frame width, and an ultrawide take simply picked that
  edge, which PnP then hid by moving the camera - the centre of frame lined
  up and nothing else did. The winner is then fitted by least squares on
  SIFT matches from several frames. Not on densified points: their 3D is read
  from a render at the current focal, so they agree with whatever focal they
  are given.

## Checking the result

Inlier counts only say the solver found a self-consistent answer, not a correct
one. `verify.py` draws the scan back through each solved camera:

```
../venv/bin/python verify.py work/tagbox --glb assets/tagbox.glb --mode edge
```

`--mode edge` draws the silhouette in red and creases in yellow over the
footage, which exposes misalignment far more plainly than a blend. `--video`
renders the whole take rather than a contact sheet. Both current takes line up
to within a pixel or two across every frame.

Edge mode has a blind spot, though: on a plainly textured object it draws a
cloud of crease lines that looks aligned whether it is or not. On Galbraith
it passed a solve whose street number was doubled 40px in the blend. Look at
both, and in the blend look at lettering and signs *away* from wherever the
solve is strongest. Any check built on feature matches shares the solve's own
blindness — it finds the patches the solve already lined up — so the honest
numeric check is the flow residual `refine.py` prints by quarter of the
frame, which covers the plain surfaces too.

The other check is the tool itself: open the take, leave the footage on with the
wireframe over it, and scrub. If the overlay sits slightly off, the panel's
**Alignment nudge** trims it by hand without re-solving.

## What the web tool does with a take

Worth knowing, because it shapes what the pipeline has to publish:

- **It loops.** *Ping-pong* runs the take backwards to its start rather than
  cutting back to it, which turns three seconds of footage into a seamless
  loop - and the clip's own sound is reversed along with the picture. That
  means the published mp4 is seeked to, frame by frame, in both directions,
  which is why it is encoded with a keyframe every fifteen frames rather than
  libx264's default 250. A long GOP makes every backwards step decode from
  far away, and the preview crawls.
- **It exports sound.** The take's own audio and whatever music is loaded in
  the Scene panel are mixed over the same frame list the picture uses, so they
  cannot drift, and muxed into the mp4 as AAC. The pipeline carries the
  source's audio into the published copy for exactly this reason.
- **It exports the loop.** *Full track* writes as many cycles as the loaded
  music needs and stops on the last beat of it; *Cycles* writes a set number.
  Either can run to thousands of frames, so an export larger than about half a
  gigabyte is streamed straight to a file you choose rather than assembled in
  memory.

## Running it

Everything uses `backend/venv` (Python 3.13):

```
../venv/bin/python pipeline.py --video ~/Downloads/thing.MOV --glb ~/Downloads/thing.glb
```

That runs every stage and publishes the take to `public/mv/<name>/`, where the
web tool picks it up via `manifest.json`. Stages are resumable:

```
../venv/bin/python pipeline.py --name thing --only solve,export,verify
```

| Stage | What it does |
| --- | --- |
| `frames` | ffmpeg splits the video into JPEGs |
| `cloud` | samples a coloured point cloud, and low-poly copies for the wireframe |
| `solve` | locates the camera against the scan, frame by frame |
| `refine` | pulls each pose into line by optical flow, and refits the focal |
| `export` | writes `track.json` and a web-playable H.264 copy |
| `verify` | draws the solve back over the footage |
| `publish` | copies assets across and registers the take |

`decimate.py` drops disconnected shells below ~0.4% of the face count before
simplifying. A scan carries hundreds of them - leaves, gravel, scraps of fence -
which read as noise in wireframe and, worse, hold the decimator up, since every
shell needs a minimum number of faces however low the target. On these takes it
removes 480-1240 specks and tens of thousands of faces, and only then will a
mesh actually reduce to its target.

Knobs worth knowing when a take misbehaves:

- `--views` widens the viewpoint search (default 260). Raise it if the keyframe
  cannot be located at all.
- `--keyframe N` picks which frame to locate first; the default is the middle.
  Choose one where the object is large, sharp and unoccluded.
- `--anchors N` sets how many independently located keyframes to use. The
  default scales with clip length; raise it if coverage drops out in the middle
  of a long take, or pass 1 to force the old single-anchor behaviour.
- `--interior` is for a take filmed from inside the scan - a room, a
  stairwell. The default search places cameras on a sphere around the scan,
  which from inside only ever sees the backs of the walls. Interior mode
  probes a grid with tiny cube-map renders to find the open space, then
  searches from points spread through it, looking every way. Pass `--focal`
  with it if you know the lens: an interior sweep costs a few minutes a step.
- Each anchor first refines from the pose the previous anchor's tracking
  carried to its frame, and only searches if that fails. This is what gets
  an interior take through stretches of bare wall, and it is still a fresh
  solve against the scan, so nothing drifts.
- `--focal N` skips the sweep when you already know the answer — 1536 for the
  iPhone 14 Pro main camera at 1920x1440, about 870 for its 0.5x ultrawide
  at 1920x1080. A focal given this way is taken as known, so the refine
  stage keeps it rather than refitting. Note the sweep's inlier scores can
  be nearly flat on a small or nearly planar scan - Galbraith's ran 79-96
  from 576px to 3264px - and then its choice means little; the refine
  stage's dense fit is the one to trust there.
- `--smooth` (on `localize.py`) sets the trajectory smoothing window. Per-frame
  PnP is drift-free but jittery; 7 frames suits a handheld phone.
- `--min-anchor` (on `localize.py`) is the inlier count an anchor must reach
  before it is trusted, 12 by default. An anchor located on a handful of
  matches will still densify to a thousand points - densification believes
  whatever pose it is handed - and would then outvote good anchors on sheer
  point count. Anchors below the floor are skipped, as is any anchor whose
  correspondences will not re-solve; a take is no longer thrown away because
  one of its twenty-five anchors landed badly.

A healthy take solves nearly every frame with a median inlier count in the
hundreds; the three current ones sit at 1177, 1185 and 140. A median below
about 25, or a solved-frame count well short of the total, means the pose is
unreliable even though it technically solved — check `verify.py` before
trusting it, and try more `--anchors` or a different `--keyframe`.

## The SfM path

`sfm.py` and `align.py` implement the COLMAP route and its registration step.
Nothing in the pipeline calls them, and they are no use on footage like this,
but they are the better tool if you ever shoot a **proper orbit** — walking all
the way around the object — since a real reconstruction beats single-view PnP
on accuracy. `align.py` carries the result into the mesh's frame by trimmed,
colour-ranked ICP seeded from where the camera axes converge. Delete both if you
would rather not maintain them.

## Layout

```
localize.py      model-based solver -> sfm.json, alignment.json
refine.py        optical-flow refinement of sfm.json (solve kept as sfm_solve.json)
render.py        offscreen textured renderer (world position per pixel)
verify.py        draws a solve back over its footage
decimate.py      low-poly copies (coarse/medium/fine) for the wireframe
export_track.py  convention/frame conversion -> track.json, <name>.mp4
pipeline.py      orchestrator
sfm.py/align.py  the unused SfM route; see above
work/<name>/     frames and intermediates (gitignored)
assets/          working copies of the GLBs, clouds and wireframe meshes
```

## Shooting for better results

If you can, **walk around the object** while filming. That gives real parallax,
which makes the solve far more accurate and opens up the SfM path. Failing that,
the single most useful thing is to keep the object large and sharp in frame —
the solve's accuracy is set by how well the keyframe matches the scan.
