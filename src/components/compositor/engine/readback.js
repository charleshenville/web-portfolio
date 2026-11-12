// Reading a small render target back to the CPU without stalling the GPU.
//
// readRenderTargetPixels waits for every draw before it to finish, which
// stalls the frame. On WebGL2 the pixels are copied into a pixel buffer
// instead and fetched a frame or two later, once a fence says the copy is
// done. Exports (and WebGL1) read synchronously, so every frame has its own.

export default class Readback {
    constructor(renderer) {
        this.renderer = renderer;
        this.gl = renderer.getContext();
        this.async = !!renderer.capabilities.isWebGL2;
        this.pbo = null;
        this.bytes = 0;
        this.fence = null;
        this.size = null;
    }

    /** Whether a read is on its way (a new one is not started until it lands). */
    get pending() { return !!this.fence; }

    /**
     * Read `rt` (8-bit RGBA). With `sync`, or no WebGL2, returns the pixels
     * now; otherwise starts the copy and returns null (see poll).
     */
    read(rt, sync = false) {
        const w = rt.width;
        const h = rt.height;
        if (sync || !this.async) {
            const out = new Uint8Array(w * h * 4);
            this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, out);
            return out;
        }
        if (this.fence) return null;
        const { gl } = this;
        const n = w * h * 4;
        if (!this.pbo || this.bytes !== n) {
            if (this.pbo) gl.deleteBuffer(this.pbo);
            this.pbo = gl.createBuffer();
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
            gl.bufferData(gl.PIXEL_PACK_BUFFER, n, gl.STREAM_READ);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            this.bytes = n;
        }
        const prev = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(rt);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.renderer.setRenderTarget(prev);
        this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        this.size = [w, h];
        return null;
    }

    /** The pixels of the last async read once they have landed ({ data, w, h }), else null. */
    poll() {
        if (!this.fence) return null;
        const { gl } = this;
        const status = gl.getSyncParameter(this.fence, gl.SYNC_STATUS);
        if (status !== gl.SIGNALED) return null;
        gl.deleteSync(this.fence);
        this.fence = null;
        const [w, h] = this.size;
        const data = new Uint8Array(w * h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        return { data, w, h };
    }

    /** Forget a read on its way. */
    cancel() {
        if (this.fence) this.gl.deleteSync(this.fence);
        this.fence = null;
    }

    dispose() {
        this.cancel();
        if (this.pbo) this.gl.deleteBuffer(this.pbo);
        this.pbo = null;
    }
}
