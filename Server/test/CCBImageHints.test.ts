import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { CCBImageHints } from '../src/infrastructure/CCBImageHints';
import { deferred } from './CCBNativeFixtures';

const bitmap = async () => {
  const width = 480, height = 400;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = ((x >> 3) + (y >> 3)) % 2 ? 240 : 16;
    const offset = (y * width + x) * 3;
    data[offset] = color; data[offset + 1] = color; data[offset + 2] = color;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
};
const decode = (url: string) => Buffer.from(url.slice('data:image/webp;base64,'.length), 'base64');

describe('CCB 服务端图片提示', () => {
  test('真实解码缩图并模糊，返回自含WebP且不会泄漏原图地址', async () => {
    const png = await bitmap();
    const hints = new CCBImageHints({ fetcher: async () => new Response(png) });
    const original = await hints.render('https://images.invalid/secret-answer.png', 0);
    const blurred = await hints.render('https://images.invalid/secret-answer.png', 15);
    expect(blurred.startsWith('data:image/webp;base64,')).toBe(true);
    expect(blurred).not.toContain('secret-answer');
    const meta = await sharp(decode(blurred)).metadata();
    expect(meta.format).toBe('webp'); expect(meta.width).toBe(240); expect(meta.height).toBe(200);
    const sharpPixels = await sharp(decode(original)).stats();
    const blurryPixels = await sharp(decode(blurred)).stats();
    expect(blurryPixels.channels[0].stdev).toBeLessThan(sharpPixels.channels[0].stdev / 3);
  });

  test('同一图同一模糊级别并发合并，级别和图片分别隔离缓存', async () => {
    const png = await bitmap(); const gate = deferred<Response>(); let calls = 0;
    const hints = new CCBImageHints({ fetcher: async () => { calls++; return calls === 1 ? gate.promise : new Response(png); } });
    const first = hints.render('https://images.invalid/a.png', 1.8);
    const duplicate = hints.render('https://images.invalid/a.png', 1);
    gate.resolve(new Response(png));
    expect(await first).toBe(await duplicate); expect(calls).toBe(1);
    expect(await hints.render('https://images.invalid/a.png', 1)).toBe(await first); expect(calls).toBe(1);
    await hints.render('https://images.invalid/a.png', 2); expect(calls).toBe(2);
    await hints.render('https://images.invalid/b.png', 1); expect(calls).toBe(3);
    await hints.render('https://images.invalid/c.png', 101);
    await hints.render('https://images.invalid/c.png', 100); expect(calls).toBe(4);
  });

  test('下载失败不进成功缓存，后续重试可以恢复', async () => {
    const png = await bitmap(); let calls = 0;
    const hints = new CCBImageHints({ fetcher: async () => ++calls === 1 ? new Response('失败', { status: 502 }) : new Response(png) });
    await expect(hints.render('https://images.invalid/a.png', 1)).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    expect((await hints.render('https://images.invalid/a.png', 1)).startsWith('data:image/webp;base64,')).toBe(true);
    expect(calls).toBe(2);
  });

  test('流式下载达到八MB限制即取消读取，不把无界内容交给解码器', async () => {
    let canceled = false;
    const hints = new CCBImageHints({ fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { canceled = true; },
    })) });
    await expect(hints.render('https://images.invalid/huge.png', 1)).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(canceled).toBe(true);
  });

  test('非HTTP地址在下载前拒绝，非法地址与损坏图像返回明确业务错误', async () => {
    let calls = 0;
    const hints = new CCBImageHints({ fetcher: async () => { calls++; return new Response('不是图片'); } });
    await expect(hints.render('file:///secret.png', 1)).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    expect(calls).toBe(0);
    await expect(hints.render('not-a-url', 1)).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    await expect(hints.render('https://images.invalid/broken.png', 1)).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  });

  test('网络异常脱敏并释放在途项，恢复后的同键请求可以成功', async () => {
    const png = await bitmap(); let failing = true;
    const hints = new CCBImageHints({ fetcher: async () => { if (failing) throw new Error('private.internal:8080 ECONNRESET'); return new Response(png); } });
    await expect(hints.render('https://images.invalid/a.png', 1)).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    failing = false;
    expect((await hints.render('https://images.invalid/a.png', 1)).startsWith('data:image/webp;base64,')).toBe(true);
  });
});
