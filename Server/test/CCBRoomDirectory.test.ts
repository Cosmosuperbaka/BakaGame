import { describe, expect, test } from 'bun:test';
import { CCBRoomDirectory } from '../src/application/CCBRoomDirectory';
import { ROOM_ID_TEST_MODE } from '../src/shared/Index';

const UUID_A = '3f1c9a2e-7d44-4b1a-9c1e-2b6f0d9e8a01';
const UUID_B = 'a9e0b7c4-1f2d-4e3a-8b5c-6d7e8f901234';
const none = new Set<string>();

function directory(nativeRooms: string[] = []) {
  const native = new Set(nativeRooms);
  return { native, rooms: new CCBRoomDirectory(id => native.has(id)) };
}

describe('CCB 统一房号目录', () => {
  test('增强房按自身房号解析，测试房号大小写不敏感', () => {
    const { rooms } = directory(['1234', ROOM_ID_TEST_MODE]);
    expect(rooms.resolve(' 1234 ')).toEqual({ source: 'native', roomId: '1234' });
    expect(rooms.resolve(ROOM_ID_TEST_MODE.toLowerCase())).toEqual({ source: 'native', roomId: ROOM_ID_TEST_MODE });
    expect(rooms.resolve('5678')).toBeNull();
  });

  test('上游 4 位房号原样作别名，UUID 房分配 4 位别名且刷新之间保持不变', () => {
    const { rooms } = directory();
    rooms.syncUpstream(['4321', UUID_A], none);
    const alias = rooms.aliasOf(UUID_A)!;
    expect(rooms.aliasOf('4321')).toBe('4321');
    expect(alias).toMatch(/^\d{4}$/);
    expect(rooms.resolve(alias)).toEqual({ source: 'original', roomId: alias, upstreamRoomId: UUID_A });
    rooms.syncUpstream([UUID_A, '4321'], none);
    expect(rooms.aliasOf(UUID_A)).toBe(alias);
  });

  test('同一批上游房间在新目录里得到同一组别名，服务重启后旧链接仍然有效', () => {
    const first = directory().rooms;
    const second = directory().rooms;
    first.syncUpstream([UUID_A, UUID_B], none);
    second.syncUpstream([UUID_B, UUID_A], none);
    expect(second.aliasOf(UUID_A)).toBe(first.aliasOf(UUID_A));
    expect(second.aliasOf(UUID_B)).toBe(first.aliasOf(UUID_B));
  });

  test('别名避让增强房与已分配的号，上游 4 位号被增强房占用时改用散列别名', () => {
    const { rooms: probe } = directory();
    probe.syncUpstream([UUID_A], none);
    const preferred = probe.aliasOf(UUID_A)!;
    const { rooms } = directory([preferred, '4321']);
    rooms.syncUpstream([UUID_A, '4321'], none);
    expect(rooms.aliasOf(UUID_A)).not.toBe(preferred);
    expect(rooms.aliasOf('4321')).not.toBe('4321');
    expect(new Set([rooms.aliasOf(UUID_A), rooms.aliasOf('4321'), preferred, '4321']).size).toBe(4);
  });

  test('上游房间消失且无本地会话时释放别名，有会话时保留', () => {
    const { rooms } = directory();
    rooms.syncUpstream([UUID_A, UUID_B], none);
    const aliasA = rooms.aliasOf(UUID_A)!;
    const aliasB = rooms.aliasOf(UUID_B)!;
    rooms.syncUpstream([], new Set([UUID_B]));
    expect(rooms.resolve(aliasA)).toBeNull();
    expect(rooms.resolve(aliasB)).toEqual({ source: 'original', roomId: aliasB, upstreamRoomId: UUID_B });
  });

  test('本站建原版房时占号，确认途中刷新拿不到该房也不释放，失败后显式释放', () => {
    const { rooms } = directory();
    expect(rooms.claimOriginal('2468')).toEqual({ source: 'original', roomId: '2468', upstreamRoomId: '2468' });
    rooms.syncUpstream([UUID_A], new Set(['2468']));
    expect(rooms.resolve('2468')?.source).toBe('original');
    expect(rooms.isAliasTaken('2468')).toBe(true);
    rooms.release('2468');
    expect(rooms.resolve('2468')).toBeNull();
    expect(rooms.isAliasTaken('2468')).toBe(false);
  });

  test('原版建房拒绝非 4 位号与已被任一方占用的号', () => {
    const { rooms } = directory(['1111']);
    rooms.syncUpstream(['2222', UUID_A], none);
    const uuidAlias = rooms.aliasOf(UUID_A)!;
    for (const roomId of ['123', '12345', 'abcd', ROOM_ID_TEST_MODE]) {
      expect(() => rooms.claimOriginal(roomId)).toThrow(expect.objectContaining({ code: 'INVALID_ROOM_ID' }));
    }
    for (const roomId of ['1111', '2222', uuidAlias]) {
      expect(() => rooms.claimOriginal(roomId)).toThrow(expect.objectContaining({ code: 'ROOM_EXISTS' }));
    }
  });

  test('上游同号房间已映射到别的别名时，本站不能再以该号建原版房', () => {
    const { native, rooms } = directory();
    native.add('3333');
    rooms.syncUpstream(['3333'], none);
    native.delete('3333');
    expect(rooms.aliasOf('3333')).not.toBe('3333');
    expect(() => rooms.claimOriginal('3333')).toThrow(expect.objectContaining({ code: 'ROOM_EXISTS' }));
  });
});
