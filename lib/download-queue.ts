export function createRequestQueue(minIntervalMs: number) {
  let tail = Promise.resolve();
  let nextStartAt = 0;

  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      nextStartAt = Date.now() + minIntervalMs;
      return task();
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

export function retryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallbackMs;
}
