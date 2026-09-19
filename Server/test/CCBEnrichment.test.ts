import { afterEach, describe, expect, test } from 'bun:test';
import { CCBEnrichment } from '../src/infrastructure/CCBEnrichment';
import type { CCBDataOptions } from '../src/infrastructure/CCBData';

const active: CCBEnrichment[] = [];
const imageResponse = () => Response.json({ name: '补充角色', images: { medium: 'https://images.invalid/1.jpg' } });
function create(options: Partial<CCBDataOptions> = {}) {
  const enrichment = new CCBEnrichment({ characterPath: ':memory:', apiBase: 'https://bgm.invalid', fetcher: async () => imageResponse(), ...options });
  active.push(enrichment); return enrichment;
}
afterEach(async () => { await Promise.all(active.splice(0).map(item => item.close())); });

describe('CCB 资料补全异常边界', () => {
  test('目录拒绝超大或不完整分页，不把异常上游结果当完整快照', async () => {
    const responses = [
      { total: 1001, data: [] },
      { total: 101, data: Array.from({ length: 101 }, (_, index) => ({ id: index + 1 })) },
      { total: 0, data: [{ id: 1 }] },
      { total: 2, data: [] },
    ];
    const enrichment = create({ fetcher: async () => Response.json(responses.shift()) });
    await expect(enrichment.fetchDirectory(1)).rejects.toMatchObject({ code: 'CCB_DIRECTORY_TOO_LARGE' });
    for (let index = 0; index < 3; index++) await expect(enrichment.fetchDirectory(1)).rejects.toMatchObject({ code: 'CCB_DATA_INVALID' });
    expect(enrichment.getDirectory(1)).toBeUndefined();
  });

  for (const absent of ['empty', 'missing'] as const) {
    test(`${absent} 图片仅内存负缓存且到期可恢复`, async () => {
      let now = 0, calls = 0;
      const enrichment = create({ now: () => now, fetcher: async () => {
        calls++;
        if (calls > 1) return imageResponse();
        return absent === 'missing' ? new Response(null, { status: 404 }) : Response.json({ images: {} });
      } });
      expect(await enrichment.resolveCharacterImage(1)).toBeUndefined();
      expect(await enrichment.resolveCharacterImage(1)).toBeUndefined(); expect(calls).toBe(1);
      expect(enrichment.db.query('SELECT count(*) AS total FROM enrichment').get()).toEqual({ total: 0 });
      now = 300_000;
      expect(await enrichment.resolveCharacterImage(1)).toBe('https://images.invalid/1.jpg'); expect(calls).toBe(2);
    });
  }

  for (const [failure, code] of [['network', 'CCB_UPSTREAM_UNAVAILABLE'], ['server', 'CCB_IMPORT_FAILED'], ['json', 'CCB_DATA_INVALID'], ['schema', 'CCB_DATA_INVALID']] as const) {
    test(`${failure} 返回明确错误且立即重试可以成功`, async () => {
      let calls = 0;
      const enrichment = create({ fetcher: async () => {
        if (++calls > 1) return imageResponse();
        if (failure === 'network') throw new TypeError('private upstream url');
        if (failure === 'server') return new Response(null, { status: 503 });
        if (failure === 'json') return new Response('{');
        return Response.json({ name: 2 });
      } });
      await expect(enrichment.resolveCharacterImage(1)).rejects.toMatchObject({ code });
      expect(await enrichment.resolveCharacterImage(1)).toBe('https://images.invalid/1.jpg'); expect(calls).toBe(2);
    });
  }

  test('限流冷却明确返回错误，到期后回源恢复', async () => {
    let now = 0, calls = 0;
    const enrichment = create({ now: () => now, fetcher: async () => ++calls === 1 ? new Response(null, { status: 429 }) : imageResponse() });
    await expect(enrichment.resolveCharacterImage(1)).rejects.toMatchObject({ code: 'BANGUMI_RATE_LIMITED' });
    now = 4999;
    await expect(enrichment.resolveCharacterImage(1)).rejects.toMatchObject({ code: 'BANGUMI_RATE_LIMITED' }); expect(calls).toBe(1);
    now = 5000;
    expect(await enrichment.resolveCharacterImage(1)).toBe('https://images.invalid/1.jpg'); expect(calls).toBe(2);
  });

  test('本地资料损坏不可当作缺图吞掉，修复后同键可成功', async () => {
    const enrichment = create();
    enrichment.db.query('INSERT INTO ccb_character_enrichment VALUES (?,1,?,0)').run(1, '{');
    await expect(enrichment.resolveCharacterImage(1)).rejects.toBeInstanceOf(SyntaxError);
    enrichment.db.exec('DELETE FROM ccb_character_enrichment');
    expect(await enrichment.resolveCharacterImage(1)).toBe('https://images.invalid/1.jpg');
  });

  test('存储失败原样传播且事务不残留半份资料，恢复后可重试', async () => {
    const enrichment = create();
    enrichment.db.exec("CREATE TRIGGER reject_image BEFORE INSERT ON enrichment BEGIN SELECT RAISE(ABORT,'模拟磁盘拒绝'); END");
    await expect(enrichment.resolveCharacterImage(1)).rejects.toMatchObject({ message: '模拟磁盘拒绝' });
    expect(enrichment.readCharacter(1)).toEqual({}); expect(enrichment.readImage(1)).toBeUndefined();
    enrichment.db.exec('DROP TRIGGER reject_image');
    expect(await enrichment.resolveCharacterImage(1)).toBe('https://images.invalid/1.jpg');
  });
});
