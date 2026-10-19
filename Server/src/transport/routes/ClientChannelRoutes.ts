import { Elysia, t } from "elysia";
import { AppError } from "../../domain/Errors";
import type { ClientArtifacts } from "../../infrastructure/ClientArtifacts";
import type { ClientChannel } from "../../infrastructure/ClientChannel";
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
  artifacts?: ClientArtifacts
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
      ({ query, set }) => {
        // 比对只用服务端这一份 compareClientVersion：前端再实现一遍，两端对「够不够新」
        // 的判断迟早各自漂移。这里读回的最低版本也只用于提醒，拦人仍在 requireAdmission。
        set.headers["cache-control"] = "no-store";
        const channel = require();
        return {
          minimumVersion: channel.minimumVersionFor(query.clientType),
          outdated: channel.isOutdated(query.clientType, query.clientVersion),
        };
      },
      {
        // 查询串不锁 additionalProperties：多带一个排查用的参数不该让整条提醒失效。
        query: t.Object({ clientType: clientTypeSchema, clientVersion: versionSchema }),
      }
    )
    .get("/api/client/packages", async ({ set }) => {
      // 下载弹窗要标的构建日期与文件大小来自制品本身（`ClientArtifacts` 发 HEAD 读回），
      // 不在前端写死一份会过期的表。这条与通道证明无关：通道没启用也照样能下载。
      set.headers["cache-control"] = "public, max-age=60";
      return { packages: (await artifacts?.list()) ?? [] };
    });
};
