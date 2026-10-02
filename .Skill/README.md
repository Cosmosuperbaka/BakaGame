# 个人工程 Skill 引用

本目录使用 Git 子模块引用独立的 `personal-project-engineering-skill` 仓库，不复制一份技能文件。入口是 [personal-project-engineering/SKILL.md](personal-project-engineering/SKILL.md)，提取范围与用户确认见 [来源与适配](personal-project-engineering/references/source-map.md)。

## 结构与规则归属

- 独立仓库位于 BakaGame 的同级目录 `../personal-project-engineering-skill/`，仓库根即技能根；技能正文、元数据与参考文档在那里维护并独立提交。
- 本项目以 `.Skill/personal-project-engineering` 的 gitlink 固定技能提交，并用 `.gitmodules` 记录来源。修改技能后必须同时更新本项目引用，不能只留下一个未提交的子模块工作区。
- BakaGame 的 `Agents/` 仍是本项目专项规则的权威来源；Skill 补充通用基线，不自动改写本项目原有规则或业务文档。
- 普通业务任务不自动跨仓维护技能。明确的技能维护任务先在独立仓库验证并提交，再更新本项目引用。

## 当前是本地仓库，未发布远程

`.gitmodules` 使用 `../personal-project-engineering-skill` 记录同级仓库关系。**Git 相对子模块 URL 相对于父仓库的上游地址解析，并非总相对于磁盘工作目录**。本项目上游当前在 GitHub，因此仅执行默认初始化会尝试访问尚不存在的同名 GitHub 仓库。

当前 checkout 已配置本地 URL 覆盖，路径不写入版本化文件。新 checkout 需先在 BakaGame 同级放好独立技能仓库，再从 BakaGame 根目录执行以下 PowerShell 命令：

```powershell
$skillRepo = (Resolve-Path -LiteralPath '../personal-project-engineering-skill').Path
git config 'submodule..Skill/personal-project-engineering.url' $skillRepo
git -c protocol.file.allow=always submodule update --init -- .Skill/personal-project-engineering
git submodule status -- .Skill/personal-project-engineering
```

若独立仓库位于别处，将 `$skillRepo` 改为真实仓库路径。`protocol.file.allow=always` 仅限这次本地初始化，不修改全局 Git 安全配置。**当前不要执行 `git submodule sync`**：它会用 `.gitmodules` 的相对来源覆盖本地 URL 配置。

没有独立仓库或目标提交时，不能把 Skill 的文件拷贝当作完整的子模块恢复。当前未提供可在其他机器直接初始化的远程来源，也没有为本任务执行推送。

## 更新引用

确认独立仓库已完成验证并提交，且子模块工作区没有需要保留的未提交修改后，在 BakaGame 根目录执行：

```powershell
$skillRepo = (Resolve-Path -LiteralPath '../personal-project-engineering-skill').Path
$skillRevision = git -C $skillRepo rev-parse HEAD
git -C .Skill/personal-project-engineering fetch $skillRepo
git -C .Skill/personal-project-engineering switch --detach $skillRevision
git add -- .Skill/personal-project-engineering
git diff --cached --submodule=log -- .Skill/personal-project-engineering
git commit -m 'docs(Core): 更新工程技能'
```

暂存区仍按本项目规则检查，只提交本任务文件；在父仓库提交前核对固定的哈希与独立仓库预期提交一致。独立提交不自动意味着可以推送或部署。

以后若经授权创建真实远程仓库，再将 `.gitmodules` 来源改为已存在的地址、同步配置并验收初始化；发布需保证父仓库所引用的技能提交先在远程可取。
