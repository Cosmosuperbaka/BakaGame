import type { GameRecorder } from '../src/domain/GameRecord';
import { CEENativeService } from '../src/application/CEENativeService';
import { AppError } from '../src/domain/Errors';
import type { CEEDataProvider } from '../src/infrastructure/CEEData';
import type { CEEImageHints } from '../src/infrastructure/CEEImageHints';
import { createDefaultCEESettings, type CEECharacterView, type CEEClientMessage, type CEECommand, type CEEPayload,
  type CEEPrivateState, type CEERoomEnterResult, type CEERoomSnapshot, type CEESettings, type ConnectionRecord } from '../src/shared/Index';

export const character = (id: number, shared = false): CEECharacterView => ({
  id, name: `Character ${id}`, nameCn: `角色${id}`, gender: 'female', popularity: 100 + id,
  summary: '第一条线索。第二条线索。第三条线索。', imageUrl: `https://images.invalid/${id}.jpg`,
  appearances: [{ id: shared || id === 1 ? 100 : 100 + id, name: shared || id === 1 ? '共同作品' : `作品${id}`,
    nameCn: shared || id === 1 ? '共同作品' : `作品${id}`, year: 2020, rating: 8, ratingCount: 100 }],
  highestRating: 8, earliestAppearance: 2020, latestAppearance: 2020,
  subjectTags: ['校园'], characterTags: ['蓝发'], voiceActors: ['声优甲'], metaTags: ['校园','蓝发','声优甲'],
  comparisonAppearances: [{ id: shared || id === 1 ? 100 : 100 + id, name: shared || id === 1 ? '共同作品' : `作品${id}`, nameCn: shared || id === 1 ? '共同作品' : `作品${id}` }],
  extraTags: [],
});
type Packet = { type?: string; event?: string; payload?: unknown };
export interface CEETestClient { record: ConnectionRecord; sent: Packet[]; closed: Array<{ code?: number; reason?: string }>; token?: string; id?: string }
/** `roomId` 默认普通房号；单人开局的用例传测试房号（普通房至少两人才能开局）。 */
export function ceeTestHarness(overrides: Partial<CEEDataProvider> = {}, imageHints?: CEEImageHints, { roomId: defaultRoomId = '1234', gameRecorder }: { roomId?: string; gameRecorder?: GameRecorder } = {}) {
  let clock = 1_000_000;
  const getCalls: number[] = [];
  const data: CEEDataProvider = {
    searchCharacters: async () => [character(1), character(2)], searchSubjects: async () => [],
    getSubjectCharacters: async () => [character(1)],
    getSubjects: async (ids: number[]) => ids.map((id) => ({ id, name: `Subject ${id}`, nameCn: `作品 ${id}`, type: 2, year: 2020, rating: 7, heat: 100 })),
    getRawCharacter: async () => { throw new AppError('UNUSED', '测试不读取原始资料'); },
    getCharacter: async id => { getCalls.push(id); return character(id, id === 2); },
    chooseRandomCharacter: async () => character(1), importDirectory: async id => ({ id, subjectIds: [100], missingSubjectIds: [], importedAt: clock }),
    resolveCharacterImage: async id => `https://images.invalid/${id}.jpg`, resolveSubjectImage: async id => `https://images.invalid/s${id}.jpg`, close: () => {}, ...overrides,
  };
  const service = new CEENativeService({ data, now: () => clock, random: () => 0, imageHints, gameRecorder });
  const connect = (name: string): CEETestClient => {
    const sent: Packet[] = [], closed: CEETestClient['closed'] = [];
    const record: ConnectionRecord = { id: `${name}-${crypto.randomUUID()}`, lobbySubscribed: false,
      send: payload => sent.push(structuredClone(payload) as Packet),
      sendStateSyncCalibration: payload => sent.push(structuredClone(payload) as Packet),
      close: (code, reason) => { closed.push({ code, reason }); service.unregisterConnection(record.id); },
    };
    service.registerConnection(record); return { record, sent, closed };
  };
  const send = async <T extends CEECommand>(client: CEETestClient, type: T, payload: CEEPayload<T>, roomId = defaultRoomId) => {
    const result = await service.execute(client.record.id, { id: crypto.randomUUID(), type, roomId, sessionToken: client.token, payload } as CEEClientMessage);
    if (type === 'cee.room.create' || type === 'cee.room.join' || type === 'cee.room.reconnect') {
      const entry = result as CEERoomEnterResult; client.token = entry.sessionToken; client.id = entry.privateState.playerId;
    }
    return result;
  };
  const latest = <T>(client: CEETestClient, event: string): T => {
    const packet = [...client.sent].reverse().find(message => message.event === event);
    if (!packet) throw new Error(`未收到事件 ${event}`);
    return packet.payload as T;
  };
  const snapshot = (client: CEETestClient) => latest<CEERoomSnapshot>(client, 'cee.room.snapshot');
  const privateState = (client: CEETestClient) => latest<CEEPrivateState>(client, 'cee.game.privateState');
  const create = async (name = '房主') => {
    const host = connect(name);
    await send(host, 'cee.room.create', { source: 'native', roomId: defaultRoomId, name: '测试房间', userName: name, visibility: 'public', allowSpectators: true });
    return host;
  };
  const join = async (name: string) => { const client = connect(name); await send(client, 'cee.room.join', { userName: name }); return client; };
  const configure = (host: CEETestClient, patch: Partial<CEESettings>) => send(host, 'cee.room.settings', { settings: { ...createDefaultCEESettings(2026), timeLimit: 0, ...patch } });
  const ready = async (...clients: CEETestClient[]) => { for (const client of clients) await send(client, 'cee.player.ready', { ready: true }); };
  const guess = (client: CEETestClient, id: number) => send(client, 'cee.game.guess', { characterId: id });
  /** 手动出题：把出题方式切到手动（保留现有设置）、开始进入选人阶段，再指定出题人。 */
  const chooseSetter = async (host: CEETestClient, setterId: string) => {
    const settings = snapshot(host).settings;
    if (settings.answerMode !== 'manual') await send(host, 'cee.room.settings', { settings: { ...settings, answerMode: 'manual' } });
    if (snapshot(host).phase !== 'choosingSetter') await send(host, 'cee.game.start', {});
    return send(host, 'cee.game.chooseSetter', { playerId: setterId });
  };
  const advance = (milliseconds: number) => { clock += milliseconds; service.runHousekeeping(); };
  return { service, data, connect, send, snapshot, privateState, create, join, configure, ready, guess, chooseSetter, advance, getCalls, now: () => clock };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
