import { Elysia, t } from "elysia";
import { AppError } from "../../domain/Errors";
import type { ClientArtifacts } from "../../infrastructure/ClientArtifacts";
import { compareClientVersion, type ClientChannel } from "../../infrastructure/ClientChannel";
import type { ClientWebBundle } from "../../infrastructure/ClientWebBundle";
import { resolveClientIp } from "../ClientIp";

/**
 * 客户端通道证明的 HTTP 面：注册设备公钥、领挑战、交签名换一次性 ticket，
 * 外加两条给首页用的读回——更新提醒读的最低版本，下载弹窗读的制品元数据。
 * 约束见 `Server/docs/ClientChannel.md`；字段名与壳（`Desktop/`、`Mobile/`）对齐，改名即断链。
 *
 * 这里刻意不做房间准入：ticket 只证明「这台设备上的这个壳持有私钥」，
 * 反作弊房还额外要求已登录，那条门槛在 `CEERooms.requireAdmission`。
 */
const selfCheckSchema = t.Object(
  {
    hardFail: t.Array(t.String({ maxLength: 64 })),
    softFail: t.Array(t.String({ maxLength: 64 })),
    keyProtection: t.Optional(t.Union([t.Literal("hardware"), t.Literal("software")])),
    attestationLevel: t.Optional(
      t.Union([t.Literal("trusted"), t.Literal("degraded"), t.Literal("rejected")])
    ),
  },
  { additionalProperties: false }
);
const clientTypeSchema = t.Union([t.Literal("desktop"), t.Literal("mobile")]);
/** 壳类型 → 安装包平台：制品清单按平台索引，更新检查按壳类型提问。 */
const PACKAGE_PLATFORM = { desktop: "windows", mobile: "android" } as const;
const versionSchema = t.String({ minLength: 1, maxLength: 32, pattern: "^\\d+(\\.\\d+){0,3}$" });
const clientIdSchema = t.String({ minLength: 8, maxLength: 64 });
/** 厂商链一般 3—5 张，留到 8 张；单张 PEM 上限按 EC P-384 根的量级给。 */
const attestationSchema = t.Object(
  {
    attestationChallenge: t.String({ minLength: 8, maxLength: 512 }),
    chain: t.Array(t.String({ minLength: 64, maxLength: 8192 }), { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false }
);

export const clientChannelRoutes = (
  channel: ClientChannel | undefined,
  artifacts?: ClientArtifacts,
  webBundle?: ClientWebBundle
) => {
  /** 未装配通道时明确报错，而不是静默放行：壳会把「注册成功」误判成「能进反作弊房」。 */
  const require = () => {
    if (!channel) throw new AppError("CLIENT_CHANNEL_DISABLED", "服务端未启用客户端通道");
    return channel;
  };
  return new Elysia({ name: "client-channel", normalize: false })
    .post(
      "/api/client/register",
      async ({ body }) => {
        return require().register(body);
      },
      {
        body: t.Object(
          {
            clientType: clientTypeSchema,
            platform: t.String({ minLength: 1, maxLength: 32 }),
            clientVersion: versionSchema,
            keyAlgorithm: t.Union([t.Literal("ed25519"), t.Literal("ec-p256")]),
            publicKey: t.String({ minLength: 32, maxLength: 1024 }),
            selfCheck: selfCheckSchema,
            attestation: t.Optional(attestationSchema),
          },
          { additionalProperties: false }
        ),
      }
    )
    .post(
      "/api/client/challenge",
      ({ body }) => {
        return require().issue(body.clientId);
      },
      { body: t.Object({ clientId: clientIdSchema }, { additionalProperties: false }) }
    )
    .post(
      "/api/client/attest",
      async ({ body, request, server }) => {
        // 票绑定签发时的来源地址：抓到的票在另一台机器上用不掉。
        const clientIp = resolveClientIp(request.headers, server?.requestIP(request)?.address);
        return require().attest(body, clientIp);
      },
      {
        body: t.Object(
          {
            clientId: clientIdSchema,
            challenge: t.String({ minLength: 16, maxLength: 256 }),
            signature: t.String({ minLength: 32, maxLength: 512 }),
            clientType: clientTypeSchema,
            clientVersion: versionSchema,
            selfCheck: selfCheckSchema,
          },
          { additionalProperties: false }
        ),
      }
    )
    .get(
      "/api/client/update-check",
      async ({ query, set }) => {
        // 比对只用服务端这一份 compareClientVersion：前端再实现一遍，两端对「够不够新」
        // 的判断迟早各自漂移。这里读回的最低版本也只用于提醒，拦人仍在 requireAdmission。
        set.headers["cache-control"] = "no-store";
        const channel = require();
        const minimumVersion = channel.minimumVersionFor(query.clientType);
        const outdated = channel.isOutdated(query.clientType, query.clientVersion);
        // 软提醒的第二个依据：已发布的最新壳版本。它回答「有没有新版可拿」，
        // 与「够不够格进反作弊房」是两件事——发新版不等于协议破坏性变更，不能自动抬硬门槛。
        // 已经低于硬门槛时不必再问制品：硬提醒优先，也别让一次 CDN 探测拖慢「进不了房」这句提示。
        const latestVersion = outdated
          ? ""
          : ((await artifacts?.latestVersion(PACKAGE_PLATFORM[query.clientType])) ?? "");
        const behindLatest =
          !outdated &&
          latestVersion.length > 0 &&
          compareClientVersion(query.clientVersion, latestVersion) < 0;
        return { minimumVersion, outdated, latestVersion, behindLatest };
      },
      {
        // 查询串不锁 additionalProperties：多带一个排查用的参数不该让整条提醒失效。
        query: t.Object({ clientType: clientTypeSchema, clientVersion: versionSchema }),
      }
    )
    .get(
      "/api/client/web-bundle",
      async ({ query, set }) => {
        // 资源包只服务内嵌产物的移动壳：桌面壳加载远程站点，Web 版根本没有「内嵌资源」要换。
        // 读清单本身有 30 秒服务端缓存，这里仍回 no-store，让发版后的第一次询问立刻看到新包。
        set.headers["cache-control"] = "no-store";
        if (query.clientType !== "mobile") return { available: false };
        const current = await webBundle?.current();
        if (!current) return { available: false };
        // 新资源可能调用旧壳没有的桥接能力：低于最低壳版本就不下发，先让玩家更新壳。
        if (
          current.minShellVersion &&
          compareClientVersion(query.shellVersion, current.minShellVersion) < 0
        ) {
          return { available: false, reason: "SHELL_TOO_OLD" };
        }
        if (current.build === query.build) return { available: false };
        return {
          available: true,
          build: current.build,
          version: current.version ?? "",
          url: current.url,
          sha256: current.sha256,
          sizeBytes: current.sizeBytes ?? 0,
          publishedAt: current.publishedAt ?? "",
        };
      },
      {
        query: t.Object({
          clientType: clientTypeSchema,
          shellVersion: versionSchema,
          build: t.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^(?!.*\\.\\.)(?!\\.$)[A-Za-z0-9._-]+$",
          }),
        }),
      }
    )
    .get("/api/client/packages", async ({ set }) => {
      // 下载弹窗要标的构建日期与文件大小来自制品本身（`ClientArtifacts` 发 HEAD 读回），
      // 不在前端写死一份会过期的表。这条与通道证明无关：通道没启用也照样能下载。
      set.headers["cache-control"] = "public, max-age=60";
      return { packages: (await artifacts?.list()) ?? [] };
    });
};
