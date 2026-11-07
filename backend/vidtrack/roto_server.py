#!/usr/bin/env python3
"""
The Scan Compositor's rotoscoping back end: SAM 2 kept loaded, on localhost.

The compositor reaches it through the CRA dev server (src/setupProxy.js
forwards /__scan-compositor/roto/* here, and starts this process itself the
first time it is needed), so nothing of it exists on the published site.
To run it by hand instead, e.g. to watch its log or pick another model:

    backend/venv/bin/python backend/vidtrack/roto_server.py [--model small] [--port 8765]

It holds one take open at a time: the model, SAM 2's per-take state, and the
take's roto session (roto/<take>.json, see roto.py). Every edit is written
back to that JSON as it is made, so closing the browser loses nothing.

API (JSON in and out unless noted; `take` on every call):

    GET  /health
    GET  /session?take=         the session, opening the take if needed
    GET  /status?take=          per-object summary and the running job
    GET  /mask?take=&obj=&frame=   the frame's mask as an 8-bit PNG (204: none)
    POST /object   {take, action: add|update|delete, obj?, name?, color?}
    POST /prompt   {take, obj, frame, points: [[x, y, 1|0]], box: [x0, y0, x1, y1]|null}
                   -> PNG: the frame's new mask
    POST /stroke   {take, obj, frame, stroke: {mode: add|erase, r, pts}} | {.., undo} | {.., clear}
                   -> PNG
    POST /propagate {take, obj, mode: all|forward|backward, frame}
    POST /write    {take, objs?: [...], matte?: {feather, smooth, choke}}
    POST /cancel   {take}

Coordinates are pixels of the take's frames, origin top left.
"""

import argparse
import json
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import roto  # noqa: E402


class Busy(Exception):
    pass


class Roto:
    """Everything the handlers share: the engine, the open take, the job."""

    def __init__(self, engine: roto.Engine):
        self.engine = engine
        self.lock = threading.RLock()  # guards the session and job fields
        self.take = None
        self.sess = None
        self.store = None
        self.revs: dict[str, int] = {}
        self.job = None
        self.cancel = threading.Event()
        self.opening = None
        self.open_error = None

    # -- take --

    def session(self, take: str) -> dict:
        with self.lock:
            if self.take != take:
                if self.job and not self.job.get("finished"):
                    raise Busy(f"{self.take} is busy: {self.job['kind']}")
                self.engine.close()
                self.take = take
                self.sess = roto.load_session(take)
                self.store = roto.MaskStore(take)
                self.revs = {o["id"]: 1 for o in self.sess["objects"]}
                self.job = None
                self.open_error = None
                # Warm the model in the background, so the first click does
                # not wait the several seconds a take takes to open.
                self.opening = threading.Thread(target=self._open, daemon=True)
                self.opening.start()
            return self.sess

    def _open(self):
        try:
            self.engine.open(self.take, self.sess, self.store)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self.open_error = str(e)

    def ready(self, take: str) -> None:
        """The take, loaded in the model, or an error saying why not."""
        self.session(take)
        self.engine.open(take, self.sess, self.store)

    def save(self):
        roto.save_session(self.sess)

    def obj(self, obj_id: str) -> dict:
        o = roto.find_object(self.sess, obj_id)
        if o is None:
            raise KeyError(f"no object {obj_id}")
        return o

    def bump(self, obj_id: str):
        self.revs[obj_id] = self.revs.get(obj_id, 0) + 1

    def busy(self) -> bool:
        return bool(self.job and not self.job.get("finished"))

    # -- summary --

    def status(self) -> dict:
        s = self.sess
        objs = []
        for o in s["objects"]:
            frames = self.store.frames(o["id"])
            runs = []
            for f in frames:
                if runs and runs[-1][1] == f - 1:
                    runs[-1][1] = f
                else:
                    runs.append([f, f])
            objs.append({
                "id": o["id"], "name": o["name"], "color": o.get("color"),
                "keys": sorted(int(f) for f, p in o["prompts"].items() if p.get("points") or p.get("box")),
                "strokes": sorted(int(f) for f, v in o["strokes"].items() if v),
                "masked": runs,
                "stale": bool(o.get("stale")),
                "rev": self.revs.get(o["id"], 0),
                "prompts": o["prompts"],
            })
        return {
            "take": s["take"], "frames": s["frames"], "width": s["width"], "height": s["height"],
            "fps": s.get("fps"), "matte": s["matte"], "objects": objs,
            "job": self.job,
            "model": self.engine.model_name,
            "loaded": self.engine.take == s["take"] and self.engine.state is not None,
            "openError": self.open_error,
        }

    # -- jobs --

    def start_job(self, kind: str, fn, **info):
        with self.lock:
            if self.busy():
                raise Busy(f"already {self.job['kind']}")
            self.cancel.clear()
            job = {"kind": kind, "done": 0, "total": 0, "frame": None, "started": time.time(),
                   "finished": False, "error": None, **info}
            self.job = job

        def progress(done, total, frame):
            job["done"], job["total"], job["frame"] = done, total, frame
            if "obj" in job:
                self.bump(job["obj"])

        def run():
            try:
                job["result"] = fn(progress)
                job["cancelled"] = self.cancel.is_set()
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                job["error"] = str(e)
            finally:
                job["finished"] = True
                job["seconds"] = round(time.time() - job["started"], 1)
                if job["done"]:
                    job["perFrame"] = round(job["seconds"] / job["done"], 3)
                print(f"[roto] {kind} finished in {job['seconds']}s "
                      f"({job['done']} frames){' - ' + job['error'] if job['error'] else ''}", flush=True)

        threading.Thread(target=run, daemon=True).start()
        return job


def png(mask) -> bytes:
    return cv2.imencode(".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 1])[1].tobytes()


def round_pt(v, nd=1):
    return round(float(v), nd)


def make_handler(R: Roto):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quieter: only errors
            pass

        def send(self, code, body=b"", ctype="application/json", headers=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, str(v))
            self.end_headers()
            self.wfile.write(body)

        def mask_reply(self, mask, obj_id):
            hdr = {"X-Roto-Rev": R.revs.get(obj_id, 0)}
            if mask is None:
                self.send(204, b"", "image/png", hdr)
            else:
                self.send(200, png(mask), "image/png", hdr)

        def body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def handle_any(self, method):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            route = url.path.rstrip("/").split("/")[-1]
            try:
                data = self.body() if method == "POST" else q
                if route == "health":
                    self.send(200, {"ok": True, "model": R.engine.model_name, "take": R.take})
                    return
                take = data.get("take")
                if not take or "/" in take or ".." in take:
                    self.send(400, {"error": "need a take"})
                    return
                fn = getattr(self, f"{method.lower()}_{route}", None)
                if fn is None:
                    self.send(404, {"error": f"no {method} {route}"})
                    return
                fn(take, data)
            except Busy as e:
                self.send(409, {"error": str(e)})
            except (KeyError, ValueError, FileNotFoundError) as e:
                self.send(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self.send(500, {"error": str(e)})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        # ---- GET ----

        def get_session(self, take, q):
            with R.lock:
                R.session(take)
                self.send(200, R.status())

        def get_status(self, take, q):
            with R.lock:
                R.session(take)
                self.send(200, R.status())

        def get_mask(self, take, q):
            with R.lock:
                R.session(take)
                o = R.obj(q["obj"])
                f = int(q["frame"])
                sess = R.sess
            self.mask_reply(roto.composed(R.store, o, f, (sess["height"], sess["width"])), o["id"])

        # ---- POST ----

        def post_object(self, take, d):
            with R.lock:
                sess = R.session(take)
                act = d.get("action")
                if act == "add":
                    n = 1 + max([int(o["id"][1:]) for o in sess["objects"]
                                 if o["id"][1:].isdigit()] + [sess.get("lastId", 0)])
                    sess["lastId"] = n
                    oid = f"o{n}"
                    o = {"id": oid, "name": d.get("name") or f"Object {n}",
                         "color": d.get("color") or roto.COLOURS[(n - 1) % len(roto.COLOURS)],
                         "prompts": {}, "strokes": {}, "passes": [], "round": 0, "stale": False}
                    sess["objects"].append(o)
                    R.bump(oid)
                elif act == "update":
                    o = R.obj(d["obj"])
                    for k in ("name", "color"):
                        if isinstance(d.get(k), str) and d[k].strip():
                            o[k] = d[k].strip()[:60]
                    oid = o["id"]
                elif act == "delete":
                    if R.busy():
                        raise Busy("wait for the running job, or cancel it")
                    o = R.obj(d["obj"])
                    oid = o["id"]
                    sess["objects"] = [x for x in sess["objects"] if x["id"] != oid]
                    R.engine.remove(oid)
                    R.store.drop(oid)
                else:
                    raise ValueError("action is add, update or delete")
                if "matte" in d and isinstance(d["matte"], dict):
                    sess["matte"] = {**sess["matte"], **{k: float(v) for k, v in d["matte"].items()
                                                        if k in roto.MATTE_DEFAULTS}}
                R.save()
                self.send(200, {"obj": oid, **R.status()})

        def post_prompt(self, take, d):
            with R.lock:
                R.session(take)
                if R.busy():
                    raise Busy("propagating; wait or cancel")
                o = R.obj(d["obj"])
            R.ready(take)
            f = int(d["frame"])
            if not 0 <= f < R.sess["frames"]:
                raise ValueError("frame out of range")
            pts = [[round_pt(p[0]), round_pt(p[1]), 1 if p[2] else 0] for p in (d.get("points") or [])]
            box = d.get("box")
            if box:
                x0, y0, x1, y1 = (round_pt(v) for v in box)
                box = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
                if box[2] - box[0] < 2 or box[3] - box[1] < 2:
                    box = None
            prompt = {"points": pts, "box": box}
            t0 = time.time()
            R.engine.prompt(o["id"], f, prompt, R.store)
            with R.lock:
                if pts or box:
                    prompt["round"] = o.get("round", 0)
                    o["prompts"][str(f)] = prompt
                else:
                    o["prompts"].pop(str(f), None)
                o["stale"] = True
                R.bump(o["id"])
                R.save()
            print(f"[roto] {o['id']} frame {f}: {len(pts)} clicks{' + box' if box else ''} "
                  f"in {time.time() - t0:.2f}s", flush=True)
            self.mask_reply(roto.composed(R.store, o, f, (R.sess["height"], R.sess["width"])), o["id"])

        def post_stroke(self, take, d):
            with R.lock:
                R.session(take)
                o = R.obj(d["obj"])
                f = str(int(d["frame"]))
                lst = o["strokes"].setdefault(f, [])
                if d.get("clear"):
                    lst.clear()
                elif d.get("undo"):
                    if lst:
                        lst.pop()
                else:
                    s = d.get("stroke") or {}
                    pts = [[round_pt(p[0]), round_pt(p[1])] for p in (s.get("pts") or [])][:4000]
                    if pts:
                        lst.append({"mode": "erase" if s.get("mode") == "erase" else "add",
                                    "r": round_pt(max(1.0, min(400.0, float(s.get("r", 12))))),
                                    "pts": pts})
                if not lst:
                    o["strokes"].pop(f, None)
                R.bump(o["id"])
                R.save()
                sess = R.sess
            self.mask_reply(roto.composed(R.store, o, int(f), (sess["height"], sess["width"])), o["id"])

        def post_propagate(self, take, d):
            with R.lock:
                R.session(take)
                o = R.obj(d["obj"])
                mode = d.get("mode", "all")
                frame = int(d.get("frame") or 0)

                def run(progress):
                    R.ready(take)
                    n = R.engine.propagate(o["id"], mode, frame, R.store, progress, R.cancel)
                    with R.lock:
                        if mode == "all" and not R.cancel.is_set():
                            o["stale"] = False
                        # The pass as run, so `roto.py` can replay the session.
                        ps = {"mode": mode, "frame": frame}
                        if R.cancel.is_set():
                            ps["done"] = n
                        o.setdefault("passes", []).append(ps)
                        o["round"] = len(o["passes"])
                        R.bump(o["id"])
                        R.save()
                    return {"frames": n}

                job = R.start_job("propagate", run, obj=o["id"], mode=mode, fromFrame=frame)
                self.send(200, {"job": job})

        def post_write(self, take, d):
            with R.lock:
                sess = R.session(take)
                if isinstance(d.get("matte"), dict):
                    sess["matte"] = {**sess["matte"], **{k: float(v) for k, v in d["matte"].items()
                                                        if k in roto.MATTE_DEFAULTS}}
                    R.save()
                objs = d.get("objs") or None

                def run(progress):
                    return roto.write_mattes(sess, R.store, objs, progress, R.cancel)

                job = R.start_job("write", run)
                self.send(200, {"job": job})

        def post_cancel(self, take, d):
            R.cancel.set()
            self.send(200, {"ok": True})

    return H


def main():
    ap = argparse.ArgumentParser(description="SAM 2 rotoscoping server for the Scan Compositor")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", choices=list(roto.MODELS), default="base_plus")
    ap.add_argument("--fp32", action="store_true", help="no float16 autocast (slower, ~1.4x)")
    ap.add_argument("--device", default=None, help="torch device; default mps, then cuda, then cpu")
    ap.add_argument("--preload", default=None, help="take to open on start")
    args = ap.parse_args()

    R = Roto(roto.Engine(args.model, half=not args.fp32, device=args.device))
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(R))
    srv.daemon_threads = True
    print(f"[roto] listening on http://127.0.0.1:{args.port} ({args.model})", flush=True)
    if args.preload:
        R.session(args.preload)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
