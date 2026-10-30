import js from "@eslint/js";
import globals from "globals";
import checkFile from "eslint-plugin-check-file";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * 类型感知规则：只对 tsconfig.app.json 工程内的 src 开启。
 * e2e、.storybook、vite/vitest 配置不在该工程里，套 project 会直接报
 * "file not found in any project"，因此它们只走语法级检查。
 *
 * 只挑缺陷类，不启用 recommendedTypeChecked 全量：no-unsafe-* 在本项目
 * 会大量命中第三方 any 泄漏（实测 347 条），信噪比不足以进门禁。
 */
const TYPE_AWARE_RULES = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-base-to-string": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/unbound-method": "error",
};

export default defineConfig([
  globalIgnores([
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
    "storybook-static",
    "storybook-shots",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      sonarjs,
    },
    rules: {
      // 认知复杂度阈值 20。存量由 eslint-suppressions.json 记录，新增违规直接失败；
      // 重构使复杂度下降后跑 `npm run lint:prune` 递减基线，避免基线腐烂。
      "sonarjs/cognitive-complexity": ["error", 20],
      // 共享契约入口携带 TypeBox：非 type 导入会把校验库整体打进浏览器包。
      // 运行时值一律走纯值入口，类型仍可用 import type 从原入口取。
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@bakagame/shared",
              allowTypeImports: true,
              message:
                "运行时值请从 @bakagame/shared/values 导入，@bakagame/shared 只用于 import type。",
            },
          ],
        },
      ],
    },
  },
  {
    // 文件名统一 PascalCase。ignoreMiddleExtensions 让 X.test.tsx / X.stories.tsx
    // 只校验主名，否则中缀段会被判违规。vite-env.d.ts 是 Vite 生成的固定命名，单独放行。
    files: ["src/**/*.{ts,tsx}", "e2e/**/*.ts"],
    ignores: ["src/vite-env.d.ts"],
    plugins: {
      "check-file": checkFile,
    },
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        { "**/*.{ts,tsx}": "PASCAL_CASE" },
        { ignoreMiddleExtensions: true },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        // 根 tsconfig.json 是 files: [] + references，projectService 会撞上它
        // 并报 file not found；这里必须显式指向 app 工程。
        project: ["./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: TYPE_AWARE_RULES,
  },
]);
