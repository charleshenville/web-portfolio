# Compositor

Replaces the Scan Compositor, the Audio Visualizer and the Track Editor.

```
model/      plain data and pure functions, no three.js, no React
  schema.js       object types, their parameters and inspector layout
  controllers.js  kick / band / LFO / keyframes / switch, evaluated at a time
  maps.js         link maps (normal, inverted, ease…) and new-link defaults
  resolve.js      an object's parameters at a time, links applied
  expr.js         the maths language: x(t) = cos θ t, P_2.x, {{ω_1}} in text
  spline.js       interpolating splines of degree 1-5, C^(k-1) at every point
  globals.js      variables (project.variables) and splines, valued at a frame
  acoustics.js    a sound's features (STFT, once per sound) and a Manifold's keypoints from them
  curvePresets.js ready-made equations (the Curve's shapes among them)
  splineLabels.js a spline's points as child objects (marker + LaTeX label), kept in step with its points
  stageCopy.js    copying clips; a 3D stage's clip copies its whole stage as a new one
  timeline.js     clips, source time (hold / loop / ping-pong), the program at t
  project.js      the project document, scenes, file format
  cuts.js         auto-cut: filling a Switch from kicks or a tempo grid
  tempo.js        the project's tempo, which every tempo field follows until given its own
  meshEdits.js    a scan's mesh edits (holes filled, faces cut, vertices moved) as a patch on its triangles
  storage.js      save / open (dev server → compositor-projects/, or files)
engine/     three.js and media, no React
  Engine.js       renderer, scenes, cameras, modes, gizmo, compositing passes
  takeRig.js      a take's scan (mesh / points / wireframe) and its solve
  meshEditor.js   mesh edit mode: picking, the overlay and the tools that fill a scan's holes
  adapters.js     placed objects wrapping lib/ (protagonist, sackboy, the headphone cat, props…)
  curveObject.js  Equations and Splines: ribbon lines, instanced or wire points
  wisps.js        ribbons streaming off a point cloud (flow, drift, splash, gather), traced in the shader
  particleFlow.js a cloud's points moved as particles (splash, drag toward flow + drift, gather), traced in the shader
  flowField.js    the curled-wave flow field both of those move through
  textObject.js   text in the scene or over the frame, plain or LaTeX
  pictures.js     Image objects' pictures: PNG/JPEG/WebP, and GIFs decoded frame by frame (played on the timeline)
  shapeObject.js  shapes (cube, sphere…): a real object, or an invisible stand-in that hides what's behind it like the scan
  latex.js        MathJax, loaded on first use (mathjax.js), drawn as paths
  media.js        media links, audio mix + analysis, <video> pool
  transport.js    the clock (the audio hardware's while sound plays)
  exporter.js     offline frame-exact MP4 export (WebCodecs)
ui/         React: Sidebar (outliner) + Inspector, Timeline, Params (link menu),
            Maths (expression fields, spline points, variables), Manifold (its sound and keypoints),
            MeshEdit (the Scan mesh's Edit mesh panel)
```

Rules of the road:

- Every parameter is a plain value on its object; a controller link
  (`object.links[key]`) overrides it at render time. Nothing writes modulated
  values back into the project.
- Controllers are pure functions of timeline time and the music analysis, so
  the preview and an export agree frame for frame.
- At any time the topmost visible 3D clip (take or stage) is the base; plain
  video clips above it are flat layers. Each take has its own scene in its own
  scan frame.
- Effects are objects with no scene, applied in outliner order (glow before
  gamma, haze and grade after).
