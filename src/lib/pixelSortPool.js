// Runs the Pixel Sorter's engine on a pool of workers. Kept apart from
// pixelSort.js, which the worker itself imports: a module that both is in the
// worker and starts it would make the two bundles depend on each other.

// A pool of sorting workers. run() resolves with the sorted buffer; jobs
// queue when every worker is busy. Returns null where workers are not
// available, so the caller can sort on the main thread instead.
export function createSortPool(size) {
    const workers = [];
    try {
        for (let i = 0; i < size; i++) {
            workers.push(new Worker(new URL('./pixelSort.worker.js', import.meta.url)));
        }
    } catch (e) {
        workers.forEach((w) => w.terminate());
        return null;
    }

    const idle = workers.slice();
    const queue = [];
    const pending = new Map();
    let nextId = 0;
    let broken = null;

    const pump = () => {
        while (idle.length && queue.length) {
            const worker = idle.pop();
            const job = queue.shift();
            pending.set(job.id, { ...job, worker });
            worker.postMessage(
                { id: job.id, buffer: job.buffer, w: job.w, h: job.h, s: job.s },
                [job.buffer],
            );
        }
    };
    const fail = (e) => {
        broken = e || new Error('Sorting worker failed');
        pending.forEach((job) => job.reject(broken));
        queue.forEach((job) => job.reject(broken));
        pending.clear();
        queue.length = 0;
    };

    workers.forEach((worker) => {
        worker.onmessage = ({ data }) => {
            const job = pending.get(data.id);
            pending.delete(data.id);
            idle.push(worker);
            if (job) job.resolve(data.buffer);
            pump();
        };
        worker.onerror = (e) => fail(e.error || new Error(e.message));
    });

    return {
        size,
        run(buffer, w, h, s) {
            if (broken) return Promise.reject(broken);
            return new Promise((resolve, reject) => {
                queue.push({ id: nextId++, buffer, w, h, s, resolve, reject });
                pump();
            });
        },
        close() {
            workers.forEach((w) => w.terminate());
            fail(new Error('closed'));
        },
    };
}
