/**
 * 展示层夹具：Storybook 与组件测试直接构造 `CreditsView` 的入参，不 import `virtual:credits`。
 * 真实数据由 `pages/CreditsPage.tsx` 在构建期注入，这份文件只服务于展示层调试与测试。
 *
 * 依赖图单独放在 `CreditsFixtureDependencies.ts`（含下钻、无子依赖与无许可证原文的覆盖用例），
 * 这里保留模型、技术栈、更新日志、提交历史与许可证原文，两部分的更新时间互不影响。
 */
import { CONTRIBUTING_MODELS, CORE_TECH_STACK } from "@/data/CreditsContent";
import type { ContributingCompany, CoreTechEntry, CreditLicenseDocument } from "@/lib/Credits";
import type { ChangelogEntry } from "@/lib/Changelog";
import type { CommitEntry } from "@/lib/CommitHistory";
import { CREDITS_FIXTURE_DEPENDENCIES } from "./CreditsFixtureDependencies";

// 展示层统一从本文件取夹具，依赖图拆到独立文件后仍保留这一入口，测试与故事不必感知拆分。
export { CREDITS_FIXTURE_DEPENDENCIES };

/** 贡献模型与核心技术栈直接复用真实数据源，故事里看到的就是线上内容（含 logo 与分组）。 */
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
