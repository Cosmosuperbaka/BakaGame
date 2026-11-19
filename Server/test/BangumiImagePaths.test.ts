import { describe, expect, test } from "bun:test";
import {
  bangumiImageCachePath,
  bangumiImageUrl,
  rewriteBangumiImageUrl,
} from "../src/infrastructure/BangumiImagePaths";

test("路径映射与构建脚本一致：作品 r200 / 角色 r400 / 角色 grid 原路径", () => {
  // 作品：large 原图 → /r/200/（缓存里作品只有这一档）
  expect(bangumiImageCachePath("https://lain.bgm.tv/pic/cover/l/c9/f0/8_wK0z3.jpg")).toBe(
    "/r/200/pic/cover/l/c9/f0/8_wK0z3.jpg"
  );
  // 角色：large 原图 → /r/400/
  expect(bangumiImageCachePath("https://lain.bgm.tv/pic/crt/l/b1/9c/87968_crt_z9LaF.jpg")).toBe(
    "/r/400/pic/crt/l/b1/9c/87968_crt_z9LaF.jpg"
  );
  // 角色：grid 原路径不动（不能再套缩放档）
  expect(bangumiImageCachePath("https://lain.bgm.tv/pic/crt/g/b1/9c/87968_crt_z9LaF.jpg")).toBe(
    "/pic/crt/g/b1/9c/87968_crt_z9LaF.jpg"
  );
  // 已带 /r/ 的再套一次不会叠加
  expect(bangumiImageCachePath("https://lain.bgm.tv/r/800/pic/cover/l/x.jpg")).toBe(
    "/r/200/pic/cover/l/x.jpg"
  );
  // 未知形状 / 其它主机 / 非 URL → null，调用方保留旧行为
  expect(bangumiImageCachePath("https://lain.bgm.tv/pic/cover/m/x.jpg")).toBeNull();
  expect(bangumiImageCachePath("https://example.com/pic/cover/l/x.jpg")).toBeNull();
  expect(bangumiImageCachePath("not a url")).toBeNull();
});

test("对外 URL：镜像前缀 + 缓存路径；映射不了就退回只换 host", () => {
  expect(bangumiImageUrl("https://lain.bgm.tv/pic/cover/l/a.jpg", "https://img.example.com/")).toBe(
    "https://img.example.com/r/200/pic/cover/l/a.jpg"
  );
  expect(bangumiImageUrl("https://lain.bgm.tv/pic/crt/l/b.jpg", "https://img.example.com")).toBe(
    "https://img.example.com/r/400/pic/crt/l/b.jpg"
  );
  expect(bangumiImageUrl("https://lain.bgm.tv/pic/crt/g/b.jpg", "https://img.example.com")).toBe(
    "https://img.example.com/pic/crt/g/b.jpg"
  );
  // 历史行为：没配前缀 → 原样；非 lain 主机 → 原样
  expect(bangumiImageUrl("https://lain.bgm.tv/pic/cover/l/a.jpg", "")).toBe(
    "https://lain.bgm.tv/pic/cover/l/a.jpg"
  );
  expect(bangumiImageUrl("https://other.example/x.jpg", "https://img.example.com")).toBe(
    "https://other.example/x.jpg"
  );
  expect(bangumiImageUrl("", "https://x")).toBeUndefined();
  expect(bangumiImageUrl(null, "https://x")).toBeUndefined();
  // 未知形状 + 前缀 → 只换 host（交给路由的缺失回源兜底，不 404）
  expect(bangumiImageUrl("https://lain.bgm.tv/pic/cover/m/a.jpg", "https://img.example.com")).toBe(
    "https://img.example.com/pic/cover/m/a.jpg"
  );
});

describe("rewriteBangumiImageUrl", () => {
  test("无镜像前缀原样透传，标准封面形状映射到图床档位", () => {
    expect(rewriteBangumiImageUrl(undefined)).toBeUndefined();
    expect(rewriteBangumiImageUrl("https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg")).toBe(
      "https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg"
    );
    expect(
      rewriteBangumiImageUrl("https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg", "https://img.example")
    ).toBe("https://img.example/r/200/pic/cover/l/aa/bb/1_x.jpg");
  });
});
