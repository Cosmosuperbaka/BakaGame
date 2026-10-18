import { Elysia } from "elysia";
import type { BangumiImageService } from "../../infrastructure/BangumiImageService";
import { httpError, traceIdOf } from "../HttpErrorEnvelope";

/**
 * 自建图床路由：`/api/bangumi/<源站路径>`。
 *
 * 挂在 `/api` 下是为了与其它后端路径（WebSocket、监控上报）保持一致：`/api/*`
 * 在边缘已经整体放行（前端的边缘函数路由把它排除在外），新增后端路径不必再
 * 逐条去边缘配置。
 *
 * 路径与 Bangumi 源站一致（含构建期选定的尺寸档：作品 `/r/200/`、角色
 * `/r/400/` 与方格图 `/pic/crt/g/`），所以对外前缀写死成本路由（见
 * `Env.BANGUMI_IMAGE_ROUTE`）后，URL 改写逻辑一行不用动。
 *
 * 命中缓存直接回 avif；未命中回源抓一份（尽力而为）并异步落库。
 * 路径即内容、内容不变，可以放心长缓存 + immutable。
 */
const IMAGE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const bangumiImageRoutes = (images?: BangumiImageService) =>
  new Elysia({ name: "bangumi-images" }).get(
    "/api/bangumi/*",
    async ({ params, set }) => {
      const rest = typeof params["*"] === "string" ? params["*"] : "";
      const path = `/${rest}`;
      if (!IMAGE_PATH_PATTERN.test(path) || path.includes("..") || path.includes("//")) {
        set.status = 400;
        return httpError("INVALID_IMAGE_PATH", "图片路径不合法", traceIdOf(set.headers));
      }
      const image = images ? await images.fetch(path) : undefined;
      if (!image) {
        set.status = 404;
        return httpError("IMAGE_NOT_FOUND", "图片不存在", traceIdOf(set.headers));
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
