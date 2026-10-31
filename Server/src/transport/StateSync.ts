import { compare } from "fast-json-patch";
import { CEE_LOBBY_ROOMS_EVENT, CEE_STATE_EVENTS } from "../shared/CEE";
import { CEE_RANKED_STATE_EVENT } from "../shared/CEERanked";
import type { EventPacket, StatePatchOperation, StateSyncPayload } from "../shared/Index";
import { SONGUESSR_LOBBY_ROOMS_EVENT } from "../shared/SonGuessr";
import { WHOISFAKER_LOBBY_ROOMS_EVENT } from "../shared/WhoIsFaker";
import { isRecord } from "../shared/Json";

export const STATE_FULL_SYNC_INTERVAL_MS = 60_000;
export const STATE_MAX_PATCHES_BEFORE_FULL = 1_024;
export const STATE_PATCH_TO_FULL_RATIO = 0.82;
/** 单条连接攒着没发出去的状态字节超过这个水位就先丢状态帧：慢客户端不该把整台进程的内存吃穿。 */
export const STATE_BACKLOG_SHED_BYTES = 128 * 1024;
/** 回落到这个水位以下才恢复；补丁链已经断过，恢复后的第一份一定是全量。 */
export const STATE_BACKLOG_RESUME_BYTES = 32 * 1024;

const STATE_EVENTS = new Set([
  "room.snapshot",
  "game.privateState",
  "song.room.snapshot",
  "song.game.privateState",
  ...CEE_STATE_EVENTS,
  CEE_RANKED_STATE_EVENT,
]);

/**
 * 全量刷新帧：每一帧都自带完整视图，丢一帧由下一帧补回，因此和状态帧共用同一条积压水位。
 * 大厅列表是这一类里最贵的一条（一次房间变更 = 全部订阅者 × 整张表）；它不进 `STATE_EVENTS`，
 * 因为差量通道要为每条连接维护基线并按周期全量校准，而大厅订阅者可能一辈子只收一份列表。
 */
const FULL_REFRESH_EVENTS = new Set([
  WHOISFAKER_LOBBY_ROOMS_EVENT,
  SONGUESSR_LOBBY_ROOMS_EVENT,
  CEE_LOBBY_ROOMS_EVENT,
]);

/**
 * 这一帧属于哪条丢弃闸门？ACK、错误与聊天有去无回，丢了客户端就一直等，所以归为 `undefined`。
 * 两条可丢通道各自回滞：丢掉一份大厅列表不该让房间快照的差量链断掉、退回全量。
 */
const shedKindOf = (event: string): "state" | "refresh" | undefined =>
  STATE_EVENTS.has(event) ? "state" : FULL_REFRESH_EVENTS.has(event) ? "refresh" : undefined;

const isEventPacket = (value: unknown): value is EventPacket =>
  isRecord(value) && value.type === "event" && typeof value.event === "string";

// 状态快照都是 JSON 纯数据（同一棵树随后就会被 JSON.stringify 发出去）。
// structuredClone 要为 Date/Map/原型链这些用不上的能力付全套成本，而这一步在每个房间的
// 每次发布上都要付一次，所以手写只覆盖 JSON 可表达形态的拷贝。
const copyJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const list = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index++) list[index] = copyJsonValue(value[index]);
    return list;
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key in source) {
      const item = source[key];
      // JSON.stringify 同样跳过 undefined 的键，基线要和发出去的字节一致。
      if (item !== undefined) copy[key] = copyJsonValue(item);
    }
    return copy;
  }
  return value;
};

const sameScalar = (left: unknown, right: unknown) => Object.is(left, right);

const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
      if (!sameJsonValue(left[index], right[index])) return false;
    return true;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const source = left as Record<string, unknown>;
    const target = right as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length !== Object.keys(target).length) return false;
    for (const key of keys)
      if (!(key in target) || !sameJsonValue(source[key], target[key])) return false;
    return true;
  }
  return false;
};

// 只用来比较「补丁有没有接近全量」，不需要精确字节，所以不真的序列化。
const numberLength = (value: number): number => {
  if (!Number.isFinite(value)) return 9;
  if (!Number.isInteger(value)) return String(value).length;
  const magnitude = value < 0 ? -value : value;
  if (magnitude < 10) return 1;
  if (magnitude < 1_000) return 3;
  if (magnitude < 1_000_000) return 6;
  if (magnitude < 1_000_000_000) return 9;
  if (magnitude < 1e12) return 12;
  if (magnitude < 1e15) return 15;
  return 18;
};

const estimateSerializedLength = (value: unknown): number => {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number") return numberLength(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) total += estimateSerializedLength(item) + 1;
    return total;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    let total = 2;
    for (const key in record) {
      const item = record[key];
      if (item === undefined) continue;
      total += key.length + 3 + estimateSerializedLength(item);
    }
    return total;
  }
  return 4;
};

/**
 * 滑动窗口数组的补丁。
 *
 * `room.chat` 这类「装到 CHAT_LIMIT 就挤掉最旧一条」的数组，通用差分按同下标对齐：一条新消息
 * 要把窗口里每个元素的每个字段都 replace 一次，产出的补丁比整份快照还大 —— 于是「补丁接近
 * 全量」那条规则把它退回整份重发，每房间每个成员各付一次。认出「头部挤掉若干个、尾部追加
 * 若干个」这个形状后，同样的改动只要 drop+append 个操作。
 */
const WINDOW_PROBE_BUDGET = 96;
const WINDOW_MAX_REWRITE = 8;
/** 影子标记：换成同一个引用，通用差分就不会再碰这段子树。 */
const SHADOWED_ARRAY: Record<string, never> = {};

const windowShiftOperations = (
  path: string,
  previous: unknown[],
  next: unknown[],
  probe: { budget: number }
): StatePatchOperation[] | undefined => {
  // 只认「头部挤掉至少一个、尾部追加至少一个、中间仍有重叠」的滑动窗口形状：
  // 其余形状（纯追加、原地改一条、整体缩短）通用差分本来就更准，不该被这里接管。
  for (let drop = 1; drop <= Math.min(previous.length - 1, WINDOW_MAX_REWRITE); drop++) {
    const keep = previous.length - drop;
    if (keep < 1) continue;
    const appended = next.length - keep;
    if (appended < 1 || appended > WINDOW_MAX_REWRITE) continue;
    let aligned = true;
    for (let index = 0; index < keep; index++) {
      if (--probe.budget < 0) return undefined;
      if (!sameJsonValue(previous[drop + index]!, next[index]!)) {
        aligned = false;
        break;
      }
    }
    if (!aligned) continue;
    const operations: StatePatchOperation[] = [];
    for (let removed = 0; removed < drop; removed++)
      operations.push({ op: "remove", path: `${path}/0` });
    for (let added = 0; added < appended; added++)
      operations.push({ op: "add", path: `${path}/${keep + added}`, value: next[keep + added] });
    return operations;
  }
  return undefined;
};

/** 只看顶层数组：三个游戏的聊天、可见猜测集这些窗口都挂在顶层。 */
const windowedArrays = (
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): { operations: StatePatchOperation[]; keys: string[] } | undefined => {
  const operations: StatePatchOperation[] = [];
  const keys: string[] = [];
  const probe = { budget: WINDOW_PROBE_BUDGET };
  for (const key of Object.keys(previous)) {
    const before = previous[key];
    const after = next[key];
    if (!Array.isArray(before) || !Array.isArray(after)) continue;
    // 长度没变、末条也一样，就不可能既是挤出又是追加：留给通用差分，别把比较预算花光。
    if (
      before.length === after.length &&
      sameJsonValue(before[before.length - 1] ?? null, after[after.length - 1] ?? null)
    )
      continue;
    const shifted = windowShiftOperations(`/${key}`, before, after, probe);
    if (!shifted || shifted.length === 0) continue;
    operations.push(...shifted);
    keys.push(key);
  }
  return keys.length > 0 ? { operations, keys } : undefined;
};

/**
 * 测试缝：一份快照每轮只该准备一次，视图复用测试数的就是这里的调用次数。
 * 生产路径只读它，不要改写。
 */
export const preparedStateClone = { clone: copyJsonValue };

interface PreparedState {
  state: unknown;
  stateLength: number;
  patchesByPrevious: WeakMap<object, StatePatchOperation[]>;
}

// 同一次公共快照会传给房内所有连接；克隆与深比较只做一次。
const preparedStates = new WeakMap<object, PreparedState>();

const prepareState = (value: unknown): PreparedState => {
  if (value && typeof value === "object") {
    const cached = preparedStates.get(value);
    if (cached) return cached;
    const state = preparedStateClone.clone(value);
    const prepared = {
      state,
      stateLength: estimateSerializedLength(state),
      patchesByPrevious: new WeakMap<object, StatePatchOperation[]>(),
    };
    preparedStates.set(value, prepared);
    return prepared;
  }
  const state = preparedStateClone.clone(value);
  return {
    state,
    stateLength: estimateSerializedLength(state),
    patchesByPrevious: new WeakMap<object, StatePatchOperation[]>(),
  };
};

export function buildStatePatch(previous: unknown, next: unknown): StatePatchOperation[] {
  if (sameScalar(previous, next)) return [];

  if (
    previous !== null &&
    typeof previous === "object" &&
    next !== null &&
    typeof next === "object"
  ) {
    if (isRecord(previous) && isRecord(next)) {
      const windowed = windowedArrays(previous, next);
      if (windowed) {
        // 已经把窗口数组接下的字段换成同一个引用再交给通用差分：它遇到同一对象就不产出操作，
        // 其余字段仍按原来的深比较处理，两批操作作用在不同子树上，顺序无关。
        const shadowPrevious: Record<string, unknown> = { ...previous };
        const shadowNext: Record<string, unknown> = { ...next };
        for (const key of windowed.keys) {
          shadowPrevious[key] = SHADOWED_ARRAY;
          shadowNext[key] = SHADOWED_ARRAY;
        }
        return [
          ...(compare(shadowPrevious, shadowNext) as StatePatchOperation[]),
          ...windowed.operations,
        ];
      }
    }
    return compare(previous as object, next as object) as StatePatchOperation[];
  }

  return [{ op: "replace", path: "", value: next }];
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
      return [
        {
          ...payload,
          payload: {
            mode: "full",
            revision: previous.revision,
            state: nextState,
          } satisfies StateSyncPayload<unknown>,
        },
      ];
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
      estimateSerializedLength(operations) >= prepared.stateLength * STATE_PATCH_TO_FULL_RATIO;

    this.channels.set(payload.event, {
      revision,
      changesSinceFull: shouldSendFull ? 0 : previous.changesSinceFull + 1,
      lastFullAt: shouldSendFull ? now : previous.lastFullAt,
      state: nextState,
    });

    return [{ ...payload, payload: shouldSendFull ? full : patch }];
  }
}

export function createStateSyncSender(
  send: (payload: unknown) => void,
  measureBacklog?: () => number
) {
  const encoder = new StateSyncEncoder();
  const shedding = { state: false, refresh: false };
  /**
   * 只 gate 可丢弃帧：ACK、错误与聊天都是有去无回的业务消息，丢了客户端就一直等。
   * 状态帧可以丢——恢复后第一份是全量，客户端拿到的永远是完整视图。
   */
  const accepts = (payload: unknown): boolean => {
    if (!measureBacklog) return true;
    if (!isEventPacket(payload)) return true;
    const kind = shedKindOf(payload.event);
    if (!kind) return true;
    if (shedding[kind]) {
      if (measureBacklog() > STATE_BACKLOG_RESUME_BYTES) return false;
      shedding[kind] = false;
      // 只有断过差量链才需要重置基线；全量刷新帧不带基线，恢复它不该让快照退回全量。
      if (kind === "state") encoder.reset();
      return true;
    }
    if (measureBacklog() <= STATE_BACKLOG_SHED_BYTES) return true;
    shedding[kind] = true;
    return false;
  };
  const emit = (payload: unknown, options: StateSyncEncodeOptions): void => {
    if (!accepts(payload)) return;
    for (const encoded of encoder.encode(payload, options)) send(encoded);
  };
  return {
    send: (payload: unknown): void => {
      emit(payload, {});
    },
    calibrate: (payload: unknown): void => {
      emit(payload, { calibration: true });
    },
    reset: (): void => {
      shedding.state = false;
      shedding.refresh = false;
      encoder.reset();
    },
  };
}
