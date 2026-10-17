/**
 * 开源致谢页的静态内容：为本项目做出过实际改动的模型，以及页面重点展示的核心技术栈。
 *
 * 模型署名规则（维护时先读 `Agents/Credits.md`）：
 *   - 只有实际改动了仓库文件（代码、数据、文档、样式、配置）的模型才署名；
 *     仅参与讨论、咨询、评审或规划的不算。
 *   - 完成改动后，在文件末尾按「公司 → 发布时间」补上自己的名字与 `releasedAt`；
 *     已有公司里新增模型直接追加，页面展示前由 `sortModelsByRelease` 统一按时间排序。
 *   - 公司顺序取本文件的声明顺序；第一次出现的公司追加到末尾，不插队重排。
 *
 * `releasedAt` 只用于排序，页面上不展示；日期用 ISO `YYYY-MM-DD`。
 */
import type { ContributingCompany, CoreTechEntry } from "@/lib/Credits";

export const CONTRIBUTING_MODELS: readonly ContributingCompany[] = [
  {
    company: "Deepseek",
    models: [
      // 预览版先于正式快照发布，按发布时间排在快照之前。
      { name: "Deepseek V4 Flash Preview", releasedAt: "2026-03-24" },
      { name: "Deepseek V4 Flash 0731", releasedAt: "2026-07-31" },
      { name: "Deepseek V4.1 Flash", releasedAt: "2026-09-12" },
      { name: "Deepseek V4.1 Flash 1017", releasedAt: "2026-10-17" },
    ],
  },
  {
    company: "GLM",
    models: [
      { name: "GLM 5.3", releasedAt: "2026-08-12" },
      { name: "GLM 5.3 Flash", releasedAt: "2026-08-26" },
    ],
  },
  {
    company: "GPT",
    models: [
      { name: "GPT 5.4", releasedAt: "2026-03-05" },
      { name: "GPT 5.5", releasedAt: "2026-05-14" },
      { name: "GPT 5.6 Sol", releasedAt: "2026-07-08" },
      { name: "GPT 6 Astra", releasedAt: "2026-08-19" },
      { name: "GPT 6 Sol", releasedAt: "2026-09-02" },
      { name: "GPT 6.1 Sol", releasedAt: "2026-10-08" },
    ],
  },
  {
    company: "Gemini",
    models: [
      { name: "Gemini 3 Pro Preview", releasedAt: "2025-11-18" },
      { name: "Gemini 3.1 Pro Preview", releasedAt: "2026-02-19" },
      { name: "Gemini 3.5 Flash", releasedAt: "2026-05-20" },
      { name: "Gemini 3.6 Flash", releasedAt: "2026-06-17" },
      { name: "Gemini 3.7 Flash", releasedAt: "2026-08-05" },
      { name: "Gemini 3.8 Flash", releasedAt: "2026-09-23" },
    ],
  },
  {
    company: "Hy",
    models: [{ name: "Hy 4 Preview", releasedAt: "2026-06-11" }],
  },
  {
    company: "Claude",
    models: [
      { name: "Claude Sonnet 4.6", releasedAt: "2026-01-22" },
      { name: "Claude Opus 4.6", releasedAt: "2026-02-17" },
      { name: "Claude Opus 4.7", releasedAt: "2026-04-09" },
      { name: "Claude Opus 4.8", releasedAt: "2026-06-03" },
      { name: "Claude Sonnet 5", releasedAt: "2026-07-21" },
      { name: "Claude Opus 5", releasedAt: "2026-08-26" },
      { name: "Claude Sonnet 5.5", releasedAt: "2026-09-17" },
      { name: "Claude Opus 5.5", releasedAt: "2026-10-01" },
    ],
  },
];

/**
 * 核心技术栈：上半部分重点展示，按项目里的实际职责写，不写宣传语。
 * `packageName` 用于从依赖清单里取实际安装版本；运行时/服务端工具不在此列时省略。
 */
export const CORE_TECH_STACK: readonly CoreTechEntry[] = [
  {
    name: "React",
    role: "界面与组件树",
    icon: "react",
    url: "https://react.dev",
    packageName: "react",
  },
  {
    name: "TypeScript",
    role: "全仓类型契约",
    icon: "typescript",
    url: "https://www.typescriptlang.org",
    packageName: "typescript",
  },
  {
    name: "Vite",
    role: "构建与按路由分块",
    icon: "vite",
    url: "https://vite.dev",
    packageName: "vite",
  },
  {
    name: "Tailwind CSS",
    role: "语义令牌与样式基线",
    icon: "tailwindcss",
    url: "https://tailwindcss.com",
    packageName: "tailwindcss",
  },
  {
    name: "Framer Motion",
    role: "交互动效编排",
    icon: "framer",
    url: "https://motion.dev",
    packageName: "framer-motion",
  },
  {
    name: "Radix UI",
    role: "可访问的控件原语",
    icon: "radixui",
    url: "https://www.radix-ui.com",
  },
  {
    name: "Zustand",
    role: "客户端状态容器",
    icon: "zustand",
    url: "https://zustand.docs.pmnd.rs",
    packageName: "zustand",
  },
  {
    name: "Bun",
    role: "服务端运行时",
    icon: "bun",
    url: "https://bun.sh",
  },
  {
    name: "Elysia",
    role: "HTTP 与 WebSocket 服务",
    icon: "elysia",
    url: "https://elysiajs.com",
  },
  {
    name: "Drizzle ORM",
    role: "数据库访问与迁移",
    icon: "drizzle",
    url: "https://orm.drizzle.team",
  },
  {
    name: "pnpm",
    role: "工作区依赖管理",
    icon: "pnpm",
    url: "https://pnpm.io",
  },
  {
    name: "Sentry",
    role: "异常追踪与性能观测",
    icon: "sentry",
    url: "https://sentry.io",
    packageName: "@sentry/react",
  },
];
