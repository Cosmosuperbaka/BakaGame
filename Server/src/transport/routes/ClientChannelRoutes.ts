import { Elysia, t } from "elysia";
import { AppError } from "../../domain/Errors";
import type {
  ClientArtifacts,
  ClientPackagePlatform,
  UpdaterPlatform,
} from "../../infrastructure/ClientArtifacts";
import type { ClientChannel } from "../../infrastructure/ClientChannel";
import {
  CLIENT_ATTESTATION_CHAIN_MAX,
  CLIENT_CHANNEL_PATHS,
  CLIENT_CHANNEL_PATH_PREFIX,
  CLIENT_SELF_CHECK_ID_MAX_LENGTH,
  DESKTOP_MACOS_MINIMUM_SYSTEM_VERSION,
} from "../../infrastructure/ClientChannelContract";
import { parseClientUserAgent } from "../../shared/ClientUserAgent";
import { compareDottedVersion } from "../../shared/ModelValues";
import type { ClientWebBundle } from "../../infrastructure/ClientWebBundle";
import { ThreeTierRateLimiter } from "../../infrastructure/RateLimiter";
import { resolveClientIp } from "../ClientIp";
import { requestContext } from "../RequestContext";
import { httpError, rateLimitHeaders, traceIdOf } from "../HttpErrorEnvelope";

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
    hardFail: t.Array(t.String({ maxLength: CLIENT_SELF_CHECK_ID_MAX_LENGTH })),
    softFail: t.Array(t.String({ maxLength: CLIENT_SELF_CHECK_ID_MAX_LENGTH })),
    keyProtection: t.Optional(t.Union([t.Literal("hardware"), t.Literal("software")])),
    attestationLevel: t.Optional(
      t.Union([t.Literal("trusted"), t.Literal("degraded"), t.Literal("rejected")])
    ),
  },
  { additionalProperties: false }
);
const clientTypeSchema = t.Union([t.Literal("desktop"), t.Literal("mobile")]);
/**
 * 壳类型 + 壳自报平台 → 安装包平台：制品清单按平台索引，更新检查按壳提问。
 * 桌面壳按自报的 `platform` 分 Windows 与 macOS；没带（旧页面）或认不出的一律按 Windows，
 * 与加入 macOS 之前的口径相同。
 */
const packagePlatformOf = (
  clientType: "desktop" | "mobile",
  platform: string | undefined
): ClientPackagePlatform => {
  if (clientType === "mobile") return "android";
  return platform === "macos" ? "macos" : "windows";
};
/**
 * Tauri 更新器的平台段 + 架构段 → 自动更新包平台。Windows 只出 x64；macOS 出通用包，
 * 两种芯片都给同一个包。其余组合（ARM 版 Windows、Linux 等）没有发布，回 204。
 */
const updaterPlatformOf = (target: string, arch: string): UpdaterPlatform | undefined => {
  if (target === "windows" && arch === "x86_64") return "windows";
  if (target === "darwin" && (arch === "aarch64" || arch === "x86_64")) return "macos";
  return undefined;
};
/**
 * 这台 Mac 的系统够不够新安装包的最低版本：取壳请求头里客户端段报的系统版本；
 * 读不出（不是 Mac 壳、旧壳不带客户端段、版本不是点分数字）返回 undefined，由调用方决定从严还是从宽。
 */
const macSystemMeetsMinimum = (userAgent: string | null | undefined): boolean | undefined => {
  const ua = parseClientUserAgent(userAgent);
  if (ua?.osName !== "macOS" || !/^\d+(\.\d+)*$/.test(ua.osVersion)) return undefined;
  return compareDottedVersion(ua.osVersion, DESKTOP_MACOS_MINIMUM_SYSTEM_VERSION) >= 0;
};
/**
 * 壳上报版本号的唯一口径：壳把项目文件里的 version 原样送来，这里放宽或收紧都会让
 * 发布流程与接口对不上，所以版本一致性测试也引用这一份，不另写一个正则。
 */
export const CLIENT_VERSION_PATTERN = "^\\d+(\\.\\d+){0,3}$";
const versionSchema = t.String({
  minLength: 1,
  maxLength: 32,
  pattern: CLIENT_VERSION_PATTERN,
});
const clientIdSchema = t.String({ minLength: 8, maxLength: 64 });
/** 厂商链一般 3—5 张，留到 8 张；单张 PEM 上限按 EC P-384 根的量级给。 */
const attestationSchema = t.Object(
  {
    attestationChallenge: t.String({ minLength: 8, maxLength: 512 }),
    chain: t.Array(t.String({ minLength: 64, maxLength: 8192 }), {
      minItems: 1,
      maxItems: CLIENT_ATTESTATION_CHAIN_MAX,
    }),
  },
  { additionalProperties: false }
);

/**
 * 注册、领挑战、交签名三个写入口的共享额度（按来源地址三层分桶，口径同账号与打点）。
 *
 * 三者都匿名可达：不设额度时，注册会把任意伪造的设备公钥逐条写进设备表，领挑战会
 * 把有界的待验挑战表刷满、挤掉正在验证中的真实设备。正常壳一次进房只走挑战 + 签名
 * 两步、注册只在首次安装；但聚会、校园网这类场景一屋子人共用一个出口地址，单来源额度
 * 要按「十几个人同时进房再各重试一次」来留，不能按单台设备算。peer 与全局桶按整站流量
 * 放宽，只封顶伪造来源标头自造新桶的路径。
 */
const CLIENT_CHANNEL_WINDOW_MS = 60_000;
const CLIENT_CHANNEL_IP_MAX_REQUESTS = 120;
const CLIENT_CHANNEL_PEER_MAX_REQUESTS = 3_000;
const CLIENT_CHANNEL_GLOBAL_MAX_REQUESTS = 6_000;

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
  const limiter = new ThreeTierRateLimiter({
    windowMs: CLIENT_CHANNEL_WINDOW_MS,
    ipMaxRequests: CLIENT_CHANNEL_IP_MAX_REQUESTS,
    peerMaxRequests: CLIENT_CHANNEL_PEER_MAX_REQUESTS,
    globalMaxRequests: CLIENT_CHANNEL_GLOBAL_MAX_REQUESTS,
  });
  // 限流挂在请求入口、先于 body 校验：挂在 beforeHandle 上，校验失败的请求就不计额度，
  // 非法请求体成了不限速的探测通道。
  return new Elysia({ name: "client-channel", normalize: false })
    .use(requestContext)
    .onRequest(({ request, server, set }) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.startsWith(CLIENT_CHANNEL_PATH_PREFIX)
      )
        return;
      const peerIp = server?.requestIP(request)?.address ?? "unknown";
      const verdict = limiter.consume(resolveClientIp(request.headers, peerIp), peerIp);
      if (verdict.allowed) return;
      return new Response(
        JSON.stringify(
          httpError("RATE_LIMITED", "客户端通道请求过于频繁，请稍后重试", traceIdOf(set.headers))
        ),
        {
          status: 429,
          headers: { "content-type": "application/json", ...rateLimitHeaders(verdict) },
        }
      );
    })
    .post(
      CLIENT_CHANNEL_PATHS.register,
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
      CLIENT_CHANNEL_PATHS.challenge,
      ({ body }) => {
        return require().issue(body.clientId);
      },
      { body: t.Object({ clientId: clientIdSchema }, { additionalProperties: false }) }
    )
    .post(
      CLIENT_CHANNEL_PATHS.attest,
      async ({ body, clientIp }) => {
        // 票绑定签发时的来源网段：抓到的票转到另一张网络上用不掉。
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
      CLIENT_CHANNEL_PATHS.updateCheck,
      async ({ query, request, set }) => {
        // 比对只用服务端这一份 compareDottedVersion：前端再实现一遍，两端对「够不够新」
        // 的判断迟早各自漂移。这里读回的最低版本也只用于提醒，拦人仍在 requireAdmission。
        set.headers["cache-control"] = "no-store";
        const channel = require();
        const minimumVersion = channel.minimumVersionFor(query.clientType);
        const outdated = channel.isOutdated(query.clientType, query.clientVersion);
        // 软提醒的第二个依据：已发布的最新壳版本。它回答「有没有新版可拿」，
        // 与「够不够格进反作弊房」是两件事——发新版不等于协议破坏性变更，不能自动抬硬门槛。
        // 已经低于硬门槛时不必再问制品：硬提醒优先，也别让一次 CDN 探测拖慢「进不了房」这句提示。
        const packagePlatform = packagePlatformOf(query.clientType, query.platform);
        const latestVersion = outdated
          ? ""
          : ((await artifacts?.latestVersion(packagePlatform)) ?? "");
        // 系统低于新包最低要求的 Mac 不再催更新：下载下来的新包在这台机器上打不开。
        // 读不出系统版本时照旧提醒，提醒本身不会弄坏任何东西。
        const systemTooOld =
          packagePlatform === "macos" &&
          macSystemMeetsMinimum(request.headers.get("user-agent")) === false;
        const behindLatest =
          !outdated &&
          !systemTooOld &&
          latestVersion.length > 0 &&
          compareDottedVersion(query.clientVersion, latestVersion) < 0;
        return { minimumVersion, outdated, latestVersion, behindLatest };
      },
      {
        // 查询串不锁 additionalProperties：多带一个排查用的参数不该让整条提醒失效。
        // `platform` 是壳自报的平台（与注册时同一个值），只用来挑「最新已发布版」该看哪个平台的包。
        query: t.Object({
          clientType: clientTypeSchema,
          clientVersion: versionSchema,
          platform: t.Optional(t.String({ maxLength: 32 })),
        }),
      }
    )
    .get(
      CLIENT_CHANNEL_PATHS.webBundle,
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
          compareDottedVersion(query.shellVersion, current.minShellVersion) < 0
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
    .get(
      CLIENT_CHANNEL_PATHS.desktopUpdate,
      async ({ params, request, set }) => {
        // Tauri 更新器的动态清单：有新版回 200 + 版本、地址、签名，没有就回 204。
        // 地址指向对象存储/CDN，安装包字节不经过源站；签名由壳用编进二进制的公钥校验，
        // 这里只是把发布流水线写下的 .sig 原样转交，服务端被篡改也换不来能装上的包。
        // 与 update-check 不同，这里不涉及准入门槛，可以短时缓存。
        const platform = updaterPlatformOf(params.target, params.arch);
        // macOS 的答复取决于请求头里的系统版本，只许端上缓存，免得共享缓存把一台机器的答复给了另一台
        const cacheControl = platform === "macos" ? "private, max-age=60" : "public, max-age=60";
        const headers: Record<string, string> = { "cache-control": cacheControl };
        if (platform === "macos") headers.vary = "User-Agent";
        Object.assign(set.headers, headers);
        // 更新器装完就重启，新包打不开时玩家手上就只剩一个起不来的壳，所以这里从严：
        // 系统版本读不出（不带客户端段的旧壳）也不给，留给页面提醒引导手动下载。
        const systemBlocked =
          platform === "macos" && macSystemMeetsMinimum(request.headers.get("user-agent")) !== true;
        const release =
          platform && !systemBlocked ? await artifacts?.updaterRelease(platform) : undefined;
        if (!release || compareDottedVersion(params.currentVersion, release.version) >= 0) {
          return new Response(null, { status: 204, headers });
        }
        return {
          version: release.version,
          notes: "",
          ...(release.pubDate ? { pub_date: release.pubDate } : {}),
          url: release.url,
          signature: release.signature,
        };
      },
      {
        params: t.Object({
          target: t.String({ minLength: 1, maxLength: 16 }),
          arch: t.String({ minLength: 1, maxLength: 16 }),
          currentVersion: versionSchema,
        }),
      }
    )
    .get(CLIENT_CHANNEL_PATHS.packages, async ({ set }) => {
      // 下载弹窗要标的构建日期与文件大小来自制品本身（`ClientArtifacts` 发 HEAD 读回），
      // 不在前端写死一份会过期的表。这条与通道证明无关：通道没启用也照样能下载。
      set.headers["cache-control"] = "public, max-age=60";
      return { packages: (await artifacts?.list()) ?? [] };
    });
};
