// ==================== Vite 插件：站点根下的版本清单 ====================
// 原生壳要把「游戏版本」写进自己的 User-Agent（只用于诊断与统计），它读的就是这份
// `version.json`：产品版本取更新日志里的最大版本，短提交号取本地 HEAD，与首页显示的
// `V2.0.0(eb11009)` 同源，不另起一套。文件名固定、不带内容哈希，所以落在站点兜底的
// `max-age=0, must-revalidate` 档里（见 edgeone.json 与 Agents/Deployment.md §5），不得给它
// 单独配长缓存。安卓壳内嵌构建产物，同样带上这份文件。
import fs from "fs";
import path from "path";
import { latestVersionOf } from "../../src/lib/Changelog.ts";
import { shortCommit } from "../../src/lib/ReleaseName.ts";
import {
  GAME_VERSION_MANIFEST_PATH,
  type GameVersionManifest,
} from "../../../Server/src/shared/ClientUserAgent.ts";
import { gitRevision, runGit } from "./GitRevision.ts";

/** 中间件只用到的两项，声明成结构类型，用例不必起真实 dev server */
type ManifestResponse = {
  setHeader(name: string, value: string): void;
  end(body: string): void;
};
type ManifestServer = {
  middlewares: { use(route: string, handler: (req: unknown, res: ManifestResponse) => void): void };
};

export function versionManifestPlugin(
  changelogPath: string,
  options: { execGit?: (args: string) => string } = {}
) {
  const resolvedPath = path.resolve(changelogPath);
  const git = options.execGit ?? runGit;

  /** 与首页的版本号、提交号同一口径：日志为空给空串，非 git 工作区给占位 `dev` */
  const manifest = (): GameVersionManifest => ({
    version: latestVersionOf(fs.readFileSync(resolvedPath, "utf8")) ?? "",
    commit: shortCommit(gitRevision(git)) || "dev",
  });
  const body = () => `${JSON.stringify(manifest())}\n`;

  return {
    name: "version-manifest",
    // 开发期同样提供：开发壳连本地 Vite 时也能读到游戏版本
    configureServer(server: ManifestServer) {
      server.middlewares.use(GAME_VERSION_MANIFEST_PATH, (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(body());
      });
    },
    generateBundle(this: {
      emitFile(file: { type: "asset"; fileName: string; source: string }): void;
    }) {
      this.emitFile({
        type: "asset",
        fileName: GAME_VERSION_MANIFEST_PATH.replace(/^\//, ""),
        source: body(),
      });
    },
  };
}
