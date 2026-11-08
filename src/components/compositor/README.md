# Compositor

Replaces the Scan Compositor, the Audio Visualizer and the Track Editor.

```
model/      plain data and pure functions, no three.js, no React
  schema.js       object types, their parameters and inspector layout
  controllers.js  kick / band / LFO / keyframes / switch, evaluated at a time
  maps.js         link maps (normal, inverted, ease…) and new-link defaults
  resolve.js      an object's parameters at a time, links applied
  timeline.js     clips, source time (hold / loop / ping-pong), the program at t
  project.js      the project document, scenes, file format
  cuts.js         auto-cut: filling a Switch from kicks or a tempo grid
  storage.js      save / open (dev server → compositor-projects/, or files)
engine/     three.js and media, no React
  Engine.js       renderer, scenes, cameras, modes, gizmo, compositing passes
  takeRig.js      a take's scan (mesh / points / wireframe) and its solve
  adapters.js     placed objects wrapping lib/ (protagonist, sackboy, props…)
  media.js        media links, audio mix + analysis, <video> pool
  transport.js    the clock (the audio hardware's while sound plays)
  exporter.js     offline frame-exact MP4 export (WebCodecs)
ui/         React: Sidebar (outliner) + Inspector, Timeline, Params (link menu)
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
