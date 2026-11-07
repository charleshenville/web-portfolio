#!/usr/bin/env python3
"""
Rotoscoping for the Scan Compositor: object mattes cut out of a take with
Meta's SAM 2 video predictor.

A take's roto session is one JSON per take, `roto/<take>.json` beside this
file. It holds what a person did, never what the model made of it:

    objects   each with a name and colour, its prompts (clicks and an optional
              box per frame) and its brush strokes (per frame, painted over
              whatever the model said)

What the model made of it - one mask per object per frame - lives in
`work/<take>/roto/<object>/<frame>.png` (gitignored, like the rest of work/),
8-bit, the model's own probability. A finished matte is those masks, with the
strokes painted over, smoothed across neighbouring frames and feathered,
written next to the take as `public/mv/<take>/<take>_matte_<object>_<stamp>.mp4`
plus a reversed copy, and listed in `src/data/mattes.json` for the compositor.

Two things about where files go, both forced by the dev server:

  * Nothing under public/ is ever modified in place. CRA's dev server reloads
    the page whenever a file there *changes* (but not when one appears or
    goes away), which would throw away the session. So a matte is encoded
    under work/ and renamed into public/ complete, under a fresh name, and
    the old version is deleted. That is also why the session JSON is not
    kept in public/.
  * The index is in src/data so the build bundles it; the module that reads
    it accepts its own hot update, so writing it does not refresh the tool.

roto_server.py serves this to the compositor; `pipeline.py --only roto`
rebuilds the mattes without it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import warnings
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
WORK = HERE / "work"
SESSIONS = HERE / "roto"
PUBLIC = HERE.parent.parent / "public" / "mv"
INDEX = HERE.parent.parent / "src" / "data" / "mattes.json"
CHECKPOINTS = HERE / "checkpoints"
CKPT_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/"

# name -> (hydra config, checkpoint). Base-plus is the default: on an M1 Pro
# it runs about 1.1 s a frame against tiny's 0.6, and holds edges noticeably
# better on hair and fingers. The floor is memory attention, not the image
# encoder, which is why the small models are not much faster.
MODELS = {
    "tiny": ("configs/sam2.1/sam2.1_hiera_t.yaml", "sam2.1_hiera_tiny.pt"),
    "small": ("configs/sam2.1/sam2.1_hiera_s.yaml", "sam2.1_hiera_small.pt"),
    "base_plus": ("configs/sam2.1/sam2.1_hiera_b+.yaml", "sam2.1_hiera_base_plus.pt"),
    "large": ("configs/sam2.1/sam2.1_hiera_l.yaml", "sam2.1_hiera_large.pt"),
}

COLOURS = ["#ff5a5a", "#4fc3ff", "#ffd54a", "#7dff8a", "#d68bff", "#ff9a3d"]

MATTE_DEFAULTS = {"feather": 1.5, "smooth": 1, "choke": 0.0}


# ---- Session ---------------------------------------------------------------

def frames_dir(take: str) -> Path:
    return WORK / take / "frames"


def frame_paths(take: str) -> list[Path]:
    return sorted(frames_dir(take).glob("*.jpg"))


def probe_frames(path: Path) -> int | None:
    """Frame count of a video's first stream, by counting packets."""
    if not path.exists():
        return None
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=False).stdout.strip().rstrip(",")
    try:
        return int(out)
    except ValueError:
        return None


def take_fps(take: str) -> float:
    track = PUBLIC / take / "track.json"
    if track.exists():
        try:
            return float(json.loads(track.read_text()).get("fps") or 30.0)
        except (ValueError, OSError):
            pass
    return 30.0


def new_session(take: str) -> dict:
    paths = frame_paths(take)
    if not paths:
        raise FileNotFoundError(f"no frames in {frames_dir(take)}; run the pipeline's frames stage")
    h, w = cv2.imread(str(paths[0]), cv2.IMREAD_REDUCED_GRAYSCALE_2).shape[:2]
    return {
        "version": 1,
        "take": take,
        "width": w * 2,
        "height": h * 2,
        "frames": len(paths),
        "fps": take_fps(take),
        "matte": dict(MATTE_DEFAULTS),
        "objects": [],
    }


def load_session(take: str) -> dict:
    p = SESSIONS / f"{take}.json"
    if not p.exists():
        return new_session(take)
    sess = json.loads(p.read_text())
    sess.setdefault("matte", {})
    sess["matte"] = {**MATTE_DEFAULTS, **sess["matte"]}
    for o in sess.get("objects", []):
        o.setdefault("prompts", {})
        o.setdefault("strokes", {})
        o.setdefault("passes", [])
        o.setdefault("round", len(o["passes"]))
    return sess


def session_json(sess: dict) -> str:
    """Pretty, but with each point, box and stroke path on one line."""
    text = json.dumps(sess, indent=2)
    # [x, y] / [x, y, label] / [x0, y0, x1, y1] onto one line.
    text = re.sub(r"\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+){1,3})\s+\]",
                  lambda m: "[" + re.sub(r",\s+", ", ", m.group(1)) + "]", text)
    # A tracking pass onto one line.
    text = re.sub(r'\{\s+("mode": "[a-z]+"),\s+("frame": \d+)(?:,\s+("done": \d+))?\s+\}',
                  lambda m: "{" + ", ".join(g for g in m.groups() if g) + "}", text)
    # A stroke's whole path onto one line.
    text = re.sub(r'("pts": )\[\s+((?:\[[^\[\]]*\],?\s*)+)\]',
                  lambda m: m.group(1) + "[" + re.sub(r"\s+", " ", m.group(2)).strip() + "]", text)
    return text + "\n"


def save_session(sess: dict) -> Path:
    SESSIONS.mkdir(parents=True, exist_ok=True)
    p = SESSIONS / f"{sess['take']}.json"
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(session_json(sess))
    os.replace(tmp, p)
    return p


def find_object(sess: dict, obj_id: str) -> dict | None:
    return next((o for o in sess["objects"] if o["id"] == obj_id), None)


# ---- Masks on disk ---------------------------------------------------------

class MaskStore:
    """The model's mask per object per frame, as 8-bit PNGs under work/."""

    def __init__(self, take: str):
        self.root = WORK / take / "roto"
        self.lock = threading.Lock()
        self.cache: dict[tuple[str, int], np.ndarray] = {}

    def path(self, obj: str, frame: int) -> Path:
        return self.root / obj / f"{frame:05d}.png"

    def get(self, obj: str, frame: int) -> np.ndarray | None:
        key = (obj, frame)
        with self.lock:
            if key in self.cache:
                return self.cache[key]
        p = self.path(obj, frame)
        if not p.exists():
            return None
        m = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        with self.lock:
            if len(self.cache) > 48:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = m
        return m

    def put(self, obj: str, frame: int, mask: np.ndarray) -> None:
        p = self.path(obj, frame)
        p.parent.mkdir(parents=True, exist_ok=True)
        ok, buf = cv2.imencode(".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(buf.tobytes())
        os.replace(tmp, p)
        with self.lock:
            self.cache[(obj, frame)] = mask

    def frames(self, obj: str) -> list[int]:
        d = self.root / obj
        if not d.exists():
            return []
        return sorted(int(p.stem) for p in d.glob("*.png"))

    def drop(self, obj: str) -> None:
        shutil.rmtree(self.root / obj, ignore_errors=True)
        with self.lock:
            self.cache = {k: v for k, v in self.cache.items() if k[0] != obj}


def paint_strokes(mask: np.ndarray, strokes: list[dict]) -> np.ndarray:
    """Paint brush strokes over a mask: 'add' to full, 'erase' to nothing."""
    if not strokes:
        return mask
    out = mask.astype(np.float32)
    h, w = mask.shape
    for s in strokes:
        pts = np.asarray(s.get("pts") or [], dtype=np.float64).reshape(-1, 2)
        if not len(pts):
            continue
        r = max(1, int(round(float(s.get("r", 10)))))
        cover = np.zeros((h, w), np.uint8)
        # Fixed-point coordinates so a stroke keeps its sub-pixel position.
        q = np.round(pts * 16).astype(np.int32)
        if len(q) == 1:
            cv2.circle(cover, tuple(q[0]), r * 16, 255, -1, cv2.LINE_AA, 4)
        else:
            cv2.polylines(cover, [q.reshape(-1, 1, 2)], False, 255, 2 * r,
                          cv2.LINE_AA, 4)
            for p in (q[0], q[-1]):
                cv2.circle(cover, tuple(p), r * 16, 255, -1, cv2.LINE_AA, 4)
        a = cover.astype(np.float32) / 255.0
        val = 255.0 if s.get("mode") != "erase" else 0.0
        out = out * (1.0 - a) + val * a
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def composed(store: MaskStore, obj: dict, frame: int, shape: tuple[int, int]) -> np.ndarray | None:
    """The model's mask with the frame's brush strokes over it."""
    m = store.get(obj["id"], frame)
    strokes = obj["strokes"].get(str(frame))
    if m is None and not strokes:
        return None
    if m is None:
        m = np.zeros(shape, np.uint8)
    return paint_strokes(m, strokes or [])


# ---- SAM 2 -----------------------------------------------------------------

def ensure_checkpoint(model: str) -> Path:
    _, name = MODELS[model]
    p = CHECKPOINTS / name
    if p.exists():
        return p
    CHECKPOINTS.mkdir(parents=True, exist_ok=True)
    print(f"[roto] fetching {name} ...", flush=True)
    tmp = p.with_suffix(".part")
    subprocess.run(["curl", "-fSL", "-o", str(tmp), CKPT_URL + name], check=True)
    os.replace(tmp, p)
    return p


class LazyFrames:
    """
    The take's frames as the predictor wants them (1024x1024, normalised),
    decoded on demand. SAM 2's own loader holds every frame as float32 at
    1024x1024 - 12 MB a frame, 8 GB for a 650-frame take - which is more than
    the whole job needs; a JPEG decodes in a few ms against ~1 s of model.
    """

    def __init__(self, paths: list[Path], size: int):
        import torch
        self.paths = paths
        self.size = size
        self.mean = torch.tensor((0.485, 0.456, 0.406))[:, None, None]
        self.std = torch.tensor((0.229, 0.224, 0.225))[:, None, None]
        self.cache: dict[int, object] = {}

    def __len__(self) -> int:
        return len(self.paths)

    def __getitem__(self, i: int):
        import torch
        u8 = self.cache.get(i)
        if u8 is None:
            img = cv2.imread(str(self.paths[i]), cv2.IMREAD_COLOR)
            img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            img = cv2.resize(img, (self.size, self.size), interpolation=cv2.INTER_LINEAR)
            u8 = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1)
            if len(self.cache) > 96:
                self.cache.pop(next(iter(self.cache)))
            self.cache[i] = u8
        return (u8.float() / 255.0 - self.mean) / self.std


class Engine:
    """
    One SAM 2 video predictor and one take's state, kept loaded between
    requests. Every call that touches the model holds `gpu`.
    """

    def __init__(self, model: str = "base_plus", half: bool = True, device: str | None = None):
        self.model_name = model
        self.half = half
        self.device_name = device
        self.predictor = None
        self.take = None
        self.state = None
        self.gpu = threading.RLock()
        self.load_seconds = None

    # -- setup --

    def _device(self):
        import torch
        if self.device_name:
            return torch.device(self.device_name)
        if torch.backends.mps.is_available():
            return torch.device("mps")
        if torch.cuda.is_available():
            return torch.device("cuda")
        return torch.device("cpu")

    def autocast(self):
        import contextlib
        import torch
        dev = self.predictor.device if self.predictor is not None else self._device()
        if self.half and dev.type in ("mps", "cuda"):
            return torch.autocast(dev.type, dtype=torch.float16 if dev.type == "mps" else torch.bfloat16)
        return contextlib.nullcontext()

    def load_model(self):
        if self.predictor is not None:
            return self.predictor
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        warnings.filterwarnings("ignore", message=".*cannot import name '_C'.*")
        warnings.filterwarnings("ignore", category=UserWarning, module="sam2")
        from sam2.build_sam import build_sam2_video_predictor
        cfg, _ = MODELS[self.model_name]
        ckpt = ensure_checkpoint(self.model_name)
        t0 = time.time()
        self.predictor = build_sam2_video_predictor(
            cfg, str(ckpt), device=self._device(),
            # A frame that gets a correction click becomes a conditioning
            # frame - memory every later propagation is held to - rather than
            # a one-off fix the next pass forgets.
            hydra_overrides_extra=["++model.add_all_frames_to_correct_as_cond=true"],
        )
        self.load_seconds = time.time() - t0
        print(f"[roto] {self.model_name} on {self.predictor.device} "
              f"in {self.load_seconds:.1f}s", flush=True)
        return self.predictor

    def open(self, take: str, sess: dict, store: MaskStore) -> None:
        """Make `take` the loaded one, and put its prompts back into the model."""
        import torch
        import sam2.sam2_video_predictor as svp
        with self.gpu:
            if self.take == take and self.state is not None:
                return
            p = self.load_model()
            paths = frame_paths(take)
            frames = LazyFrames(paths, p.image_size)
            h, w = sess["height"], sess["width"]
            real = svp.load_video_frames
            svp.load_video_frames = lambda **_: (frames, h, w)
            try:
                with torch.inference_mode(), self.autocast():
                    self.state = p.init_state(video_path=str(frames_dir(take)),
                                              offload_video_to_cpu=True)
            finally:
                svp.load_video_frames = real
            self.take = take
            for o in sess["objects"]:
                order = sorted(o["prompts"], key=lambda f: (o["prompts"][f].get("round", 0), int(f)))
                for f in order:
                    pr = o["prompts"][f]
                    if pr.get("points") or pr.get("box"):
                        with torch.inference_mode(), self.autocast():
                            # Clicks made before the object was first tracked
                            # stand on their own, as they did; later ones
                            # were corrections, made against a tracked mask.
                            self._apply(o["id"], int(f), pr, store,
                                        init=pr.get("round", 0) == 0 or not self._has_cond(o["id"]))
            print(f"[roto] opened {take}: {len(paths)} frames, "
                  f"{len(sess['objects'])} objects", flush=True)

    def close(self) -> None:
        with self.gpu:
            self.state = None
            self.take = None
            try:
                import torch
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
            except Exception:  # noqa: BLE001
                pass

    # -- helpers --

    def _obj_idx(self, obj: str):
        return self.state["obj_id_to_idx"].get(obj)

    def _has_output(self, obj: str, frame: int) -> bool:
        i = self._obj_idx(obj)
        if i is None:
            return False
        s = self.state
        return any(frame in d[k] for d in (s["output_dict_per_obj"][i], s["temp_output_dict_per_obj"][i])
                   for k in ("cond_frame_outputs", "non_cond_frame_outputs"))

    def _has_cond(self, obj: str) -> bool:
        i = self._obj_idx(obj)
        if i is None:
            return False
        s = self.state
        return bool(s["output_dict_per_obj"][i]["cond_frame_outputs"]
                    or s["temp_output_dict_per_obj"][i]["cond_frame_outputs"])

    def _track_to(self, obj: str, frame: int, mask: np.ndarray) -> None:
        """
        Give the model a tracked output on `frame` again, from the object's
        keyframes, showing `mask` (what the user sees there). A click on it is
        then a correction made with the object in memory, as it would have
        been before the restart - rather than a click on a frame the model
        has never seen the object in, which segments only what is clicked.
        """
        import torch
        p = self.predictor
        s = self.state
        i = self._obj_idx(obj)
        self._preflight(i)
        out_d = s["output_dict_per_obj"][i]
        out, _ = p._run_single_frame_inference(
            inference_state=s, output_dict=out_d, frame_idx=frame, batch_size=1,
            is_init_cond_frame=False, point_inputs=None, mask_inputs=None,
            reverse=False, run_mem_encoder=True)
        lo = torch.from_numpy((mask > 127).astype(np.float32))[None, None].to(s["device"])
        lo = torch.nn.functional.interpolate(lo, size=out["pred_masks"].shape[-2:], mode="bilinear",
                                             align_corners=False, antialias=True)
        out["pred_masks"] = ((lo * 2.0 - 1.0) * 10.0).to(s["storage_device"])
        out_d["non_cond_frame_outputs"][frame] = out
        s["frames_tracked_per_obj"][i][frame] = {"reverse": False}

    @staticmethod
    def _to_u8(logits) -> np.ndarray:
        import torch
        return (torch.sigmoid(logits.float()) * 255.0 + 0.5).clamp(0, 255).to(torch.uint8).cpu().numpy()

    def _row(self, obj: str, masks):
        return masks[self.state["obj_ids"].index(obj), 0]

    def _apply(self, obj: str, frame: int, prompt: dict, store: MaskStore, init: bool | None = None):
        """
        Send one frame's whole prompt set for an object to the model.

        A correction click only makes sense against the mask it corrects: one
        negative click on its own segments nothing. After the server
        restarts, the model has forgotten every mask it made, so a frame it
        has no output for gets one back first, showing the mask stored on
        disk: tracked from the object's keyframes when it has any (`init`
        false), so the click is a correction with the object in memory, or
        as a plain mask prompt when this is the object's first frame. The
        clicks then refine that, as they did when they were made.
        """
        p = self.predictor
        pts = prompt.get("points") or []
        box = prompt.get("box")
        if not self._has_output(obj, frame):
            prev = store.get(obj, frame)
            if prev is not None and prev.max() > 127:
                if init is None:
                    init = not self._has_cond(obj)
                if init:
                    p.add_new_mask(self.state, frame, obj, prev > 127)
                else:
                    self._track_to(obj, frame, prev)
            elif len(pts) > 1:
                # Nothing to go on but the clicks: feed them in the order
                # they were made, each refining the mask the last one gave,
                # as the tool did. All at once, SAM 2 can settle on a
                # different object - a box without its lid, say.
                for k in range(1, len(pts)):
                    part = {"points": pts[:k], "box": box}
                    self._apply(obj, frame, part, store, init)
        kw = {}
        if pts:
            kw["points"] = [[q[0], q[1]] for q in pts]
            kw["labels"] = [1 if q[2] else 0 for q in pts]
        if box:
            kw["box"] = [box[0], box[1], box[2], box[3]]
        _, _, masks = p.add_new_points_or_box(self.state, frame, obj, clear_old_points=True, **kw)
        return self._to_u8(self._row(obj, masks))

    # -- operations --

    def prompt(self, obj: str, frame: int, prompt: dict, store: MaskStore) -> np.ndarray:
        """Set an object's clicks and box on a frame; the frame's new mask."""
        import torch
        with self.gpu, torch.inference_mode(), self.autocast():
            if prompt.get("points") or prompt.get("box"):
                mask = self._apply(obj, frame, prompt, store)
            elif self._obj_idx(obj) is not None:
                out = self.predictor.clear_all_prompts_in_frame(self.state, frame, obj)
                mask = self._to_u8(self._row(obj, out[2]))
            else:
                mask = None
            if mask is not None:
                store.put(obj, frame, mask)
            return mask

    def remove(self, obj: str) -> None:
        import torch
        with self.gpu, torch.inference_mode():
            if self.state is not None and self._obj_idx(obj) is not None:
                self.predictor.remove_object(self.state, obj, need_output=False)

    def keyframes(self, obj: str) -> list[int]:
        i = self._obj_idx(obj)
        if i is None:
            return []
        s = self.state
        return sorted(set(s["output_dict_per_obj"][i]["cond_frame_outputs"])
                      | set(s["temp_output_dict_per_obj"][i]["cond_frame_outputs"]))

    def _preflight(self, i: int) -> None:
        """propagate_in_video_preflight for one object: fold its new prompts into memory."""
        p = self.predictor
        s = self.state
        out_d = s["output_dict_per_obj"][i]
        tmp_d = s["temp_output_dict_per_obj"][i]
        import torch
        for key in ("non_cond_frame_outputs", "cond_frame_outputs"):
            for f, out in tmp_d[key].items():
                if out["maskmem_features"] is None:
                    hi = torch.nn.functional.interpolate(
                        out["pred_masks"].to(s["device"]), size=(p.image_size, p.image_size),
                        mode="bilinear", align_corners=False)
                    mf, mp = p._run_memory_encoder(
                        inference_state=s, frame_idx=f, batch_size=1, high_res_masks=hi,
                        object_score_logits=out["object_score_logits"], is_mask_from_pts=True)
                    out["maskmem_features"] = mf
                    out["maskmem_pos_enc"] = mp
                out_d[key][f] = out
            tmp_d[key].clear()
        for f in out_d["cond_frame_outputs"]:
            out_d["non_cond_frame_outputs"].pop(f, None)

    def propagate(self, obj: str, mode: str, frame: int, store: MaskStore,
                  progress=None, cancel: threading.Event | None = None,
                  limit: int | None = None) -> int:
        """
        Track one object through the take; returns how many frames were done.

        `mode` is 'all' (forwards from its first keyframe to the end, then
        backwards from it to the start), 'forward' or 'backward' from `frame`.
        Only this object is tracked, so fixing one does not re-run the rest.
        `limit` stops after that many frames (replaying a pass that was
        stopped part way).
        """
        import torch
        p = self.predictor
        with self.gpu, torch.inference_mode(), self.autocast():
            i = self._obj_idx(obj)
            if i is None:
                raise ValueError("this object has no clicks yet")
            self._preflight(i)
            s = self.state
            out_d = s["output_dict_per_obj"][i]
            cond = out_d["cond_frame_outputs"]
            if not cond:
                raise ValueError("this object has no clicks yet")
            n = s["num_frames"]
            if mode == "all":
                k = min(cond)
                passes = [(range(k, n), False), (range(k - 1, -1, -1), True)]
            elif mode == "forward":
                passes = [(range(frame, n), False)]
            elif mode == "backward":
                passes = [(range(frame, -1, -1), True)]
            else:
                raise ValueError(f"unknown mode {mode}")
            total = sum(len(r) for r, _ in passes)
            done = 0
            for order, reverse in passes:
                for f in order:
                    if (cancel is not None and cancel.is_set()) or (limit is not None and done >= limit):
                        return done
                    if f in cond:
                        logits = cond[f]["pred_masks"]
                    else:
                        out, logits = p._run_single_frame_inference(
                            inference_state=s, output_dict=out_d, frame_idx=f, batch_size=1,
                            is_init_cond_frame=False, point_inputs=None, mask_inputs=None,
                            reverse=reverse, run_mem_encoder=True)
                        out_d["non_cond_frame_outputs"][f] = out
                    s["frames_tracked_per_obj"][i][f] = {"reverse": reverse}
                    _, hi = p._get_orig_video_res_output(s, logits)
                    store.put(obj, f, self._to_u8(hi[0, 0]))
                    done += 1
                    if progress:
                        progress(done, total, f)
            return done


# ---- Mattes ----------------------------------------------------------------

def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(1e-6, e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def matte_frame(masks: list[np.ndarray | None], weights: list[float], strokes,
                shape, feather: float, choke: float) -> np.ndarray:
    """
    One frame of finished matte from the composed masks around it.

    The neighbours are averaged in (a 3-tap blend at smooth=1), which is what
    takes the shimmer out of an edge the model draws a pixel either side of
    from frame to frame; the result is pulled back to a firm edge, the
    frame's own strokes are painted on top so a brushed pixel is exact, and
    the edge is feathered last.
    """
    acc = np.zeros(shape, np.float32)
    wsum = 0.0
    for m, w in zip(masks, weights):
        if m is None:
            continue
        acc += w * m.astype(np.float32)
        wsum += w
    p = acc / (255.0 * wsum) if wsum > 0 else acc
    # Re-firm the edge around the model's own 0.5, shifted by the choke.
    c = 0.5 + 0.35 * float(np.clip(choke, -1, 1))
    p = smoothstep(c - 0.15, c + 0.15, p)
    out = (p * 255.0 + 0.5).astype(np.uint8)
    out = paint_strokes(out, strokes or [])
    if feather > 0:
        out = cv2.GaussianBlur(out, (0, 0), sigmaX=float(feather), sigmaY=float(feather))
    return out


def _ffmpeg_writer(path: Path, w: int, h: int, fps: float):
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
           "-c:v", "libx264", "-preset", "medium", "-crf", "16",
           # The same GOP as the footage: the tool seeks mattes frame by
           # frame alongside it, in both directions.
           "-g", "15", "-keyint_min", "5",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(path)]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def read_index() -> dict:
    try:
        return json.loads(INDEX.read_text())
    except (OSError, ValueError):
        return {}


def write_index(index: dict) -> None:
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    tmp = INDEX.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, INDEX)


def _stamp() -> str:
    n = int(time.time() * 10)
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + s
    return s


def write_mattes(sess: dict, store: MaskStore, objs: list[str] | None = None,
                 progress=None, cancel: threading.Event | None = None) -> dict:
    """
    Encode each object's matte (and its reverse) and publish it beside the take.

    Returns the take's entry in the matte index.
    """
    take = sess["take"]
    w, h = sess["width"], sess["height"]
    fps = float(sess.get("fps") or take_fps(take))
    n_src = sess["frames"]
    # Same frame count as the published footage, whatever the JPEGs say.
    n = probe_frames(PUBLIC / take / f"{take}.mp4") or n_src
    cfg = {**MATTE_DEFAULTS, **sess.get("matte", {})}
    radius = int(max(0, min(3, cfg["smooth"])))
    taps = [1.0 / (1 + abs(k)) for k in range(-radius, radius + 1)]
    objects = [o for o in sess["objects"] if objs is None or o["id"] in objs]
    out_dir = PUBLIC / take
    stage = WORK / take / "roto" / "_out"
    stage.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    index = read_index()
    entry = index.get(take, {"objects": []})
    keep = {o["id"]: o for o in entry.get("objects", [])}
    total = max(1, len(objects) * n)
    done = 0
    for o in objects:
        oid = o["id"]
        cache: dict[int, np.ndarray | None] = {}

        def comp(f: int):
            f = min(f, n_src - 1)
            if f not in cache:
                cache[f] = composed(store, o, f, (h, w))
                for k in [k for k in cache if k < f - radius - 1]:
                    del cache[k]
            return cache[f]

        stem = f"{take}_matte_{oid}_{_stamp()}"
        fwd_tmp = stage / f"{stem}.mp4"
        frames_png: list[bytes] = []
        writer = _ffmpeg_writer(fwd_tmp, w, h, fps)
        try:
            for f in range(n):
                if cancel is not None and cancel.is_set():
                    raise InterruptedError("cancelled")
                ms = [comp(f + k) if 0 <= f + k < n else None for k in range(-radius, radius + 1)]
                frame = matte_frame(ms, taps, o["strokes"].get(str(min(f, n_src - 1))),
                                    (h, w), cfg["feather"], cfg["choke"])
                writer.stdin.write(frame.tobytes())
                frames_png.append(cv2.imencode(".png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 1])[1].tobytes())
                done += 1
                if progress:
                    progress(done, total + len(objects) * n // 4, f)
        finally:
            writer.stdin.close()
            writer.wait()
        if writer.returncode:
            raise RuntimeError(f"ffmpeg failed writing {fwd_tmp.name}")
        rev_tmp = stage / f"{stem}_rev.mp4"
        writer = _ffmpeg_writer(rev_tmp, w, h, fps)
        try:
            for k, buf in enumerate(reversed(frames_png)):
                writer.stdin.write(cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_GRAYSCALE).tobytes())
                if progress and k % 4 == 0:
                    progress(done, total + len(objects) * n // 4, n - 1 - k)
        finally:
            writer.stdin.close()
            writer.wait()
        if writer.returncode:
            raise RuntimeError(f"ffmpeg failed writing {rev_tmp.name}")

        # Into public/ whole and under a new name, then the old one away:
        # the dev server only reloads the page for a file that changes.
        os.replace(fwd_tmp, out_dir / fwd_tmp.name)
        os.replace(rev_tmp, out_dir / rev_tmp.name)
        old = keep.get(oid)
        if old:
            for key in ("file", "rev"):
                if old.get(key) and old[key] not in (fwd_tmp.name, rev_tmp.name):
                    (out_dir / old[key]).unlink(missing_ok=True)
        keep[oid] = {
            "id": oid, "name": o["name"], "color": o.get("color", COLOURS[0]),
            "file": fwd_tmp.name, "rev": rev_tmp.name,
            "frames": n, "fps": fps, "width": w, "height": h,
            "writtenAt": int(time.time()),
        }
        print(f"[roto] wrote {out_dir / fwd_tmp.name} (+ reverse)", flush=True)

    # Objects deleted from the session lose their published matte too.
    live = {o["id"] for o in sess["objects"]}
    for oid in [k for k in keep if k not in live]:
        for key in ("file", "rev"):
            if keep[oid].get(key):
                (out_dir / keep[oid][key]).unlink(missing_ok=True)
        del keep[oid]
    order = [o["id"] for o in sess["objects"]]
    entry = {"objects": [keep[k] for k in order if k in keep]}
    for e in entry["objects"]:
        o = find_object(sess, e["id"])
        if o:
            e["name"] = o["name"]
            e["color"] = o.get("color", e.get("color"))
    if entry["objects"]:
        index[take] = entry
    else:
        index.pop(take, None)
    write_index(index)
    return entry


# ---- Rebuilding without the tool -------------------------------------------

def replay(engine: Engine, sess: dict, store: MaskStore, obj: dict, log=print) -> None:
    """
    Re-run an object from its session alone: its masks are dropped and SAM 2
    is driven as it was in the tool - each tracking pass as it was run (whole
    take, or forwards or backwards from a frame, and as far as it got),
    with the clicks made before it put in first. Which frames had been
    tracked when a click was made decides whether SAM 2 takes it as a fresh
    object or a correction, so replaying the passes themselves, not one
    whole-take pass per round, is what reproduces the masks.

    A click edited later is replayed in its latest form, in the round it was
    last changed; brush strokes are not the model's and are painted on when
    the matte is written, as always.
    """
    import torch
    store.drop(obj["id"])
    engine.remove(obj["id"])
    prompts = {int(f): p for f, p in obj["prompts"].items() if p.get("points") or p.get("box")}
    if not prompts:
        log(f"[roto] {obj['id']} ({obj['name']}): no clicks, skipped")
        return
    passes = list(obj.get("passes") or [])
    last = max(p.get("round", 0) for p in prompts.values())
    # Clicks after the last pass still want one through the whole take.
    if not passes or last >= len(passes):
        passes += [{"mode": "all", "frame": 0}] * (last + 1 - len(passes))
    for r, ps in enumerate(passes):
        with engine.gpu, torch.inference_mode(), engine.autocast():
            for f in sorted(k for k, p in prompts.items() if p.get("round", 0) == r):
                store.put(obj["id"], f, engine._apply(obj["id"], f, prompts[f], store))
        if engine._obj_idx(obj["id"]) is None:
            continue
        t0 = time.time()
        n = engine.propagate(obj["id"], ps["mode"], int(ps.get("frame", 0)), store,
                             limit=ps.get("done"))
        log(f"[roto] {obj['id']} ({obj['name']}) pass {r + 1}/{len(passes)} "
            f"({ps['mode']} from {ps.get('frame', 0)}): {n} frames in {time.time() - t0:.0f}s "
            f"({(time.time() - t0) / max(1, n):.2f} s/frame)", flush=True)


def rebuild(take: str, repropagate: bool = False, model: str = "base_plus", log=print) -> dict | None:
    """Write a take's mattes from its roto session, re-running SAM 2 where needed."""
    p = SESSIONS / f"{take}.json"
    if not p.exists():
        log(f"[roto] no roto session for {take} ({p}); nothing to do")
        return None
    sess = load_session(take)
    store = MaskStore(take)
    n = sess["frames"]
    # Masks on disk are what was last seen and corrected in the tool, partial
    # re-tracks included; only re-run SAM 2 for an object missing some.
    todo = [o for o in sess["objects"]
            if repropagate or len(store.frames(o["id"])) < n]
    if todo:
        engine = Engine(model)
        # Open with no prompts: replay puts them back in order.
        bare = {**sess, "objects": []}
        engine.open(take, bare, store)
        for o in todo:
            replay(engine, sess, store, o, log)
        save_session(sess)
    else:
        log(f"[roto] {take}: every object already has a mask on all {n} frames; "
            "writing from those (--repropagate to re-run SAM 2)")
    entry = write_mattes(sess, store)
    log(f"[roto] {take}: {len(entry['objects'])} matte(s) in {PUBLIC / take}")
    return entry


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Write a take's object mattes from roto/<take>.json")
    ap.add_argument("take")
    ap.add_argument("--repropagate", action="store_true",
                    help="re-run SAM 2 from the clicks even where masks are on disk")
    ap.add_argument("--model", choices=list(MODELS), default="base_plus")
    args = ap.parse_args()
    rebuild(args.take, args.repropagate, args.model)


if __name__ == "__main__":
    main()
