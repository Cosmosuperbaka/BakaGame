/**
 * 开源致谢页的静态内容：参与本项目开发的大模型，以及按前端 / 后端 / 脚手架 / 运维与开发辅助
 * 四组展示的核心技术栈。
 *
 * 模型署名规则（维护时先读 `Agents/Credits.md`）：
 *   - 只有实际改动了仓库文件（代码、数据、文档、样式、配置）的模型才署名；
 *     仅参与讨论、咨询、评审或规划的不算。
 *   - 完成改动后，在文件末尾按「公司 → 发布时间」补上自己的名字与 `releasedAt`；
 *     已有公司里新增模型直接追加，页面展示前由 `sortModelsByRelease` 统一按时间排序。
 *   - 公司顺序取本文件的声明顺序；第一次出现的公司追加到末尾，不插队重排。
 *
 * `releasedAt` 只用于排序，页面上不展示；日期用 ISO `YYYY-MM-DD`。
 * 公司徽章用厂商标识，模型徽章用模型家族标识；两枚相同的（如 GPT 与 OpenAI）可以重复用同一个键。
 */
import type { ContributingCompany, CoreTechEntry, TechStackCategory } from "@/lib/Credits";

/** 核心技术栈分组顺序与标题：数组顺序即页面从上到下的顺序。 */
export const TECH_STACK_CATEGORIES: readonly { id: TechStackCategory; label: string }[] = [
  { id: "frontend", label: "前端" },
  { id: "backend", label: "后端" },
  { id: "scaffold", label: "脚手架" },
  { id: "operations", label: "运维与开发辅助" },
];

/** 分组标题写公司或 AI 团队名（深度求索 / 智谱清言 / OpenAI / Google DeepMind / 腾讯混元 / Anthropic），模型徽章才写具体型号。 */
export const CONTRIBUTING_MODELS: readonly ContributingCompany[] = [
  {
    company: "深度求索",
    logo: "deepseek",
    models: [
      // 预览版先于正式快照发布，按发布时间排在快照之前。
      { name: "Deepseek V4 Flash Preview", releasedAt: "2026-03-24", logo: "deepseek" },
      { name: "Deepseek V4 Flash 0731", releasedAt: "2026-07-31", logo: "deepseek" },
      { name: "Deepseek V4.1 Flash", releasedAt: "2026-09-12", logo: "deepseek" },
      { name: "Deepseek V4.1 Flash 1017", releasedAt: "2026-10-17", logo: "deepseek" },
    ],
  },
  {
    company: "智谱清言",
    logo: "zhipu",
    models: [
      { name: "GLM 5.3", releasedAt: "2026-08-12", logo: "glm" },
      { name: "GLM 5.3 Flash", releasedAt: "2026-08-26", logo: "glm" },
    ],
  },
  {
    company: "OpenAI",
    logo: "openai",
    models: [
      { name: "GPT 5.4", releasedAt: "2026-03-05", logo: "gpt" },
      { name: "GPT 5.5", releasedAt: "2026-05-14", logo: "gpt" },
      { name: "GPT 5.6 Sol", releasedAt: "2026-07-08", logo: "gpt" },
      { name: "GPT 6 Astra", releasedAt: "2026-08-19", logo: "gpt" },
      { name: "GPT 6 Sol", releasedAt: "2026-09-02", logo: "gpt" },
      { name: "GPT 6.1 Sol", releasedAt: "2026-10-08", logo: "gpt" },
    ],
  },
  {
    company: "Google DeepMind",
    logo: "google",
    models: [
      { name: "Gemini 3 Pro Preview", releasedAt: "2025-11-18", logo: "gemini" },
      { name: "Gemini 3.1 Pro Preview", releasedAt: "2026-02-19", logo: "gemini" },
      { name: "Gemini 3.5 Flash", releasedAt: "2026-05-20", logo: "gemini" },
      { name: "Gemini 3.6 Flash", releasedAt: "2026-06-17", logo: "gemini" },
      { name: "Gemini 3.7 Flash", releasedAt: "2026-08-05", logo: "gemini" },
      { name: "Gemini 3.8 Flash", releasedAt: "2026-09-23", logo: "gemini" },
    ],
  },
  {
    company: "腾讯混元",
    logo: "tencent",
    models: [{ name: "Hy 4 Preview", releasedAt: "2026-06-11", logo: "hunyuan" }],
  },
  {
    company: "Anthropic",
    logo: "anthropic",
    models: [
      { name: "Claude Sonnet 4.6", releasedAt: "2026-01-22", logo: "claude" },
      { name: "Claude Opus 4.6", releasedAt: "2026-02-17", logo: "claude" },
      { name: "Claude Opus 4.7", releasedAt: "2026-04-09", logo: "claude" },
      { name: "Claude Opus 4.8", releasedAt: "2026-06-03", logo: "claude" },
      { name: "Claude Sonnet 5", releasedAt: "2026-07-21", logo: "claude" },
      { name: "Claude Opus 5", releasedAt: "2026-08-26", logo: "claude" },
      { name: "Claude Sonnet 5.5", releasedAt: "2026-09-17", logo: "claude" },
      { name: "Claude Opus 5.5", releasedAt: "2026-10-01", logo: "claude" },
    ],
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
    role: "全仓类型契约",
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
