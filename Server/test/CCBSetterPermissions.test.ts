import { expect, test } from 'bun:test';
import { CCBOriginalService } from '../src/application/CCBOriginalService';
import type { CCBClientMessage, CCBRoomEnterResult } from '../src/shared/CCB';
import { FixtureRoom, originalData } from './CCBOriginalFixtures';

test('原版手动出题名单不受随机开局准备限制，非房主及出题阶段不授予选择权限', async () => {
  const upstream = new FixtureRoom();
  const service = new CCBOriginalService({ data: originalData, serverUrl: 'https://original.example', aesSecret: 'fixture-key',
    socketFactory: upstream.factory, fetcher: async () => Response.json([{ id: '1234', isPublic: true }]) });
  for (const id of ['host', 'guest']) service.registerConnection({ id, lobbySubscribed: false, send() {}, close() {} });
  const send = (id: string, token: string, message: CCBClientMessage) => service.execute(id, { ...message, sessionToken: token });
  try {
    const host = await service.execute('host', { id: 'create', type: 'ccb.room.create', payload: { source: 'original', roomId: '1234',
      name: '出题权限', userName: '房主', visibility: 'public', allowSpectators: true } }) as CCBRoomEnterResult;
    const guest = await service.execute('guest', { id: 'join', type: 'ccb.room.join', roomId: '1234', payload: { source: 'original', userName: '出题人' } }) as CCBRoomEnterResult;
    await send('guest', guest.sessionToken, { id: 'unready', type: 'ccb.player.ready', payload: { ready: false } });
    const sync = () => send('host', host.sessionToken, { id: 'sync', type: 'ccb.room.requestSync', payload: {} }) as Promise<CCBRoomEnterResult>;
    const waiting = await sync();
    expect(waiting.privateState.canStart).toBe(false);
    expect(waiting.privateState.setterCandidateIds).toContain(guest.privateState.playerId);
    expect(guest.privateState.setterCandidateIds).toEqual([]);
    await send('host', host.sessionToken, { id: 'choose', type: 'ccb.game.chooseSetter', payload: { playerId: guest.privateState.playerId } });
    expect((await sync()).privateState.setterCandidateIds).toEqual([]);
    const setter = await send('guest', guest.sessionToken, { id: 'setter-sync', type: 'ccb.room.requestSync', payload: {} }) as CCBRoomEnterResult;
    expect(setter.privateState.canSetAnswer).toBe(true);
  } finally { service.close(); }
});
