import { describe, expect, test } from 'bun:test';
import { parseCCBMessage } from '../src/transport/CCBProtocol';
import { createDefaultCCBSettings } from '../src/shared/CCB';

describe('CCB 协议边界', () => {
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
});
