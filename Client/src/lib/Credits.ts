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
  /**
   * 该包直接依赖、且确实安装在本次构建里的包名，按包名排序。
   * 依赖清单一级只展示直接依赖；二级抽屉沿这张图展开子依赖并逐级下钻。
   */
  dependencies: string[];
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
  dependencies: readonly CreditDependency[]
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
  license: string | null
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

/**
 * 依赖清单的包名索引。构建期保证依赖图里的子依赖都指向清单内的包，
 * 页面用它按名字取具体条目、展开二级抽屉。
 */
export function creditDependencyIndex(
  dependencies: readonly CreditDependency[]
): Map<string, CreditDependency> {
  return new Map(dependencies.map((dependency) => [dependency.name, dependency]));
}

/**
 * 某个包的全部间接依赖（传递闭包，不含自身），按包名排序。
 * 抽屉里用它说明「共含 N 个间接依赖」；依赖图理论上无环，仍用集合兜底防止坏数据死循环。
 */
export function collectTransitiveDependencyNames(
  index: ReadonlyMap<string, CreditDependency>,
  rootName: string
): string[] {
  const reached = new Set<string>();
  const queue = [...(index.get(rootName)?.dependencies ?? [])];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || name === rootName || reached.has(name)) continue;
    reached.add(name);
    const dependency = index.get(name);
    if (dependency) queue.push(...dependency.dependencies);
  }
  return [...reached].sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * 品牌标识键。三处共用一个键空间：依赖行与技术栈卡片、贡献模型的厂商与模型家族。
 * 渲染来源（simple-icons / FontAwesome / 自备官方 SVG / lucide 回退）只在
 * `components/credits/CreditsIcons.tsx` 维护；React 之外的包名映射也在那里。
 *
 * 厂商与模型家族分开登记：例如厂商 `google` 与模型家族 `gemini`、厂商 `anthropic` 与家族 `claude`
 * 是两枚不同的官方字形，页面上分别用在公司标题与模型徽章上。
 */
export type CreditBrandId =
  // AI 厂商
  | "deepseek"
  | "zhipu"
  | "openai"
  | "google"
  | "tencent"
  | "anthropic"
  | "alibaba"
  // AI 模型家族
  | "glm"
  | "gpt"
  | "gemini"
  | "claude"
  | "hunyuan"
  | "qwen"
  // 技术栈
  | "react"
  | "typescript"
  | "tailwindcss"
  | "radixui"
  | "framer"
  | "zustand"
  | "bun"
  | "elysia"
  | "drizzle"
  | "mysql"
  | "vite"
  | "pnpm"
  | "storybook"
  | "vitest"
  | "playwright"
  | "sentry"
  | "eslint"
  | "githubactions"
  | "github"
  // 特别鸣谢里有官方字形的来源
  | "neteasecloudmusic"
  // 依赖清单里会出现的品牌
  | "applemusic"
  | "betterauth"
  | "fontawesome"
  | "simpleicons"
  | "reactrouter"
  | "testinglibrary"
  | "lucide"
  | "zod"
  | "socketdotio"
  | "meilisearch"
  | "jsdom"
  | "orpc"
  | "fontsource"
  | "sharp"
  | "lobehub"
  | "sonar"
  | "babel"
  | "esbuild"
  | "postcss";

/** 为本项目做出过实际改动的模型。`releasedAt` ISO 日期只用于排序，不在页面上展示。 */
export interface ContributingModel {
  name: string;
  releasedAt: string;
  /** 模型家族标识（同一厂商的不同型号共用家族字形） */
  logo: CreditBrandId;
  /**
   * 发布页面：模型徽章点击后跳转的目标。优先厂商官方新闻/公告页，
   * 官方没有单独公告时退到官方文档的版本说明；确实没有公开页面时省略，徽章退化为静态标签。
   */
  url?: string;
}

/**
 * 模型按公司分组。展示序由 `sortCompaniesByLetter` 给出，数据文件的声明顺序不作依据。
 */
export interface ContributingCompany {
  company: string;
  /**
   * 拉丁转写的排序键，只给非拉丁公司名（中文按拼音逐字转写，不带分隔符）。
   * 英文公司名省略，排序直接用 `company`。
   */
  sortKey?: string;
  /** 厂商标识，展示在公司标题旁 */
  logo: CreditBrandId;
  models: ContributingModel[];
}

/**
 * 特别鸣谢条目的标识。有官方品牌字形的用 `CreditBrandId`；
 * 没有官方字形的用一枚说明来源性质的通用图标键，不回退到近似的品牌字形（见 `Credits.md` §2）。
 */
export type SpecialThanksIcon = CreditBrandId | "code" | "database" | "wiki" | "music";

/**
 * 特别鸣谢的一项：名称、一行说明与外部来源。
 * `url` 省略时渲染为静态条目，不指向未确认的占位地址。
 */
export interface SpecialThanksEntry {
  name: string;
  description: string;
  url?: string;
  icon: SpecialThanksIcon;
}

/**
 * 同一公司内按发布时间从早到晚排列。数据文件允许后加的模型直接追加在末尾，
 * 展示前统一经这里收口，排序不靠人工维护数组顺序。
 */
export function sortModelsByRelease(models: readonly ContributingModel[]): ContributingModel[] {
  return [...models].sort(
    (left, right) =>
      left.releasedAt.localeCompare(right.releasedAt) || left.name.localeCompare(right.name)
  );
}

/**
 * 公司展示序：英文公司名按字母、中文公司名按拼音，合成同一份 A-Z 序。
 *
 * 不能直接交给 `Intl.Collator` 的 zh 拼音排序：ICU 把汉字整块排在拉丁字母之前，
 * 得到的是「中文公司全在前、英文全在后」而不是交错结果。因此中文公司名在数据文件里
 * 给出拉丁转写 `sortKey`，这里只比转写；英文公司名不写 `sortKey`，直接用公司名。
 * 新增中文公司时必须补转写，否则它会按汉字码位排到英文之后。
 */
const companyCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function sortCompaniesByLetter(
  companies: readonly ContributingCompany[]
): ContributingCompany[] {
  return [...companies].sort((left, right) =>
    companyCollator.compare(left.sortKey ?? left.company, right.sortKey ?? right.company)
  );
}

/** 核心技术栈的分组。顺序即页面从上到下的展示顺序，标签由 `data/CreditsContent.ts` 给出。 */
export type TechStackCategory = "frontend" | "backend" | "scaffold" | "operations";

/** 核心技术栈的一格。`icon` 是品牌图标键，映射关系与回退在 `components/credits/CreditsIcons.tsx`。 */
export interface CoreTechEntry {
  /** 技术栈名称 */
  name: string;
  /** 项目里的职责，一句话说明它承担什么 */
  role: string;
  icon: CreditBrandId;
  /** 所属分组 */
  category: TechStackCategory;
  /** 官方站点 */
  url: string;
  /** 对应 npm 包名；用于从依赖清单里取实际安装版本，非 npm 运行时省略 */
  packageName?: string;
}
