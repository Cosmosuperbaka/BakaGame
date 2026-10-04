/** Own one socket's room-entry transaction until its ACK and any abandoned-seat release settle. */
export function createRoomEntry<T>(options: {
  generation: () => number;
  begin: () => void;
  apply: (receipt: T) => void;
  discard: (receipt: T) => Promise<void>;
}) {
  let lifecycle = new AbortController();
  let tail: Promise<boolean> | null = null;
  let pendingCount = 0;
  let restoring: {
    key: string;
    generation: number;
    owners: Set<AbortSignal | undefined>;
    promise: Promise<boolean>;
  } | null = null;
  const cancelled = () => new DOMException("入房操作已取消", "AbortError");
  const run = (
    request: () => Promise<T>,
    abandoned: () => boolean,
    onFailure?: (error: unknown) => boolean,
  ) => {
    const generation = options.generation();
    const lifetime = lifecycle.signal;
    const isAbandoned = () => lifetime.aborted || abandoned();
    const assertOwner = () => {
      if (generation !== options.generation() || isAbandoned()) throw cancelled();
    };
    const execute = async () => {
      assertOwner();
      options.begin();
      let receipt: T;
      try {
        receipt = await request();
      } catch (error) {
        assertOwner();
        if (onFailure?.(error)) return false;
        throw error;
      }
      if (generation !== options.generation()) throw cancelled();
      if (isAbandoned()) {
        // Never install stale credentials. Release the exact acknowledged seat before a new entry.
        await options.discard(receipt);
        throw cancelled();
      }
      options.apply(receipt);
      return true;
    };
    pendingCount += 1;
    const pending = tail ? tail.then(execute, execute) : execute();
    tail = pending;
    const release = () => {
      pendingCount -= 1;
      if (tail === pending) tail = null;
    };
    void pending.then(release, release);
    return pending;
  };
  return {
    isPending: () => pendingCount > 0,
    cancel() {
      lifecycle.abort();
      lifecycle = new AbortController();
      restoring = null;
    },
    enter(request: () => Promise<T>, signal?: AbortSignal): Promise<void> {
      return run(request, () => signal?.aborted ?? false).then(() => undefined);
    },
    restore(
      key: string,
      request: () => Promise<T>,
      onFailure: (error: unknown) => boolean,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const generation = options.generation();
      if (!restoring || restoring.key !== key || restoring.generation !== generation) {
        const owners = new Set<AbortSignal | undefined>([signal]);
        const promise = run(request, () => [...owners].every(owner => owner?.aborted), onFailure);
        const entry = { key, generation, owners, promise };
        restoring = entry;
        const release = () => {
          if (restoring === entry) restoring = null;
        };
        void promise.then(release, release);
      } else {
        restoring.owners.add(signal);
      }
      return restoring.promise.then(result => {
        if (signal?.aborted) throw cancelled();
        return result;
      });
    },
  };
}
