import { afterEach, describe, expect, test } from 'bun:test';
import { CCBEnrichment } from '../src/infrastructure/CCBEnrichment';
import type { CCBDataOptions } from '../src/infrastructure/CCBData';

const active: CCBEnrichment[] = [];
// 长条图只认 large > common：fixture 必须给 large，给 medium 等于「上游没图」。
const imageResponse = () => Response.json({ name: '补充角色', images: { large: 'https://images.invalid/1.jpg' } });
function create(options: Partial<CCBDataOptions> = {}) {
  const enrichment = new CCBEnrichment({ dbPath: ':memory:', apiBase: 'https://bgm.invalid', fetcher: async () => imageResponse(), ...options });
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

  test('作品封面走条目接口、请求合并并持久化原始地址，与同编号角色互不串用', async () => {
    const paths: string[] = [];
    const enrichment = create({ imageBase: 'https://mirror.invalid', fetcher: async (input) => {
      const url = String(input); paths.push(new URL(url).pathname);
      return url.includes('/subjects/') ? Response.json({ images: { large: 'https://lain.bgm.tv/pic/cover/1.jpg' } }) : imageResponse();
    } });
    const covers = await Promise.all([enrichment.resolveSubjectImage(1), enrichment.resolveSubjectImage(1)]);
    expect(covers).toEqual(['https://mirror.invalid/pic/cover/1.jpg', 'https://mirror.invalid/pic/cover/1.jpg']);
    expect(paths).toEqual(['/v0/subjects/1']);
    // 作品只存长条大图（方格图是它的裁切品，不落库）；存的是上游原始地址。
    expect(enrichment.db.query("SELECT payload FROM enrichment WHERE entity='subject' AND id=1").get())
      .toEqual({ payload: JSON.stringify({ image: 'https://lain.bgm.tv/pic/cover/1.jpg' }) });
    expect(enrichment.readImage(1)).toBeUndefined();
    expect(await enrichment.resolveCharacterImage(1)).toBe('https://images.invalid/1.jpg');
    expect(paths).toEqual(['/v0/subjects/1', '/v0/characters/1']);
  });

  test('一次回源同时存下方格图与大图，列表按尺寸各取所需', async () => {
    const paths: string[] = [];
    const enrichment = create({ fetcher: async (input) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json({ name: '补充角色', images: {
        large: 'https://lain.bgm.tv/pic/crt/l/1.jpg',
        medium: 'https://lain.bgm.tv/pic/crt/m/1.jpg',
        small: 'https://lain.bgm.tv/pic/crt/s/1.jpg',
        grid: 'https://lain.bgm.tv/pic/crt/g/1.jpg',
      } });
    } });
    // 列表先要方格图：竖版大图在方形框里会被裁到只剩头顶。
    expect(await enrichment.resolveCharacterImage(1, 'grid')).toBe('https://lain.bgm.tv/pic/crt/g/1.jpg');
    // 长条场景（图片提示 / 答案卡）要大图：命中同一份缓存，不再打上游。
    expect(await enrichment.resolveCharacterImage(1, 'large')).toBe('https://lain.bgm.tv/pic/crt/l/1.jpg');
    expect(paths).toEqual(['/v0/characters/1']);
    // small 与 medium 一律不落库：两档各有唯一首选，不留中间档。
    expect(JSON.parse((enrichment.db.query("SELECT payload FROM enrichment WHERE entity='character' AND id=1").get() as { payload: string }).payload))
      .toEqual({ image: 'https://lain.bgm.tv/pic/crt/l/1.jpg', grid: 'https://lain.bgm.tv/pic/crt/g/1.jpg' });
  });

  test('上游只有 medium 和 small 时按无图处理，不留中间档', async () => {
    const enrichment = create({ fetcher: async () => Response.json({ name: '补充角色', images: {
      medium: 'https://lain.bgm.tv/pic/crt/m/1.jpg', small: 'https://lain.bgm.tv/pic/crt/s/1.jpg',
    } }) });
    expect(await enrichment.resolveCharacterImage(1, 'grid')).toBeUndefined();
    expect(await enrichment.resolveCharacterImage(1, 'large')).toBeUndefined();
  });

  test('作品的 grid 只是 large 的裁切品，不落库；要方格图也退回 large', async () => {
    const enrichment = create({ fetcher: async () => Response.json({ images: {
      large: 'https://lain.bgm.tv/pic/cover/l/1.jpg',
      grid: 'https://lain.bgm.tv/pic/cover/g/1.jpg',
      common: 'https://lain.bgm.tv/pic/cover/c/1.jpg',
    } }) });
    expect(await enrichment.resolveSubjectImage(1, 'grid')).toBe('https://lain.bgm.tv/pic/cover/l/1.jpg');
    expect(JSON.parse((enrichment.db.query("SELECT payload FROM enrichment WHERE entity='subject' AND id=1").get() as { payload: string }).payload))
      .toEqual({ image: 'https://lain.bgm.tv/pic/cover/l/1.jpg' });
  });

  test('并发的两种尺寸合并为一次回源，各自拿到自己那份', async () => {
    let calls = 0;
    const enrichment = create({ fetcher: async () => { ++calls; return Response.json({ name: '补充角色', images: {
      large: 'https://lain.bgm.tv/pic/crt/l/1.jpg', grid: 'https://lain.bgm.tv/pic/crt/g/1.jpg',
    } }); } });
    const [thumb, full] = await Promise.all([enrichment.resolveCharacterImage(1, 'grid'), enrichment.resolveCharacterImage(1, 'large')]);
    expect([thumb, full]).toEqual(['https://lain.bgm.tv/pic/crt/g/1.jpg', 'https://lain.bgm.tv/pic/crt/l/1.jpg']);
    expect(calls).toBe(1);
  });

  test('作品无封面只做短期负缓存，到期可恢复', async () => {
    let now = 0, calls = 0;
    const enrichment = create({ now: () => now, fetcher: async () => ++calls === 1 ? Response.json({ images: {} }) : Response.json({ images: { large: 'https://images.invalid/s1.jpg' } }) });
    expect(await enrichment.resolveSubjectImage(1)).toBeUndefined();
    expect(await enrichment.resolveSubjectImage(1)).toBeUndefined(); expect(calls).toBe(1);
    now = 300_000;
    expect(await enrichment.resolveSubjectImage(1)).toBe('https://images.invalid/s1.jpg');
  });
});
