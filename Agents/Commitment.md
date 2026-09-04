# BakaGame 版本号、提交与变更承诺规范 (Commitment)

## 版本号格式

用户可见版本号使用语义化版本格式：

```
V<major>.<minor>.<patch>
```

版本号由 `Client/src/data/changelog.json` 中的日志条目维护，展示时取其中最大的版本号。`package.json` 的 `version` 仅用于满足 npm/Bun 的包格式要求，不作为产品版本来源。

| 字段 | 说明 |
|---|---|
| `major` | 发生不兼容的重大变化时递增 |
| `minor` | 引入大型新功能时递增 |
| `patch` | 完成一轮 Bug 修复时递增 |

---

## 提交时机与原子化交付

1. **每完成一个点的修改立即提交，严禁等到所有修改完成后再集中进行原子化提交**。
2. 在处理多项重构任务、批量缺陷修复或包含多个子步骤的复杂需求时，严禁积攒大量改动后统一提交或事后批量补提。
3. 每一个独立修改点、子任务或缺陷修复在通过针对性的单元测试与必要验证后，必须第一时间执行独立的 Git 提交，保持工作区干净、提交足迹清晰且具备可单独回滚性。
4. 彼此不可分割的配套修改（如修改 shared 协议与两端对应消费点）保持在同一原子提交中，无关修改严禁混入。

---

## Commit Message 规范

> [!CAUTION]
> **绝对不可违背的提交语言与格式铁律（Zero-Tolerance Commit Rules）**：
> 1. **全中文摘要（Mandatory 100% Chinese Summary）**：commit message 的摘要与正文**必须 100% 使用中文**，**严禁使用任何英文描述**（包括但不限于英文动词、英文短语或整句英文）。
> 2. **字数硬上限（Max 12 Characters）**：冒号后中文摘要**严禁超过 12 个中文字符**（含标点符号）。
> 3. **封闭 Scope 枚举（Strict Scope Enum）**：`scope` **只能且必须从下表枚举 4 选 1**，**严禁自行发明**任何其他作用域（严禁使用 `server`、`client`、`tasks`、`shared`、`backend`、`frontend`、`ui` 等）。

格式模板：

```text
type(scope): 中文摘要
```

### 1. 字段约束表

| 字段 | 允许值 / 约束规则 | 严重违规反例（严禁出现） |
|---|---|---|
| `type` | 仅限 Angular 标准类型：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert` | `update`、`modify`、`change` |
| `scope` | **只能四选一（严格区分大小写）**：<br>• `Faker`（WhoIsFaker 相关逻辑）<br>• `Song`（SongGuessr 相关逻辑）<br>• `CCB`（AnimeCharacterGuessr 相关逻辑）<br>• `Core`（公共架构、Shared 协议、工具链、大厅、CI、文档、任务） | `server`、`client`、`backend`、`frontend`、`shared`、`tasks`、`faker`（小写亦违规） |
| `中文摘要` | **纯中文，不超过 12 个汉字（含标点）**，简洁点明本提交的原子动作 | • 任何英文句子（如 `fail fast on corrupted file`）<br>• 超过 12 字的冗长描述（如 `修复谁是卧底发言阶段中的假玩家对象错误`） |

### 2. 正误对照清单 (Good Taste vs Bad Taste)

| 场景 | ❌ 严禁提交（Bad Taste） | ✅ 正确提交（Good Taste） |
|---|---|---|
| 服务端词库损坏防护 | `fix(server): fail fast on corrupted word bank` | `fix(Faker): 词库损坏时拒绝覆盖` |
| 角色规则纯谓词重构 | `refactor(server): replace try-catch with predicate` | `refactor(Faker): 纯谓词重构配置校验` |
| 客户端移除篡改补丁 | `refactor(client): remove normalizeSnapshot patch` | `refactor(Song): 移除快照篡改补丁` |
| 发言阶段移除假实体 | `refactor(client): eliminate ghost player synthesis` | `refactor(Faker): 消除发言阶段伪造实体` |
| 任务清单文档更新 | `docs(tasks): archive refactoring review in todo.md` | `docs(Core): 归档重构复盘记录` |

### 3. 提交前正则自检公式 (Pre-commit Regex Check)

在执行 `git commit -m` 之前，必须在内部强制校验提交信息是否匹配以下正则，凡不匹配一律禁止提交：
```regex
^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\((Faker|Song|CCB|Core)\): [\u4e00-\u9fa5\d，。、“”《》（）]{1,12}$
```

---

## changelog.json 维护

`Client/src/data/changelog.json` 存储用户可见的更新日志：

```json
{
  "entries": [
    {
      "version": "1.x.x",
      "date": "YYYY-MM-DD",
      "content": {
        "feat": [
          "第一条新功能说明"
        ],
        "fix": [
          "第一条问题修复说明"
        ]
      }
    }
  ]
}
```

- 新增版本时，在 `entries` 数组前部添加条目。
- `content` 为按变更类型聚合的键值对象（如 `feat`、`fix`、`chore`、`perf`、`style`、`refactor`、`docs` 等）。
- **按需填入**：某版本有对应类型更新就填入对应类型；无对应类型更新或未填写的类型**直接省略**，严禁填写空数组或空字符串占位。前端页面仅渲染存在有效更新的类型，无更新的类型在对应版本中绝不显示。
- 更新日志直接从源码导入，随前端构建产物发布，不放入 `public/` 的固定 URL。
- 构建期生成的数据同样不得落在 `public/`：文件名不带 hash，CDN 会按 `immutable` 长期缓存，内容更新后老用户取不到。表情包清单由 `vite.config.ts` 的 `sticker-manifest` 插件以虚拟模块 `virtual:sticker-manifest` 提供，在 `lib/stickers.ts` 中用动态 `import` 按需加载，声明见 `Client/src/vite-env.d.ts`。

### content 语法与语气规范

`content` 是直接面向终端玩家展示的产品级更新文案，其语法与语气必须严格对照已有历史条目：

1. **语法与格式规范**:
   - 分类下的内容优先使用字符串数组（`string[]`），数组每一项对应一条独立、清晰的用户可见变动；仅在单条微小时允许使用单字符串。
   - 内容支持纯文本与轻量行内标记（行首 `-`、`**加粗**`、`` `等宽` `` 与 `[文字](链接)`），由 `Client/src/lib/Changelog.ts` 解析。
   - **严禁编写任何 HTML 标签**，前端禁止使用 `dangerouslySetInnerHTML`。
   - **标点约束**：简短条目末尾**不加句号**；由多个分句构成的复合条目使用中文逗号分隔（如 `"修复已知问题，优化网络体验"`）。

2. **语气与文案风格（严格按照已有条目）**:
   - **用户视角优先**：必须面向终端用户表达，语言平实、克制、简明、自然，严禁使用夸张营销辞藻或机械生硬的 AI 译文。
   - **杜绝堆砌内部技术实现细节**：严禁在更新日志中出现底层函数名、变量名、技术栈内部重构库名或代码实现机制（例如严禁出现“引入 fast-json-patch 对比算法”、“将 BoundedTtlCache 替换为 lru-cache”、“修复 jsdom 环境下的 Storage mock”等纯内部堆栈术语）。此类技术演进仅属于 Git commit message 与工程文档，不面向玩家。
   - **标准句式与语气对照（严格参考已有条目风格）**：
     - **功能新增类**：
       - `"新功能：Whoisfaker新增观战频道"`
       - `"新增发送表情包功能"`
       - `"Songuessr重构版上线测试"`
     - **问题修复类**：
       - `"修复已知问题"`
       - `"修复第二次测试中存在的问题"`
       - `"修复首次测试中存在的问题"`
     - **体验与性能优化类**：
       - `"优化用户界面"`
       - `"修复已知问题，优化网络体验"`
     - **版本里程碑类**：
       - `"完善了Whoisfaker游戏"`
       - `"完成基础开发"`
