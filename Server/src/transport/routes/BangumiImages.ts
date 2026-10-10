import { Elysia } from "elysia";
import type { BangumiImageService } from "../../infrastructure/BangumiImageService";

/**
 * 自建图床路由：`/bangumi-images/<源站路径>`。
 *
 * 路径与 Bangumi 源站一致（含构建期选定的尺寸档：作品 `/r/200/`、角色
 * `/r/400/` 与方格图 `/pic/crt/g/`），所以业务代码只需要把 `BANGUMI_IMAGE_URL`
 * 指向本路由的前缀，URL 改写逻辑一行不用动。
 *
 * 命中缓存直接回 avif；未命中回源抓一份（尽力而为）并异步落库。
 * 路径即内容、内容不变，可以放心长缓存 + immutable。
 */
const IMAGE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const bangumiImageRoutes = (images?: BangumiImageService) =>
  new Elysia({ name: "bangumi-images" }).get(
    "/bangumi-images/*",
    async ({ params, set }) => {
      const rest = typeof params["*"] === "string" ? params["*"] : "";
      const path = `/${rest}`;
      if (!IMAGE_PATH_PATTERN.test(path) || path.includes("..") || path.includes("//")) {
        set.status = 400;
        return { error: "Invalid image path" };
      }
      const image = images ? await images.fetch(path) : undefined;
      if (!image) {
        set.status = 404;
        return { error: "Image not found" };
      }
      set.headers["content-type"] = image.contentType;
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return image.bytes;
    },
    {
      detail: {
        tags: ["System"],
        summary: "自建图床（avif 分片缓存）",
        description:
          "按源站路径提供 avif 图片：命中分片缓存直接返回，缺失时回源抓取并落库；路径即内容可长缓存。",
      },
    },
  );
