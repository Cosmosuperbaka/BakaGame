/**
 * 站点模式开关：每个能单独暂停的玩法一项，由后台运行期旋钮控制，经 `GET /api/site/config` 下发。
 *
 * 关掉一个模式时，首页入口留在原位、置灰并标注「暂时关闭」，服务端拒绝在该模式新开房间；
 * 已经开着的房间、凭链接加入已有房间和正在进行的对局都不受影响，正在玩的人能把这局打完。
 * 排位只停入口：上线前的灰度需要直连 `/cee/ranked` 仍然可用。
 */
export const SITE_FEATURE_KEYS = [
  "fakerEntry",
  "songSoloEntry",
  "songMultiplayerEntry",
  "ceeMultiplayerEntry",
  "ceeRankedEntry",
] as const;

export type SiteFeatureKey = (typeof SITE_FEATURE_KEYS)[number];

export type SiteFeatures = Record<SiteFeatureKey, boolean>;

/** 缺省全开：服务端没装配开关、客户端读不到配置时都按这个口径。 */
export const OPEN_SITE_FEATURES: SiteFeatures = {
  fakerEntry: true,
  songSoloEntry: true,
  songMultiplayerEntry: true,
  ceeMultiplayerEntry: true,
  ceeRankedEntry: true,
};

/** 拒绝新开房间时提示里的模式名。 */
export const SITE_FEATURE_LABELS: Record<SiteFeatureKey, string> = {
  fakerEntry: "谁是卧底",
  songSoloEntry: "听歌猜歌单人模式",
  songMultiplayerEntry: "听歌猜歌多人模式",
  ceeMultiplayerEntry: "猜动漫角色多人模式",
  ceeRankedEntry: "CEE 排位赛",
};

/**
 * 解析服务端回包：只有明确的 `false` 才算关。
 * 少字段、类型不对都按开放处理，避免把「服务端没说清」读成「关掉」，
 * 也让旧服务端（只回 `ceeRankedEntry`）下的新页面照常显示其余入口。
 */
export const parseSiteFeatures = (body: unknown): SiteFeatures => {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const features = { ...OPEN_SITE_FEATURES };
  for (const key of SITE_FEATURE_KEYS) features[key] = record[key] !== false;
  return features;
};
