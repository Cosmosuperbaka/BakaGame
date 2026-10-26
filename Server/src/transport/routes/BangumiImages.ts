import { Elysia } from "elysia";
import type { BangumiImageService } from "../../infrastructure/BangumiImageService";
import { resolveClientIp } from "../ClientIp";
import { httpError, rateLimitHeaders, traceIdOf } from "../HttpErrorEnvelope";

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
 * 命中缓存直接回 avif；已搬进 R2 的图（线上主路径）只回 302，让浏览器去 CDN 取，
 * 生产机因此不再承担图床流量；未命中回源抓一份（尽力而为）并异步落库。
 * 路径即内容、内容不变，可以放心长缓存 + immutable。
 */
const IMAGE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * 图床只该回图片。`content_type` 是库里的字符串，构建脚本之外的写入路径（人工导入、
 * 旧数据）一旦把 `text/html` 之类塞进来，浏览器直连这个 URL 就可能按 HTML 渲染；
 * 白名单外的类型一律降级成不可执行的字节流。
 */
const SERVEABLE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const bangumiImageRoutes = (images?: BangumiImageService) =>
  new Elysia({ name: "bangumi-images" }).get(
    "/api/bangumi/*",
    async ({ params, request, server, set }) => {
      const rest = typeof params["*"] === "string" ? params["*"] : "";
      const path = `/${rest}`;
      if (!IMAGE_PATH_PATTERN.test(path) || path.includes("..") || path.includes("//")) {
        set.status = 400;
        return httpError("INVALID_IMAGE_PATH", "图片路径不合法", traceIdOf(set.headers));
      }
      // 回源配额按来源地址分桶：边缘反代后 peer 恒为节点地址，只能用真实 IP 标头。
      const peerIp = server?.requestIP(request)?.address ?? "unknown";
      const outcome = images
        ? await images.fetch(path, resolveClientIp(request.headers, peerIp))
        : ({ state: "missing" } as const);
      if (outcome.state === "limited") {
        Object.assign(set.headers, rateLimitHeaders(outcome.verdict));
        set.status = 429;
        return httpError("RATE_LIMITED", "图片回源配额已用完，请稍后重试", traceIdOf(set.headers));
      }
      if (outcome.state === "redirect") {
        // 302 而不是 301：换 CDN 或回滚时只等一天，不用去清浏览器缓存。
        return new Response(null, {
          status: 302,
          headers: {
            location: outcome.location,
            "cache-control": "public, max-age=86400",
          },
        });
      }
      if (outcome.state === "missing") {
        set.status = 404;
        return httpError("IMAGE_NOT_FOUND", "图片不存在", traceIdOf(set.headers));
      }
      set.headers["content-type"] = SERVEABLE_IMAGE_TYPES.has(outcome.image.contentType)
        ? outcome.image.contentType
        : "application/octet-stream";
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return outcome.image.bytes;
    },
    {
      detail: {
        tags: ["System"],
        summary: "自建图床（avif 分片缓存）",
        description:
          "按源站路径提供 avif 图片：命中分片缓存直接返回，缺失时回源抓取并落库；路径即内容可长缓存。",
      },
    }
  );
