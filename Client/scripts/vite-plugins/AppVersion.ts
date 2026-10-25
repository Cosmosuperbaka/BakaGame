/** 把 changangelog.json 的最新版本注入为虚拟模块，并桥接 HMR。 */
import path from "path";
import fs from "fs";
import { latestVersionOf } from "../../src/lib/Changelog.ts";

const APP_VERSION_ID = "virtual:app-version";

/** 失效钩子只用到的两项，声明成结构类型，用例不必起真实 dev server 也能验。 */
type VersionHmrServer = {
  moduleGraph: {
    getModuleById(id: string): { id: string } | undefined;
    invalidateModule(module: { id: string }): void;
  };
};

export function appVersionPlugin(changelogPath: string) {
  const resolvedId = "\0" + APP_VERSION_ID;
  const resolvedPath = path.resolve(changelogPath);

  return {
    name: "app-version",
    resolveId(id: string) {
      return id === APP_VERSION_ID ? resolvedId : null;
    },
    load(id: string) {
      if (id !== resolvedId) return null;

      // 取不到条目时给空串，由消费方按既有口径显示占位版本号。
      const version = latestVersionOf(fs.readFileSync(resolvedPath, "utf8"));
      return `export default ${JSON.stringify(version ?? "")}`;
    },
    handleHotUpdate({ file, server }: { file: string; server: VersionHmrServer }) {
      // 开发期改日志要能看到新版本号：虚拟模块没有自己的文件，靠显式失效重算。
      if (path.resolve(file) !== resolvedPath) return;
      const mod = server.moduleGraph.getModuleById(resolvedId);
      if (mod) server.moduleGraph.invalidateModule(mod);
    },
  };
}

// ==================== Vite 插件：扫描表情包目录生成清单 ====================
// 以虚拟模块提供数据，随 JS 产物一同带 hash：
// 落到 public/ 的固定文件名会被 CDN 按不变资源长期缓存，新增表情包后老用户取不到。
