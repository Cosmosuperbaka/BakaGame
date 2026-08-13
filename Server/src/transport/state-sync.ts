import type {
  EventPacket,
  StatePatchOperation,
  StatePathSegment,
  StateSyncPayload,
} from "../shared";

export const STATE_FULL_SYNC_INTERVAL_MS = 60_000;
export const STATE_MAX_PATCHES_BEFORE_FULL = 1_024;
export const STATE_PATCH_TO_FULL_RATIO = 0.82;

const STATE_EVENTS = new Set([
  "room.snapshot",
  "game.privateState",
  "song.room.snapshot",
  "song.game.privateState",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isEventPacket = (value: unknown): value is EventPacket =>
  isRecord(value) && value.type === "event" && typeof value.event === "string";

const cloneState = <T>(value: T): T => structuredClone(value);

const sameScalar = (left: unknown, right: unknown) => Object.is(left, right);

interface PreparedState {
  state: unknown;
  serializedLength: number;
  patchesByPrevious: WeakMap<object, StatePatchOperation[]>;
}

// 同一次公共快照会传给房内所有连接；克隆与深比较只做一次。
const preparedStates = new WeakMap<object, PreparedState>();

const prepareState = (value: unknown): PreparedState => {
  if (value && typeof value === "object") {
    const cached = preparedStates.get(value);
    if (cached) return cached;
    const state = cloneState(value);
    const prepared = {
      state,
      serializedLength: JSON.stringify(state).length,
      patchesByPrevious: new WeakMap<object, StatePatchOperation[]>(),
    };
    preparedStates.set(value, prepared);
    return prepared;
  }
  const state = cloneState(value);
  return {
    state,
    serializedLength: JSON.stringify(state).length,
    patchesByPrevious: new WeakMap<object, StatePatchOperation[]>(),
  };
};

export function buildStatePatch(
  previous: unknown,
  next: unknown,
  path: StatePathSegment[] = [],
  operations: StatePatchOperation[] = [],
): StatePatchOperation[] {
  if (sameScalar(previous, next)) return operations;

  if (Array.isArray(previous) && Array.isArray(next)) {
    const commonLength = Math.min(previous.length, next.length);
    for (let index = 0; index < commonLength; index += 1) {
      buildStatePatch(previous[index], next[index], [...path, index], operations);
    }
    if (next.length >= previous.length) {
      for (let index = previous.length; index < next.length; index += 1) {
        operations.push({ op: "set", path: [...path, index], value: next[index] });
      }
      return operations;
    }
    operations.push({ op: "set", path, value: next });
    return operations;
  }

  if (isRecord(previous) && isRecord(next)) {
    for (const key of Object.keys(previous)) {
      if (!(key in next)) operations.push({ op: "delete", path: [...path, key] });
    }
    for (const [key, value] of Object.entries(next)) {
      if (!(key in previous)) {
        operations.push({ op: "set", path: [...path, key], value });
      } else {
        buildStatePatch(previous[key], value, [...path, key], operations);
      }
    }
    return operations;
  }

  operations.push({ op: "set", path, value: next });
  return operations;
}

interface ChannelState {
  revision: number;
  changesSinceFull: number;
  lastFullAt: number;
  state: unknown;
}

export interface StateSyncEncoderOptions {
  now?: () => number;
  fullSyncIntervalMs?: number;
}

export interface StateSyncEncodeOptions {
  /** housekeeping 校准调用允许在状态未变化时重发当前全量。 */
  calibration?: boolean;
}

export class StateSyncEncoder {
  private readonly channels = new Map<string, ChannelState>();
  private readonly now: () => number;
  private readonly fullSyncIntervalMs: number;

  constructor(options: StateSyncEncoderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fullSyncIntervalMs = options.fullSyncIntervalMs ?? STATE_FULL_SYNC_INTERVAL_MS;
  }

  reset(): void {
    this.channels.clear();
  }

  encode(payload: unknown, options: StateSyncEncodeOptions = {}): unknown[] {
    if (!isEventPacket(payload) || !STATE_EVENTS.has(payload.event)) return [payload];

    const previous = this.channels.get(payload.event);
    const prepared = prepareState(payload.payload);
    const nextState = prepared.state;
    const now = this.now();
    if (!previous) {
      const sync: StateSyncPayload<unknown> = {
        mode: "full",
        revision: 1,
        state: nextState,
      };
      this.channels.set(payload.event, {
        revision: 1,
        changesSinceFull: 0,
        lastFullAt: now,
        state: nextState,
      });
      return [{ ...payload, payload: sync }];
    }

    let operations: StatePatchOperation[] | undefined;
    if (previous.state && typeof previous.state === "object") {
      operations = prepared.patchesByPrevious.get(previous.state);
      if (!operations) {
        operations = buildStatePatch(previous.state, nextState);
        prepared.patchesByPrevious.set(previous.state, operations);
      }
    } else {
      operations = buildStatePatch(previous.state, nextState);
    }
    if (operations.length === 0) {
      if (!options.calibration || now - previous.lastFullAt < this.fullSyncIntervalMs) {
        return [];
      }

      this.channels.set(payload.event, {
        ...previous,
        changesSinceFull: 0,
        lastFullAt: now,
      });
      return [{
        ...payload,
        payload: {
          mode: "full",
          revision: previous.revision,
          state: nextState,
        } satisfies StateSyncPayload<unknown>,
      }];
    }

    const revision = previous.revision + 1;
    const patch: StateSyncPayload<unknown> = {
      mode: "patch",
      baseRevision: previous.revision,
      revision,
      operations,
    };
    const full: StateSyncPayload<unknown> = {
      mode: "full",
      revision,
      state: nextState,
    };
    const shouldSendFull =
      now - previous.lastFullAt >= this.fullSyncIntervalMs ||
      previous.changesSinceFull + 1 >= STATE_MAX_PATCHES_BEFORE_FULL ||
      JSON.stringify(operations).length >= prepared.serializedLength * STATE_PATCH_TO_FULL_RATIO;

    this.channels.set(payload.event, {
      revision,
      changesSinceFull: shouldSendFull ? 0 : previous.changesSinceFull + 1,
      lastFullAt: shouldSendFull ? now : previous.lastFullAt,
      state: nextState,
    });

    return [{ ...payload, payload: shouldSendFull ? full : patch }];
  }
}

export function createStateSyncSender(send: (payload: unknown) => void) {
  const encoder = new StateSyncEncoder();
  return {
    send(payload: unknown) {
      for (const encoded of encoder.encode(payload)) send(encoded);
    },
    calibrate(payload: unknown) {
      for (const encoded of encoder.encode(payload, { calibration: true })) send(encoded);
    },
    reset: () => encoder.reset(),
  };
}
