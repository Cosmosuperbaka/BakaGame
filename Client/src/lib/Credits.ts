/**
 * 开源致谢页的数据契约与纯函数。
 *
 * 依赖清单在构建期由 vite 插件扫描 Client 的依赖闭包生成（`virtual:credits`），
 * 许可证原文按包名首字符分桶懒加载（`virtual:credits-licenses-*`）：列表只带元数据，
 * 打开侧边抽屉时才取当前包所在的那一桶，不把整份法律原文塞进页面。
 *
 * 本模块必须保持零依赖、不碰浏览器与 Node API：`vite.config.ts` 在构建期直接引用
 * 这里的契约与分桶函数，页面、测试与 Storybook 引用同一份类型。
 */

/** 依赖在依赖图中的来源。传递依赖沿依赖链归到它实际被哪一种直接依赖引入。 */
export type CreditScope = "runtime" | "development";

/** 依赖清单的一行。字段名即 `virtual:credits` 的契约，改动要同步 `src/vite-env.d.ts`。 */
export interface CreditDependency {
  /** npm 包名 */
  name: string;
  version: string;
  /** 许可证标识（保留包的原始 SPDX 表达式）；未声明为 `UNKNOWN_LICENSE`。 */
  license: string;
  /** 包简介，已裁剪空白与长度；没有时为 ""。 */
  description: string;
  /** 主页或仓库地址；都取不到时为空串。 */
  url: string;
  /** 是否为 Client/package.json 的直接依赖。 */
  direct: boolean;
  scope: CreditScope;
}

/** 虚拟模块 `virtual:credits` 的完整形状。 */
export interface CreditsManifest {
  generatedAt: string;
  dependencies: CreditDependency[];
}

/** 一个包自带的一份许可证类文件（LICENSE / LICENCE / COPYING / NOTICE 等）。 */
export interface CreditLicenseFile {
  /** 物理文件名，如 `LICENSE`、`NOTICE`。 */
  name: string;
  /** 原文，保持文件里的原始换行与空白。 */
  text: string;
}

/** 一个包的全部许可证原文；包里没有任何许可证类文件时 `files` 为空数组。 */
export interface CreditLicenseDocument {
  files: CreditLicenseFile[];
}

/** 一个分桶的产物：包名 → 许可证原文。 */
export type CreditLicenseBucket = Record<string, CreditLicenseDocument>;

/** `virtual:credits-licenses` 的产物：分桶键 → 该桶的懒加载函数。 */
export type CreditLicenseLoaders = Record<string, () => Promise<CreditLicenseBucket>>;

/** 包没有声明许可证时的占位值；展示层经 `creditLicenseLabel` 读成「未知」。 */
export const UNKNOWN_LICENSE = "UNKNOWN";

/** 包简介的最大展示长度。构建期按它裁剪，避免依赖清单元数据膨胀。 */
export const CREDIT_DESCRIPTION_LIMIT = 160;

/** 许可证类文件名：`LICENSE` / `LICENCE` / `COPYING` / `NOTICE` 开头的文件都算。 */
export const LICENSE_FILE_PATTERN = /^(LICEN[SC]E|COPYING|NOTICE)/i;

/**
 * 许可证原文的分桶键：取包名首字母。scoped 包跳过 `@` 取 scope 的首字母，
 * 于是 `@radix-ui/*` 与 `lodash` 各自落进 `r` / `l` 桶，打开一个包只下载一桶。
 * 首字符不是字母或数字时（理论上不存在）统一落进 `#`。
 */
export function licenseBucket(packageName: string): string {
  const first = packageName.replace(/^@/, "").charAt(0).toLowerCase();
  return /^[a-z0-9]$/.test(first) ? first : "#";
}

/** 许可证的展示文案。SPDX 表达式原样展示，只有未声明时读成「未知」。 */
export function creditLicenseLabel(license: string): string {
  return license === UNKNOWN_LICENSE ? "未知" : license;
}

export interface CreditLicenseOption {
  license: string;
  count: number;
}

/**
 * License 筛选项：按包数从多到少排列，同数时按标识升序；「未知」固定排最后，
 * 免得一个未声明的包把常见许可证挤走。调用处用 `null` 表示「全部 License」。
 */
export function creditLicenseOptions(
  dependencies: readonly CreditDependency[],
): CreditLicenseOption[] {
  const counts = new Map<string, number>();
  for (const dependency of dependencies) {
    counts.set(dependency.license, (counts.get(dependency.license) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([license, count]) => ({ license, count }))
    .sort((left, right) => {
      if (left.license === UNKNOWN_LICENSE) return 1;
      if (right.license === UNKNOWN_LICENSE) return -1;
      if (left.count !== right.count) return right.count - left.count;
      return left.license.localeCompare(right.license);
    });
}

/**
 * 依赖列表的筛选：关键词匹配包名、版本与许可证标识（不区分大小写，空串等于不过滤），
 * `license` 为 `null` 时不过滤许可证。输入顺序由构建期保证按包名排序，这里不再重排。
 */
export function filterCreditDependencies(
  dependencies: readonly CreditDependency[],
  query: string,
  license: string | null,
): CreditDependency[] {
  const keyword = query.trim().toLowerCase();
  return dependencies.filter((dependency) => {
    if (license !== null && dependency.license !== license) return false;
    if (!keyword) return true;
    return (
      dependency.name.toLowerCase().includes(keyword) ||
      dependency.version.toLowerCase().includes(keyword) ||
      dependency.license.toLowerCase().includes(keyword)
    );
  });
}

/** 为本项目做出过实际改动的模型。`releasedAt` ISO 日期只用于排序，不在页面上展示。 */
export interface ContributingModel {
  name: string;
  releasedAt: string;
}

/** 模型按公司分组。公司顺序取数据文件的声明顺序，新增公司追加到末尾。 */
export interface ContributingCompany {
  company: string;
  models: ContributingModel[];
}

/**
 * 同一公司内按发布时间从早到晚排列。数据文件允许后加的模型直接追加在末尾，
 * 展示前统一经这里收口，排序不靠人工维护数组顺序。
 */
export function sortModelsByRelease(models: readonly ContributingModel[]): ContributingModel[] {
  return [...models].sort(
    (left, right) => left.releasedAt.localeCompare(right.releasedAt) || left.name.localeCompare(right.name),
  );
}

/** 核心技术栈的一格。`icon` 是品牌图标的语义键，映射关系与回退在 `components/credits/CreditsIcons.tsx`。 */
export type TechStackIcon =
  | "react"
  | "typescript"
  | "vite"
  | "tailwindcss"
  | "framer"
  | "radixui"
  | "zustand"
  | "bun"
  | "elysia"
  | "drizzle"
  | "pnpm"
  | "sentry";

export interface CoreTechEntry {
  /** 技术栈名称 */
  name: string;
  /** 项目里的职责，一句话说明它承担什么 */
  role: string;
  icon: TechStackIcon;
  /** 官方站点 */
  url: string;
  /** 对应 npm 包名；用于从依赖清单里取实际安装版本，非 npm 运行时省略 */
  packageName?: string;
}
