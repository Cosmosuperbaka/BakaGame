/**
 * 展示层夹具里的依赖图：按包名排序，模拟构建期 `virtual:credits` 的产物顺序。
 *
 * 这份图刻意覆盖二级抽屉的几种边界：
 *   - `vite` 带多层子依赖（esbuild / postcss / rollup 各自还有下级），用于下钻与「间接依赖」计数；
 *   - `zustand`、`left-pad` 没有子依赖，用于抽屉里的「无子依赖」；
 *   - `left-pad` 未声明许可证，且没有附带许可证原文，用于「未知」筛选与「未附带原文」两种状态。
 * 真正的依赖闭包由构建期插件生成，这里只服务于 Storybook 与展示层测试。
 */
import { UNKNOWN_LICENSE, type CreditDependency } from "@/lib/Credits";

const dependency = (
  overrides: Partial<CreditDependency> & Pick<CreditDependency, "name" | "version">
): CreditDependency => ({
  license: "MIT",
  description: "",
  url: "",
  direct: true,
  scope: "runtime",
  dependencies: [],
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
    name: "@esbuild/win32-x64",
    version: "0.25.9",
    description: "esbuild 的 Windows 平台二进制。",
    direct: false,
    scope: "development",
  }),
  dependency({
    name: "@radix-ui/react-dialog",
    version: "1.1.23",
    description: "无障碍对话框原语。",
    url: "https://www.radix-ui.com/primitives/docs/components/dialog",
    dependencies: ["@radix-ui/react-primitive", "@radix-ui/react-slot"],
  }),
  dependency({
    name: "@radix-ui/react-primitive",
    version: "1.1.3",
    description: "Radix 原语的公共基础组件。",
    url: "https://www.radix-ui.com/primitives",
    direct: false,
    dependencies: ["@radix-ui/react-slot"],
  }),
  dependency({
    name: "@radix-ui/react-slot",
    version: "1.2.3",
    description: "把样式与行为合并到子元素的插槽组件。",
    url: "https://www.radix-ui.com/primitives/docs/utilities/slot",
    direct: false,
  }),
  dependency({
    name: "@sentry/core",
    version: "10.75.1",
    description: "Sentry SDK 的公共内核。",
    url: "https://docs.sentry.io/platforms/javascript/",
    direct: false,
  }),
  dependency({
    name: "@sentry/react",
    version: "10.75.1",
    description: "前端异常上报与性能采样。",
    url: "https://docs.sentry.io/platforms/javascript/guides/react/",
    dependencies: ["@sentry/core"],
  }),
  dependency({
    name: "@testing-library/dom",
    version: "10.4.1",
    description: "Testing Library 的 DOM 查询与事件工具。",
    url: "https://testing-library.com/docs/dom-testing-library/intro/",
    direct: false,
    scope: "development",
  }),
  dependency({
    name: "@testing-library/react",
    version: "16.3.3",
    description: "以用户视角驱动组件测试。",
    url: "https://testing-library.com/docs/react-testing-library/intro/",
    scope: "development",
    dependencies: ["@testing-library/dom"],
  }),
  dependency({
    name: "@types/estree",
    version: "1.0.9",
    description: "ESTree 语法树的类型声明。",
    url: "https://github.com/estree/estree",
    direct: false,
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
    name: "esbuild",
    version: "0.25.9",
    description: "开发服务器与构建使用的打包器。",
    url: "https://esbuild.github.io",
    direct: false,
    scope: "development",
    dependencies: ["@esbuild/win32-x64"],
  }),
  dependency({
    name: "eslint",
    version: "10.11.0",
    description: "静态检查。",
    url: "https://eslint.org",
    scope: "development",
  }),
  dependency({
    name: "fsevents",
    version: "2.3.3",
    description: "macOS 的文件系统事件监听。",
    direct: false,
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
    description: "夹具专用的未声明许可证示例，没有附带许可证原文。",
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
    name: "nanoid",
    version: "3.3.11",
    description: "短随机 ID 生成。",
    direct: false,
    scope: "development",
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
    name: "postcss",
    version: "8.5.6",
    description: "CSS 转换管线。",
    direct: false,
    scope: "development",
    dependencies: ["nanoid"],
  }),
  dependency({
    name: "react",
    version: "19.3.0",
    description: "界面与组件树。",
    url: "https://react.dev",
    dependencies: ["scheduler"],
  }),
  dependency({
    name: "react-dom",
    version: "19.3.0",
    description: "浏览器端渲染入口。",
    url: "https://react.dev",
    dependencies: ["react", "scheduler"],
  }),
  dependency({
    name: "rollup",
    version: "4.48.0",
    description: "生产构建的模块打包器。",
    url: "https://rollupjs.org",
    direct: false,
    scope: "development",
    dependencies: ["@types/estree", "fsevents"],
  }),
  dependency({
    name: "scheduler",
    version: "0.27.0",
    description: "React 的调度器。",
    direct: false,
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
    scope: "development",
  }),
  dependency({
    name: "vite",
    version: "8.3.0",
    description: "开发服务器与生产构建。",
    url: "https://vite.dev",
    // 夹具里的多层子依赖示例：三个直接子包各自再带下级。
    dependencies: ["esbuild", "postcss", "rollup"],
    scope: "development",
  }),
  dependency({
    name: "vitest",
    version: "5.0.1",
    description: "单元测试运行器。",
    url: "https://vitest.dev",
    scope: "development",
    dependencies: ["vite"],
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
