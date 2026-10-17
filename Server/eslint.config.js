import js from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * 服务端 lint。运行时不依赖 Node 工具链，ESLint 只在开发与 CI 里跑。
 *
 * 类型感知规则只对 tsconfig.json include 覆盖的目录开启（src / scripts / test）；
 * integration 与 drizzle.config.ts 不在工程内，走语法级检查。
 *
 * 与客户端保持同一套规则面：语法级 recommended + 认知复杂度 + 缺陷类 type-aware。
 * 不做 type-checked 全量（no-unsafe-* 在 Bun / 第三方 any 上噪声过大）。
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
  globalIgnores(["coverage", "node_modules", "data", "storage", "tasks", "drizzle"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: {
      sonarjs,
    },
    rules: {
      // 与客户端同一阈值；存量由 eslint-suppressions.json 记录，
      // 重构后跑 `bun run lint:prune` 递减基线。
      "sonarjs/cognitive-complexity": ["error", 20],
      // 解构剩余与显式 _ 前缀是既定写法，不是未使用变量。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: TYPE_AWARE_RULES,
  },
  {
    // 测试夹具大量是同步函数，历史写法里普遍加了 await；在生产代码里该规则才是缺陷信号。
    // 测试里的 any 多来自 mock 与部分实现的桩，同样不按生产代码的标准要求。
    files: ["test/**/*.ts", "scripts/**/*.test.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);
