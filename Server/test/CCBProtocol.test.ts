import { describe, expect, test } from 'bun:test';
import { parseCCBMessage } from '../src/transport/CCBProtocol';
import { createDefaultCCBSettings, parseCCBSettings } from '../src/shared/CCB';

describe('CCB 协议边界', () => {
  test('设置文件与网络消息共用严格契约，原始字符串解析不接受损坏数据', () => {
    const settings = createDefaultCCBSettings(2026);
    expect(parseCCBSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(() => parseCCBSettings({ ...settings, timeLimit: '60' })).toThrow('设置文件格式不正确');
    expect(() => parseCCBSettings({ ...settings, avatar: 1 })).toThrow('设置文件格式不正确');
    const message = { id: 'read-1', type: 'ccb.character.search' as const, payload: { keyword: '助手' } };
    expect(parseCCBMessage(JSON.stringify(message))).toEqual(message);
    expect(() => parseCCBMessage('{')).toThrow('消息必须为合法 JSON 字符串');
  });
  test('猜测仅接受角色标识，拒绝客户端判中与旧留言', () => {
    const message = { id: 'guess-1', type: 'ccb.game.guess' as const, payload: { characterId: 42 } };
    expect(parseCCBMessage(message)).toEqual(message);
    expect(() => parseCCBMessage({ ...message, payload: { ...message.payload, isCorrect: true } })).toThrow('指令参数不合法');
    expect(() => parseCCBMessage({ ...message, type: 'ccb.player.setMessage' })).toThrow('未知的角色游戏指令');
  });
  test('完整设置保留所有组合且拒绝非法队伍和数值', () => {
    expect(parseCCBMessage({ id: 'settings-1', type: 'ccb.room.settings', payload: {
      settings: { ...createDefaultCCBSettings(2026), globalPick: true, tagBan: true, syncMode: true, nonstopMode: true },
    } }).type).toBe('ccb.room.settings');
    expect(() => parseCCBMessage({ id: 'team-1', type: 'ccb.player.team', payload: { team: 0 } })).toThrow('指令参数不合法');
    expect(() => parseCCBMessage({ id: 'guess-2', type: 'ccb.game.guess', payload: { characterId: -1 } })).toThrow('指令参数不合法');
  });
  /**
   * 前端 zustand store 用 `null` 表示「尚未加入房间」，`JSON.stringify` 会原样保留 null，
   * 而 `t.Optional()` 只接受字段缺席。这里必须锁死「显式 null」与「字段省略」等价，
   * 否则加入原版房间会在解析阶段就 400（微秒级返回，页面只显示通用失败）。
   */
  test('信封与载荷的可选字段同时接受缺席与显式 null', () => {
    const join = { id: 'join-1', type: 'ccb.room.join' as const, roomId: '1234', payload: { userName: '甲' } };
    expect(parseCCBMessage(join).type).toBe('ccb.room.join');
    expect(parseCCBMessage({ ...join, sessionToken: null }).type).toBe('ccb.room.join');
    expect(parseCCBMessage({ ...join, traceId: null, roomId: null }).type).toBe('ccb.room.join');
    expect(parseCCBMessage({ ...join, payload: { ...join.payload, password: null } }).type).toBe('ccb.room.join');
    expect(parseCCBMessage({ id: 'create-1', type: 'ccb.room.create', payload: {
      source: 'original', roomId: '1234', name: '房', userName: '甲', visibility: 'public', allowSpectators: true, password: null,
    } }).type).toBe('ccb.room.create');
  });
  test('可选字段放开 null 但不放松取值约束', () => {
    const join = { id: 'join-2', type: 'ccb.room.join' as const, roomId: '1234', payload: { userName: '甲' } };
    expect(() => parseCCBMessage({ ...join, sessionToken: 42 })).toThrow('指令参数不合法');
    expect(() => parseCCBMessage({ ...join, roomId: 1234 })).toThrow('指令参数不合法');
    expect(() => parseCCBMessage({ ...join, payload: { ...join.payload, userName: 12 } })).toThrow('指令参数不合法');
    expect(() => parseCCBMessage({ ...join, payload: { ...join.payload, roomId: '1234' } })).toThrow('指令参数不合法');
    // 入房来源由统一房号目录解析，客户端不再声明。
    expect(() => parseCCBMessage({ ...join, payload: { ...join.payload, source: 'original' } })).toThrow('指令参数不合法');
  });
  /**
   * 恢复会话的凭据为空/缺席属于**可恢复状态**，解析层必须放行、由业务层回明确的失效语义。
   *
   * 若这里按 `minLength: 1` 拦下，请求会在解析阶段就 400：日志只剩 `WS raw`
   * （`parsedType` 未被赋值），错误包 id 退化成占位值，客户端匹配不到就静默丢弃，
   * 而进入房间用 `timeout: 0` 永不超时——页面永远卡在「正在连接房间…」且毫无提示。
   */
  test('恢复会话的凭据允许为空或缺席，交由业务层判定失效', () => {
    const reconnect = (sessionToken?: unknown) => ({ id: 're-1', type: 'ccb.room.reconnect' as const,
      payload: { roomId: '1234', ...(sessionToken === undefined ? {} : { sessionToken }) } });
    expect(parseCCBMessage(reconnect('ccb_original_abc_def')).type).toBe('ccb.room.reconnect');
    expect(parseCCBMessage(reconnect('')).type).toBe('ccb.room.reconnect');
    expect(parseCCBMessage(reconnect(null)).type).toBe('ccb.room.reconnect');
    expect(parseCCBMessage(reconnect()).type).toBe('ccb.room.reconnect');
    expect(() => parseCCBMessage(reconnect(123))).toThrow('指令参数不合法');
    expect(() => parseCCBMessage(reconnect('x'.repeat(129)))).toThrow('指令参数不合法');
  });
  /**
   * 客户端只见到统一房号目录的 4 位号，服务端内部的 `original:` 连接标记从不下发，
   * 信封房号与其它游戏同为 32 字符上限。
   */
  test('信封房间号与其它游戏同为 32 字符上限', () => {
    expect(parseCCBMessage({ id: 'sync-1', type: 'ccb.room.requestSync', roomId: '1'.repeat(32), payload: {} }).type).toBe('ccb.room.requestSync');
    expect(() => parseCCBMessage({ id: 'sync-2', type: 'ccb.room.requestSync', roomId: `original:${'1'.repeat(32)}`, payload: {} })).toThrow('指令参数不合法');
  });
});


test("可空线路信封在入站边界归一为字段缺席", () => {
  const message = parseCCBMessage({ id: "wire-null", type: "ccb.game.start", traceId: null, roomId: null, sessionToken: null, payload: {} });
  expect(message).toEqual({ id: "wire-null", type: "ccb.game.start", payload: {} });
  expect(message.traceId).toBeUndefined();
  expect(message.roomId).toBeUndefined();
  expect(message.sessionToken).toBeUndefined();
});
