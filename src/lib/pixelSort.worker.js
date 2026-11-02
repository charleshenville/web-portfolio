/* eslint-disable no-restricted-globals */
// Sorts one frame off the main thread. The buffer comes in and goes back out
// transferred, never copied.
import { sortPixels } from './pixelSort';

self.onmessage = ({ data: job }) => {
    sortPixels(new Uint8ClampedArray(job.buffer), job.w, job.h, job.s);
    self.postMessage({ id: job.id, buffer: job.buffer }, [job.buffer]);
};
