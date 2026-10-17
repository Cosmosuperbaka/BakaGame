/**
 * 展示层夹具：Storybook 与组件测试直接构造 `CreditsView` 的入参，不 import `virtual:credits`。
 * 真实数据由 `pages/CreditsPage.tsx` 在构建期注入，这份文件只服务于展示层调试与测试。
 *
 * 依赖清单按包名排序，模拟构建期产物的顺序；其中保留了一个未声明许可证的包，
 * 用来覆盖「未知」筛选项与「未附带许可证原文」两种状态。
 */
import { CONTRIBUTING_MODELS, CORE_TECH_STACK } from "@/data/CreditsContent";
import {
  UNKNOWN_LICENSE,
  type ContributingCompany,
  type CoreTechEntry,
  type CreditDependency,
  type CreditLicenseDocument,
} from "@/lib/Credits";
import type { ChangelogEntry } from "@/lib/Changelog";
import type { CommitEntry } from "@/lib/CommitHistory";

const dependency = (
  overrides: Partial<CreditDependency> & Pick<CreditDependency, "name" | "version">,
): CreditDependency => ({
  license: "MIT",
  description: "",
  url: "",
  direct: true,
  scope: "runtime",
  ...overrides,
});

export const CREDITS_FIXTURE_DEPENDENCIES: readonly CreditDependency[] = [
  dependency({
    name: "@applemusic-like-lyrics/core",
    version: "0.5.2",
    description: "逐字歌词的渲染内核与播放调度。",
    url: "https://github.com/Steve-xmh/applemusic-like-lyrics",
    direct: false,
  }),
  dependency({
    name: "@radix-ui/react-dialog",
    version: "1.1.23",
    description: "无障碍对话框原语。",
    url: "https://www.radix-ui.com/primitives/docs/components/dialog",
  }),
  dependency({
    name: "@sentry/react",
    version: "10.75.1",
    description: "前端异常上报与性能采样。",
    url: "https://docs.sentry.io/platforms/javascript/guides/react/",
  }),
  dependency({
    name: "@testing-library/react",
    version: "16.3.3",
    description: "以用户视角驱动组件测试。",
    url: "https://testing-library.com/docs/react-testing-library/intro/",
    scope: "development",
  }),
  dependency({
    name: "@types/react",
    version: "19.3.0",
    description: "React 的类型声明。",
    url: "https://www.npmjs.com/package/@types/react",
    scope: "development",
  }),
  dependency({
    name: "eslint",
    version: "10.11.0",
    description: "静态检查。",
    url: "https://eslint.org",
    scope: "development",
  }),
  dependency({
    name: "framer-motion",
    version: "13.4.0",
    description: "交互动效编排。",
    url: "https://motion.dev",
  }),
  dependency({
    name: "left-pad",
    version: "1.3.0",
    description: "夹具专用的未声明许可证示例。",
    license: UNKNOWN_LICENSE,
    scope: "development",
  }),
  dependency({
    name: "lucide-react",
    version: "1.47.0",
    license: "ISC",
    description: "通用界面图标。",
    url: "https://lucide.dev",
  }),
  dependency({
    // 夹具里保留一条复合 SPDX 表达式，供窄屏排版与长 License 徽章的截图核对。
    name: "node-webpmux",
    version: "3.2.1",
    license: "MIT AND (LGPL-3.0-or-later OR GPL-2.0-or-later)",
    description: "构建期封装 WebP 动图。",
    url: "https://github.com/scottlabs/node-webpmux",
    scope: "development",
  }),
  dependency({
    name: "react",
    version: "19.3.0",
    description: "界面与组件树。",
    url: "https://react.dev",
  }),
  dependency({
    name: "react-dom",
    version: "19.3.0",
    description: "浏览器端渲染入口。",
    url: "https://react.dev",
  }),
  dependency({
    name: "sharp",
    version: "0.35.4",
    license: "Apache-2.0",
    description: "构建期图片转码与缩略图生成。",
    url: "https://sharp.pixelplumbing.com",
    scope: "development",
  }),
  dependency({
    name: "tailwindcss",
    version: "4.3.3",
    description: "语义令牌与样式基线。",
    url: "https://tailwindcss.com",
  }),
  dependency({
    name: "typescript",
    version: "5.9.3",
    license: "Apache-2.0",
    description: "全仓类型契约。",
    url: "https://www.typescriptlang.org",
  }),
  dependency({
    name: "vite",
    version: "8.3.0",
    description: "开发服务器与生产构建。",
    url: "https://vite.dev",
  }),
  dependency({
    name: "vitest",
    version: "5.0.1",
    description: "单元测试运行器。",
    url: "https://vitest.dev",
    scope: "development",
  }),
  dependency({
    name: "zod",
    version: "4.6.7",
    description: "运行时数据结构校验。",
    url: "https://zod.dev",
  }),
  dependency({
    name: "zustand",
    version: "5.0.15",
    description: "客户端状态容器。",
    url: "https://zustand.docs.pmnd.rs",
  }),
];

/** 贡献模型与核心技术栈直接复用真实数据源，故事里看到的就是线上内容。 */
export const CREDITS_FIXTURE_MODELS: readonly ContributingCompany[] = CONTRIBUTING_MODELS;
export const CREDITS_FIXTURE_TECH_STACK: readonly CoreTechEntry[] = CORE_TECH_STACK;

export const CREDITS_FIXTURE_CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: "1.2.0",
    date: "2026-10-17",
    content: {
      feat: ["新增开源致谢页，集中展示贡献模型、核心技术栈与依赖清单", "版本信息改为整页展示，更新日志与提交历史并入同一组标签"],
      fix: ["修复窄屏下依赖工具条挤压搜索框的问题"],
    },
  },
  {
    version: "1.1.0",
    date: "2026-09-30",
    content: {
      feat: ["CCB 支持角色全局 BP"],
      perf: ["歌词播放器按需加载，首屏分块更小"],
    },
  },
];

export const CREDITS_FIXTURE_COMMITS: readonly CommitEntry[] = [
  {
    hash: "3ee6998",
    message: "fix(Song): 统一主题曲类型判定并加固专辑错配防线",
    date: "2026-10-16T11:20:00.000Z",
    author: "Cosmosuperbaka",
  },
  {
    hash: "9356225",
    message: "fix(Core): QQ请求伪装浏览器UA",
    date: "2026-10-15T08:05:00.000Z",
    author: "Cosmosuperbaka",
  },
  {
    hash: "c241d4c",
    message: "fix(Core): 修复独立安装布局下的共享契约解析",
    date: "2026-10-12T15:42:00.000Z",
    author: "Cosmosuperbaka",
  },
];

const MIT_LICENSE = `MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`;

export const CREDITS_FIXTURE_LICENSES: Record<string, CreditLicenseDocument> = {
  react: {
    files: [
      { name: "LICENSE", text: MIT_LICENSE },
      {
        name: "NOTICE",
        text: "React\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\n本文件为夹具示例，真实内容取自依赖包自带的 NOTICE 文件。",
      },
    ],
  },
  zod: {
    files: [
      {
        name: "LICENSE",
        text: `MIT License\n\nCopyright (c) 2020 Colin McDonnell\n\n本文件为夹具示例，真实内容取自依赖包自带的 LICENSE 文件。`,
      },
    ],
  },
};

/** 故事里的许可证读取：已知包返回夹带原文，其余包按「未附带原文」处理。 */
export function loadFixtureLicense(packageName: string): Promise<CreditLicenseDocument | null> {
  return Promise.resolve(CREDITS_FIXTURE_LICENSES[packageName] ?? { files: [] });
}
