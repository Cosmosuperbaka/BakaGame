import { execSync } from "node:child_process";

/** 默认的 git 命令入口；调用方（测试）可以注入自己的实现。 */
export const runGit = (args: string): string =>
  execSync(`git ${args}`, { encoding: "utf-8" }).trim();

/** 当前 HEAD 的完整提交号；非 git 工作区（平台直接给源码包）时为空串。 */
export const gitRevision = (run: (args: string) => string = runGit): string => {
  try {
    return run("rev-parse HEAD");
  } catch {
    return "";
  }
};
