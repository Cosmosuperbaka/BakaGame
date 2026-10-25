/**
 * 开源致谢页的静态内容：参与本项目开发的大模型，以及按前端 / 后端 / 脚手架 / 运维与开发辅助
 * 四组展示的核心技术栈。
 *
 * 模型署名规则（维护时先读 `Client/docs/Credits.md`）：
 *   - 只有实际改动了仓库文件（代码、数据、文档、样式、配置）的模型才署名；
 *     仅参与讨论、咨询、评审或规划的不算。
 *   - 完成改动后，在文件末尾按「公司 → 发布时间」补上自己的名字与 `releasedAt`；
 *     已有公司里新增模型直接追加，页面展示前由 `sortModelsByRelease` 统一按时间排序。
 *   - 公司展示序由 `sortCompaniesByLetter` 收口：英文公司在先并按字母，中文公司在后并按
 *     `sortKey` 的拼音排序。本文件的声明顺序不作依据，新增公司直接追加到末尾即可；
 *     中文公司名必须补 `sortKey`，否则只能按汉字码位排在拼音条目之后。
 *
 * `releasedAt` 只用于排序，页面上不展示；日期用 ISO `YYYY-MM-DD`。
 * 每个模型尽量带 `url` 发布页：优先厂商官方新闻/公告，其次官方文档的版本说明；确实没有公开页面时省略。
 * 公司徽章用厂商标识，模型徽章用模型家族标识；两枚相同的（如 GPT 与 OpenAI）可以重复用同一个键。
 */
import type {
  ContributingCompany,
  CoreTechEntry,
  SpecialThanksEntry,
  TechStackCategory,
} from "@/lib/Credits";

/** 核心技术栈分组顺序与标题：数组顺序即页面从上到下的顺序。 */
export const TECH_STACK_CATEGORIES: readonly { id: TechStackCategory; label: string }[] = [
  { id: "frontend", label: "前端" },
  { id: "backend", label: "后端" },
  { id: "scaffold", label: "脚手架" },
  { id: "operations", label: "运维与开发辅助" },
];

/** 分组标题写公司或 AI 团队名（深度求索 / 智谱清言 / OpenAI / Google DeepMind / 腾讯混元 / Anthropic / 阿里千问），模型徽章才写具体型号。 */
export const CONTRIBUTING_MODELS: readonly ContributingCompany[] = [
  {
    company: "深度求索",
    sortKey: "shenduqiusuo",
    logo: "deepseek",
    models: [
      // 预览版先于正式快照发布，按发布时间排在快照之前；Pro / Flash 同属 V4 预览版公告。
      {
        name: "Deepseek V4 Flash Preview",
        releasedAt: "2026-04-24",
        logo: "deepseek",
        url: "https://www.deepseek.com/news/v4-preview/",
      },
      {
        name: "Deepseek V4 Pro Preview",
        releasedAt: "2026-04-24",
        logo: "deepseek",
        url: "https://www.deepseek.com/news/v4-preview/",
      },
      {
        // 0731 没有单独新闻页：官方「新闻」栏目从 2026-04-24 直接跳到 2026-08-13，
        // 唯一公开记录是更新日志里 2026-07-31 那一条。必须深链到该小节，只给日志首页
        // 会停在首屏的 V4.1 Flash 1017，看着就像链到了别的版本。
        name: "Deepseek V4 Flash 0731",
        releasedAt: "2026-07-31",
        logo: "deepseek",
        url: "https://api-docs.deepseek.com/zh-cn/updates#deepseek-v4-flash-更新",
      },
      {
        name: "Deepseek V4.1 Flash",
        releasedAt: "2026-09-10",
        logo: "deepseek",
        url: "https://www.deepseek.com/news/deepseek-v4-1-flash/",
      },
      {
        name: "Deepseek V4.1 Flash 1017",
        releasedAt: "2026-10-17",
        logo: "deepseek",
        url: "https://api-docs.deepseek.com/zh-cn/news/news261017",
      },
    ],
  },
  {
    company: "智谱清言",
    sortKey: "zhipuqingyan",
    logo: "zhipu",
    models: [
      {
        name: "GLM 5.3",
        releasedAt: "2026-08-19",
        logo: "glm",
        url: "https://www.zhipuai.cn/zh/research/162",
      },
      {
        name: "GLM 5.3 Flash",
        releasedAt: "2026-08-26",
        logo: "glm",
        url: "https://www.zhipuai.cn/zh/news/163",
      },
    ],
  },
  {
    company: "OpenAI",
    logo: "openai",
    models: [
      {
        name: "GPT 5.4",
        releasedAt: "2026-03-05",
        logo: "gpt",
        url: "https://openai.com/index/introducing-gpt-5-4/",
      },
      {
        name: "GPT 5.5",
        releasedAt: "2026-04-23",
        logo: "gpt",
        url: "https://openai.com/index/introducing-gpt-5-5/",
      },
      {
        name: "GPT 5.6 Sol",
        releasedAt: "2026-07-09",
        logo: "gpt",
        url: "https://openai.com/index/gpt-5-6/",
      },
      {
        name: "GPT 6 Astra",
        releasedAt: "2026-09-04",
        logo: "gpt",
        url: "https://openai.com/index/gpt-6-astra/",
      },
      {
        name: "GPT 6 Sol",
        releasedAt: "2026-09-22",
        logo: "gpt",
        url: "https://openai.com/index/introducing-gpt-6-sol-and-luna/",
      },
      {
        name: "GPT 6.1 Sol",
        releasedAt: "2026-09-29",
        logo: "gpt",
        url: "https://openai.com/index/introducing-gpt-6-1-sol/",
      },
    ],
  },
  {
    company: "Google DeepMind",
    logo: "google",
    models: [
      {
        name: "Gemini 3 Pro Preview",
        releasedAt: "2025-11-18",
        logo: "gemini",
        url: "https://blog.google/products-and-platforms/products/gemini/gemini-3/",
      },
      {
        name: "Gemini 3.1 Pro Preview",
        releasedAt: "2026-02-19",
        logo: "gemini",
        url: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/",
      },
      {
        name: "Gemini 3.5 Flash",
        releasedAt: "2026-05-19",
        logo: "gemini",
        url: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/",
      },
      {
        name: "Gemini 3.6 Flash",
        releasedAt: "2026-07-21",
        logo: "gemini",
        url: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/",
      },
      {
        name: "Gemini 3.7 Flash",
        releasedAt: "2026-08-13",
        logo: "gemini",
        url: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-3-7-flash/",
      },
      {
        name: "Gemini 3.8 Flash",
        releasedAt: "2026-09-02",
        logo: "gemini",
        url: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/",
      },
    ],
  },
  {
    company: "腾讯混元",
    sortKey: "tengxunhunyuan",
    logo: "tencent",
    models: [
      {
        name: "Hy 4 Preview",
        releasedAt: "2026-08-28",
        logo: "hunyuan",
        url: "https://hunyuan.tencent.com/research/hy4-preview",
      },
    ],
  },
  {
    company: "Anthropic",
    logo: "anthropic",
    models: [
      {
        name: "Claude Opus 4.6",
        releasedAt: "2026-02-05",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-opus-4-6",
      },
      {
        name: "Claude Sonnet 4.6",
        releasedAt: "2026-02-17",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-sonnet-4-6",
      },
      {
        name: "Claude Opus 4.7",
        releasedAt: "2026-04-16",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-opus-4-7",
      },
      {
        name: "Claude Opus 4.8",
        releasedAt: "2026-05-28",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-opus-4-8",
      },
      {
        name: "Claude Sonnet 5",
        releasedAt: "2026-06-30",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-sonnet-5",
      },
      {
        name: "Claude Opus 5",
        releasedAt: "2026-07-24",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-opus-5",
      },
      {
        name: "Claude Opus 5.5",
        releasedAt: "2026-08-31",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-opus-5-5",
      },
      {
        name: "Claude Sonnet 5.5",
        releasedAt: "2026-09-27",
        logo: "claude",
        url: "https://www.anthropic.com/news/claude-sonnet-5-5",
      },
    ],
  },
  {
    company: "阿里千问",
    sortKey: "aliqianwen",
    logo: "alibaba",
    models: [
      {
        name: "Qwen 3.8 Flash",
        releasedAt: "2026-08-26",
        logo: "qwen",
        url: "https://qwen.ai/blog?id=qwen3.8-flash-next",
      },
      {
        name: "Qwen 3.8 Max 0902",
        releasedAt: "2026-09-02",
        logo: "qwen",
        url: "https://qwen.ai/blog?id=qwen3.8",
      },
    ],
  },
];

/**
 * 特别鸣谢：玩法原型、资料与曲库来源，数组顺序即页面展示顺序。
 * `icon` 有官方品牌字形就用品牌键，没有就用一枚说明来源性质的通用图标，不用近似品牌顶替。
 */
export const SPECIAL_THANKS: readonly SpecialThanksEntry[] = [
  {
    name: "anime-character-guessr",
    description: "本作的玩法原型与规则来源，作者 Kenny Li。",
    url: "https://github.com/kennylimz/anime-character-guessr",
    icon: "cee",
  },
  {
    name: "Bangumi 番组计划",
    description: "番剧、角色与歌曲资料。",
    url: "https://bgm.tv/",
    icon: "bangumi",
  },
  {
    name: "萌娘百科",
    description: "角色与作品背景资料。",
    url: "https://zh.moegirl.org.cn/",
    icon: "moegirl",
  },
  {
    name: "QQ音乐",
    description: "歌曲检索与试听来源。",
    url: "https://y.qq.com/",
    icon: "qqmusic",
  },
  {
    name: "网易云音乐",
    description: "歌曲检索与试听来源。",
    url: "https://music.163.com/",
    icon: "neteasecloudmusic",
  },
];

/**
 * 核心技术栈：按四组展示，按项目里的实际职责写，不写宣传语。
 * `packageName` 用于从依赖清单里取实际安装版本；运行时/服务端工具不在 Client 依赖里时省略。
 */
export const CORE_TECH_STACK: readonly CoreTechEntry[] = [
  // 前端
  {
    name: "React",
    role: "界面与组件树",
    icon: "react",
    category: "frontend",
    url: "https://react.dev",
    packageName: "react",
  },
  {
    name: "TypeScript",
    // 展示编译器线 7.x。6.x 只是 typescript-eslint 等工具消费的 API 线，跑构建的
    // `tsc` 来自 `typescript7` 别名；依赖清单里还会出现 6.x 的传递副本，版本查找必须
    // 直接依赖优先（见 CreditsTechStack），否则卡片会显示成 6.0.3。
    role: "全仓编译与类型契约",
    icon: "typescript",
    category: "frontend",
    url: "https://www.typescriptlang.org",
    packageName: "typescript",
  },
  {
    name: "Tailwind CSS",
    role: "语义令牌与样式基线",
    icon: "tailwindcss",
    category: "frontend",
    url: "https://tailwindcss.com",
    packageName: "tailwindcss",
  },
  {
    name: "Radix UI",
    role: "可访问的控件原语",
    icon: "radixui",
    category: "frontend",
    url: "https://www.radix-ui.com",
  },
  {
    name: "Framer Motion",
    role: "交互动效编排",
    icon: "framer",
    category: "frontend",
    url: "https://motion.dev",
    packageName: "framer-motion",
  },
  {
    name: "Zustand",
    role: "客户端状态容器",
    icon: "zustand",
    category: "frontend",
    url: "https://zustand.docs.pmnd.rs",
    packageName: "zustand",
  },
  {
    name: "React Router",
    role: "页面路由与导航",
    icon: "reactrouter",
    category: "frontend",
    url: "https://reactrouter.com",
    packageName: "react-router-dom",
  },
  // 后端
  {
    name: "Bun",
    role: "服务端运行时",
    icon: "bun",
    category: "backend",
    url: "https://bun.sh",
  },
  {
    name: "Elysia",
    role: "HTTP 与 WebSocket 服务",
    icon: "elysia",
    category: "backend",
    url: "https://elysiajs.com",
  },
  {
    name: "oRPC",
    role: "前后端类型安全契约",
    icon: "orpc",
    category: "backend",
    url: "https://orpc.dev",
    packageName: "@orpc/client",
  },
  {
    name: "Drizzle ORM",
    role: "数据库访问与迁移",
    icon: "drizzle",
    category: "backend",
    url: "https://orm.drizzle.team",
  },
  {
    name: "MySQL",
    role: "账号与对局数据",
    icon: "mysql",
    category: "backend",
    url: "https://www.mysql.com",
  },
  {
    name: "Better Auth",
    role: "账号、会话与通行密钥",
    icon: "betterauth",
    category: "backend",
    url: "https://www.better-auth.com",
  },
  {
    name: "Meilisearch",
    role: "番剧与角色检索索引",
    icon: "meilisearch",
    category: "backend",
    url: "https://www.meilisearch.com",
  },
  // 脚手架
  {
    name: "Vite",
    role: "构建与按路由分块",
    icon: "vite",
    category: "scaffold",
    url: "https://vite.dev",
    packageName: "vite",
  },
  {
    name: "pnpm",
    role: "工作区依赖管理",
    icon: "pnpm",
    category: "scaffold",
    url: "https://pnpm.io",
  },
  {
    name: "Storybook",
    role: "组件工作台与截图",
    icon: "storybook",
    category: "scaffold",
    url: "https://storybook.js.org",
    packageName: "storybook",
  },
  {
    name: "Vitest",
    role: "单元与集成测试",
    icon: "vitest",
    category: "scaffold",
    url: "https://vitest.dev",
    packageName: "vitest",
  },
  {
    name: "Playwright",
    role: "端到端与歌词回归",
    icon: "playwright",
    category: "scaffold",
    url: "https://playwright.dev",
    packageName: "@playwright/test",
  },
  // 运维与开发辅助
  {
    name: "Sentry",
    role: "异常追踪与性能观测",
    icon: "sentry",
    category: "operations",
    url: "https://sentry.io",
    packageName: "@sentry/react",
  },
  {
    name: "ESLint",
    role: "静态检查",
    icon: "eslint",
    category: "operations",
    url: "https://eslint.org",
    packageName: "eslint",
  },
  {
    name: "GitHub Actions",
    role: "CI 与部署门禁",
    icon: "githubactions",
    category: "operations",
    url: "https://github.com/features/actions",
  },
];
