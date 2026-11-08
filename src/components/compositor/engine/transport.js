// The timeline's clock. While a soundtrack is loaded it is the audio
// hardware's clock (the mix plays through Web Audio from the playhead), so
// picture follows sound rather than the other way round; without one it is
// the page's own clock.

import { audioContext } from './media';

export default class Transport {
    constructor() {
        this.playing = false;
        this.offset = 0; // timeline time at the last play/seek
        this.buffer = null;
        this.src = null;
        this.startedAt = 0;
        this.rate = 1;
        this.muted = false;
        this.gain = null;
    }

    now() {
        if (!this.playing) return this.offset;
        const ctx = this.buffer ? audioContext() : null;
        const elapsed = ctx ? ctx.currentTime - this.startedAt : (performance.now() - this.startedAt) / 1000;
        return this.offset + Math.max(0, elapsed) * this.rate;
    }

    setBuffer(buffer) {
        const at = this.now();
        const was = this.playing;
        if (was) this.stopSource();
        this.buffer = buffer;
        this.offset = at;
        if (was) this.startSource();
    }

    setMuted(m) {
        this.muted = m;
        if (this.gain) this.gain.gain.value = m ? 0 : 1;
    }

    startSource() {
        if (this.buffer) {
            const ctx = audioContext();
            if (ctx.state === 'suspended') ctx.resume();
            const src = ctx.createBufferSource();
            src.buffer = this.buffer;
            src.playbackRate.value = this.rate;
            const gain = ctx.createGain();
            gain.gain.value = this.muted ? 0 : 1;
            src.connect(gain).connect(ctx.destination);
            if (this.offset < this.buffer.duration) src.start(0, this.offset);
            this.src = src;
            this.gain = gain;
            this.startedAt = ctx.currentTime;
        } else {
            this.startedAt = performance.now();
        }
    }

    stopSource() {
        if (!this.src) return;
        try { this.src.stop(); } catch (e) { /* already stopped */ }
        this.src.disconnect();
        this.src = null;
    }

    play() {
        if (this.playing) return;
        this.playing = true;
        this.startSource();
    }

    pause() {
        if (!this.playing) return;
        this.offset = this.now();
        this.playing = false;
        this.stopSource();
    }

    seek(t) {
        const was = this.playing;
        if (was) this.pause();
        this.offset = Math.max(0, t);
        if (was) this.play();
    }

    dispose() { this.stopSource(); }
}
