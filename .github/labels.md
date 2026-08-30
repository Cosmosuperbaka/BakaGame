# Issue 标签规范

标签清单的机器可读源为 [.github/labels.yml](labels.yml)，本文档说明分组与使用规则。标签名与 commit 的 `type` / `scope`（见 [Agents/versioning.md](../Agents/versioning.md)）保持同一套词汇，减少记忆成本。

## 分组

### 类型（必选一个）

| 标签 | 用途 |
|---|---|
| `bug` | 功能未按预期工作 |
| `enhancement` | 新功能或对现有功能的改进 |
| `documentation` | 文档变更 |
| `refactor` | 重构，不改变外部行为 |
| `perf` | 性能优化 |
| `test` | 测试补充或修复 |
| `chore` | 构建、依赖、CI 等工程杂项 |

`bug` 与 `enhancement` 由 Issue 模板自动携带；其余类型标签通常只出现在 PR 上（Issue 阶段往往难以区分 refactor / perf / chore）。

### 范围（按主要受影响对象选择）

| 标签 | 对应 commit scope | 对象 |
|---|---|---|
| `scope/Faker` | `Faker` | WhoIsFaker（谁是卧底） |
| `scope/Song` | `Song` | SongGuessr（听歌猜歌） |
| `scope/CCB` | `CCB` | 二刺猿笑传之猜猜呗（AnimeCharacterGuessr） |
| `scope/Core` | `Core` | 公共能力、基础设施、主页 |

一次变更影响多个游戏时，只打主要受影响者的标签，与"一次提交影响多个游戏时以主要受影响的游戏为准"的提交规则一致。

### 层级（可选）

| 标签 | 含义 |
|---|---|
| `layer/server` | 服务端（`Server/`） |
| `layer/client` | 客户端（`Client/`） |
| `layer/shared` | 双端共享定义（`Server/src/shared/`），通常意味着双端需要同步修改 |

范围标签回答"影响哪个游戏"，层级标签回答"问题在哪一层"，两者组合使用，例如 `scope/Faker` + `layer/server` 表示 WhoIsFaker 的服务端问题。

### 流程（维护者分诊时使用）

| 标签 | 含义 |
|---|---|
| `status/needs-info` | 等待报告者补充信息；补充后由维护者移除 |
| `status/confirmed` | 已确认，等待排期 |

流程标签由维护者添加与移除，报告者无需操作。不设优先级标签，排期以分诊顺序与里程碑为准；确有需要时再引入。

### 社区（GitHub 默认标签，仅汉化描述）

| 标签 | 含义 |
|---|---|
| `good first issue` | 适合新贡献者入手 |
| `help wanted` | 欢迎社区协助 |
| `question` | 使用方式或行为咨询 |
| `duplicate` | 与现有 Issue 重复 |
| `invalid` | 描述有误或无法成立 |
| `wontfix` | 不计划处理 |

## 使用规则

1. 每个 Issue 至少一个类型标签；Bug 报告与功能建议模板已自动携带 `bug` / `enhancement`。
2. 范围标签按影响对象选择，与 PR 标题的 scope 用词一致。
3. 层级标签可选，无法定位时可以不打，由分诊时补充。
4. 处理完成后关闭 Issue，不引入 `done` / `fixed` 之类的终态标签，避免与关闭状态重复表达。

## 同步标签

```bash
npx github-label-sync --labels .github/labels.yml --allow-added-labels Cosmosuperbaka/BakaGame
```

`--allow-added-labels` 保护不在清单中的临时标签不被删除。也可以在 GitHub 仓库的 Issues - Labels 页面按 [labels.yml](labels.yml) 手动维护，两者以 `labels.yml` 为准。
