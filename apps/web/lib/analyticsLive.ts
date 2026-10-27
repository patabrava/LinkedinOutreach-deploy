/** One in-flight snapshot and one queued catch-up; signals never contain report data. */
export function createRefreshQueue<T>(options: {
  read: (signal: AbortSignal) => Promise<T | null>;
  apply: (value: T) => void;
  visible: () => boolean;
  state: (value: 'updating' | 'current' | 'error') => void;
  delay?: number;
}) {
  let stopped = false, dirty = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const request = () => {
    if (stopped || !options.visible()) return;
    dirty = true;
    if (running || timer !== undefined) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (stopped || !options.visible()) return;
      dirty = false; running = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20_000);
      options.state('updating');
      try {
        const value = await options.read(controller.signal);
        if (!stopped) {
          if (value !== null) options.apply(value);
          options.state('current');
        }
      } catch {
        if (!stopped) options.state('error');
      } finally {
        clearTimeout(timeout); running = false;
        if (dirty && !stopped) request();
      }
    }, options.delay ?? 1_000);
  };
  return { request, stop() { stopped = true; clearTimeout(timer); controller?.abort(); } };
}
