import { expect, test } from "bun:test";
import type { Static } from "@sinclair/typebox";
import {
  SongAutoFiltersInputSchema,
  SongAutoFiltersSchema,
  type SongAutoFiltersInput,
  type SongAutoFilters,
} from "../src/shared/SonGuessrFilters";
import type { SonGuessrClientMessage } from "../src/shared/SonGuessr";
import { parseCEEMessage } from "../src/transport/CEEProtocol";
import { parseWhoIsFakerMessage } from "../src/transport/WhoIsFakerProtocol";
import { parseSonGuessrMessage } from "../src/transport/SonGuessrProtocol";
import {
  PERMANENT_ROOM_ERROR_CODES,
  isPermanentRoomError,
  protocolErrorCode,
  type PermanentRoomErrorCode,
} from "../src/shared/Model";
import { GAME_IDS } from "../src/shared/Protocol";
import { ROOM_SNAPSHOT_GAMES } from "../src/shared/RoomSnapshot";
import { recordedGameSchema } from "../src/shared/ApiContract";
import { RECORDED_GAMES } from "../src/domain/GameRecord";

test("对局记录、后台接口与停机快照的游戏集合都取自协议的同一份标识", () => {
  // 新增玩法只改 GAME_IDS：记录统计、后台筛选与快照分文件不能有一处还停在旧集合。
  expect(RECORDED_GAMES).toEqual(GAME_IDS);
  expect(ROOM_SNAPSHOT_GAMES).toEqual(GAME_IDS);
  expect(recordedGameSchema.options).toEqual([...GAME_IDS]);
});

// 编译期夹具和运行时共用源码，避免解析后的类型虚构完整字段。
const partial: Static<typeof SongAutoFiltersInputSchema> = { playlist: { id: "1" } };
const input: SongAutoFiltersInput = partial;
const state: Static<typeof SongAutoFiltersSchema> = { artists: [], minPopularity: 0 };
const complete: SongAutoFilters = state;
const settings: Extract<SonGuessrClientMessage, { type: "song.room.updateSettings" }> = {
  id: "partial",
  type: "song.room.updateSettings",
  payload: { autoFilters: input },
};
// @ts-expect-error 局部筛选不能冒充规范化后的完整房间状态。
const invalidState: SongAutoFilters = partial;
void invalidState;

test("共享筛选输入与状态类型由同一schema导出", () => {
  expect(complete.artists).toEqual([]);
  expect(parseSonGuessrMessage(settings)).toEqual(settings);
});
test("三个协议拒绝继承的原型键且保持明确业务错误", () => {
  for (const parse of [parseWhoIsFakerMessage, parseSonGuessrMessage, parseCEEMessage]) {
    for (const type of ["constructor", "toString", "__proto__"]) {
      try {
        parse({ id: "prototype", type, payload: {} });
        throw new Error("未拒绝原型键");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("UNKNOWN_MESSAGE_TYPE");
      }
    }
  }
});

/**
 * 同一条非法载荷在三个玩法的解析入口必须落到同一个业务错误码。
 * 客户端按 code 决定「重连 / 退出房间 / 提示参数错」，同一个攻击在不同玩法得到不同
 * 分类时，排障口径会按玩法分叉，所以这里锁住三条路径的公共子集。
 */
test("三个协议对同一类非法输入给出同一错误码", () => {
  const parses = [parseWhoIsFakerMessage, parseSonGuessrMessage, parseCEEMessage];

  for (const parse of parses) {
    expect(() => parse("not-json")).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
    expect(() => parse({ id: "unknown", type: "nope.command", payload: {} })).toThrow(
      expect.objectContaining({ code: "UNKNOWN_MESSAGE_TYPE" })
    );
  }

  // 已声明命令 + `payload: null`：三条路径都归为参数非法，不能退化成未知类型。
  expect(() => parseWhoIsFakerMessage({ id: "n", type: "room.leave", payload: null })).toThrow(
    expect.objectContaining({ code: "INVALID_MESSAGE" })
  );
  expect(() => parseSonGuessrMessage({ id: "n", type: "song.room.leave", payload: null })).toThrow(
    expect.objectContaining({ code: "INVALID_MESSAGE" })
  );
  expect(() => parseCEEMessage({ id: "n", type: "cee.room.leave", payload: null })).toThrow(
    expect.objectContaining({ code: "INVALID_MESSAGE" })
  );
});

// CEE K→payload 关联不能在 Object.fromEntries 后丢失。
import type { CEEClientWireMessage } from "../src/shared/CEE";
const ceeWire: CEEClientWireMessage = {
  id: "wire",
  type: "cee.player.ready",
  roomId: null,
  payload: { ready: true },
};
const wrongCEEWire: CEEClientWireMessage = {
  id: "wire",
  type: "cee.player.ready",
  // @ts-expect-error ready 命令必须使用 ready 布尔载荷，不能变成任意命令的载荷并集。
  payload: { text: "错误关联" },
};
void ceeWire;
void wrongCEEWire;

/**
 * 永久房间码由 shared 单点持有，两个玩法的 store 只消费判定结果。
 * 客户端拿到非永久码就保留房间等重连，拿到永久码必须立刻退出并清凭据：
 * 判定绕过 code 取值约束时会静默翻转，一次超时即可把玩家踢出房间。
 */
const PERMANENT_ERROR_CODE_CASES = [
  "ROOM_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "SESSION_INVALID",
  "PLAYER_KICKED",
] as const;

// 编译期双向锁定：码表增删必须同步用例，任何一侧漏改都不再是「绿着上线」。
type ListedPermanentCode = (typeof PERMANENT_ERROR_CODE_CASES)[number];
const permanentCodeTablesMatch: Exclude<PermanentRoomErrorCode, ListedPermanentCode> extends never
  ? Exclude<ListedPermanentCode, PermanentRoomErrorCode> extends never
    ? true
    : never
  : never = true;
void permanentCodeTablesMatch;

const sortedCodes = (values: readonly string[]): string[] => [...values].sort();

test("永久房间码表与判定用例逐键一致", () => {
  expect(sortedCodes(PERMANENT_ROOM_ERROR_CODES)).toEqual(sortedCodes(PERMANENT_ERROR_CODE_CASES));
});

test("永久判定只认带字符串 code 的错误体", () => {
  for (const code of PERMANENT_ERROR_CODE_CASES) {
    expect(isPermanentRoomError({ code })).toBe(true);
    expect(isPermanentRoomError({ code, message: "房间不存在" })).toBe(true);
  }
  // 可恢复形态绝不能判永久：TIMEOUT/NOT_CONNECTED 由本地合成，房间本身还在。
  for (const code of [
    "TIMEOUT",
    "NOT_CONNECTED",
    "DISCONNECTED",
    "PASSWORD_INCORRECT",
    "INVALID_MESSAGE",
    "",
  ]) {
    expect(isPermanentRoomError({ code, message: "可恢复" })).toBe(false);
  }
});

test("错误体形态变化时 code 取值降级为 undefined 而非误判", () => {
  for (const shape of [
    undefined,
    null,
    "ROOM_NOT_FOUND",
    { code: 42 },
    { message: "房间不存在" },
    {},
    [],
  ]) {
    expect(protocolErrorCode(shape)).toBeUndefined();
    expect(isPermanentRoomError(shape)).toBe(false);
  }
  expect(protocolErrorCode({ code: "PLAYER_KICKED", message: "你已被移出房间" })).toBe(
    "PLAYER_KICKED"
  );
});
