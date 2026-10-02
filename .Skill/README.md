# 独立工程 Skill 引用

本目录通过 Git 子模块引用独立技能仓库，不复制技能文件；各目录的 gitlink 固定对应提交。

| Skill | 入口与职责 | 同级独立仓库 |
|---|---|---|
| personal-project-engineering | [个人工程基线](personal-project-engineering/SKILL.md)；提取范围见 [来源与适配](personal-project-engineering/references/source-map.md) | `../personal-project-engineering-skill/` |
| project-quality-audit | [项目质量审查](project-quality-audit/SKILL.md)；11 个专项、覆盖记录、证据核验、根因修复与复审 | `../project-quality-audit-skill/` |

## 结构与规则归属

- 独立仓库位于上表的同级目录，仓库根即技能根；正文、元数据、参考文档和辅助工具在那里维护并独立提交。
- 本项目以各 `.Skill/<技能名>` 的 gitlink 固定技能提交，并用 `.gitmodules` 记录来源。修改技能后必须同时更新本项目引用，不能只留下一个未提交的子模块工作区。
- BakaGame 的 `Agents/` 仍是本项目专项规则的权威来源；Skill 补充通用基线，不自动改写本项目原有规则或业务文档。
- 普通业务任务不自动跨仓维护技能。明确的技能维护任务先在独立仓库验证并提交，再更新本项目引用。

## 本地来源与初始化

两个技能仓库目前均为本地来源，未发布远程。以下现有示例使用个人工程技能，质量审查技能的命令见下节。

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

## 项目质量审查技能

独立仓库为 `../project-quality-audit-skill/`，项目固定引用为 `.Skill/project-quality-audit`。`.gitmodules` 中的 `../project-quality-audit-skill` 同样需要本地 URL 覆盖，不代表对应 GitHub 仓库存在。新 checkout 先准备包含被引用提交的独立仓库，再从 BakaGame 根执行：

```powershell
$skillRepo = (Resolve-Path -LiteralPath '../project-quality-audit-skill').Path
git config 'submodule..Skill/project-quality-audit.url' $skillRepo
git -c protocol.file.allow=always submodule update --init -- .Skill/project-quality-audit
git submodule status -- .Skill/project-quality-audit
```

维护后更新引用（先确认独立仓库验证、提交完毕，子模块没有要保留的未提交改动）：

```powershell
$skillRepo = (Resolve-Path -LiteralPath '../project-quality-audit-skill').Path
$skillRevision = git -C $skillRepo rev-parse HEAD
git -C .Skill/project-quality-audit fetch $skillRepo
git -C .Skill/project-quality-audit switch --detach $skillRevision
git add -- .Skill/project-quality-audit
git diff --cached --submodule=log -- .Skill/project-quality-audit
git commit -m 'docs(Core): 更新审查技能'
```

使用时按用户任务显式加载入口，例如“读取 `.Skill/project-quality-audit/SKILL.md`，整体审查项目，只给问题和修复方向”或“只审查过度防御和历史兼容代码”；要求执行修复时明确写“审查并修复”或指定报告/问题编号。

此路径通过本项目 `AGENTS.md` 导航，不假定宿主会自动扫描 `.Skill`。支持原生 Skill 注册的工具，可按其配置方式加载；本项目接入不写全局技能目录或修改用户设置。报告默认保存在已忽略的 `tasks/quality-audit/<run-id>/`，不自动提交含运行证据的报告。

辅助脚本只依赖 Python 标准库，需 Python 3.11+ 与 Git：`scripts/audit_artifacts.py` 生成文件盘点、检查覆盖声明与快照漂移，不代替 Subagent 的语义审查。技能自身的工具测试在独立仓库运行 `python -m unittest discover -s tests -v`。具体模式、专项、产物与修复约束只维护在技能入口及其参考文档，不在本说明复制。

只审查不自动获得修改源码、推送、部署或真实第三方写入权限。普通业务任务不会顺便维护两个独立技能仓库。未提供远程仓库前，不能声称换一台机器可直接从 GitHub 初始化；跨机器需同时携带独立仓库及固定提交。
