# BakaGame 版本号与 Commit 规范

## 版本号格式

```
V<major>.<minor>.<patch>(<commit_hash>)
```

示例：`V1.2.3(a1b2c3d)`

| 字段 | 说明 |
|---|---|
| `major` | 固定为 `1`，不递增 |
| `minor` | 每次引入**大型新功能**（新游戏模式、重大架构变更）时 +1 |
| `patch` | 每轮工作周期的 Bug 修复完成后 +1（一个工作周期 = 用户的一次工作任务) |
| `commit_hash` | 最新 Git Commit 的前 7 位 short hash |

版本号由 `Server/package.json`（或 `Client/package.json`）的 `version` 字段维护，格式为 semver `1.x.x`；  
展示时在前面加 `V` 前缀，后面拼接 `(commit_hash)`。

---

## Commit Message 规范

格式：

```
type(game): 正文
```

### 规则

1. **正文必须使用中文**。
2. **正文不超过 12 个中文字**（含标点）。若超出，将该 commit 拆分为更小的提交，直到每条不超过 12 字。
3. `type` 使用 Angular 标准类型：`feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore` / `perf`。
4. `game` 括号中填写**受影响游戏的缩写**：

| 游戏 | 缩写 |
|---|---|
| WhoIsFaker | `Faker` |
| SongGuessr | `Song` |
| AnimeCharacterGuessr | `CCB` |
| 公共/基础设施/主页 | `Core` |

5. 若一次 commit 同时影响多个游戏，以主要受影响游戏为准，或拆分 commit。

### 合法示例

```
feat(Faker): 新增白板猜词功能
fix(Core): 修复版本号展示错误
docs(Faker): 更新游戏规则文档
chore(Core): 升级依赖版本
feat(Song): 新增每日题库
```

### 非法示例

```
feat(Faker): 新增白板猜词功能并修复投票计时器显示问题和聊天区布局错位  ❌ 超过 12 字
add new feature                                                          ❌ 非中文正文
feat: 修复主页样式问题                                                    ❌ 缺少 game 括号
```

---

## changelog.json 维护说明

`Client/public/changelog.json` 存储用户可见的更新日志，格式：

```json
{
  "currentVersion": "1.x.x",
  "entries": [
    {
      "version": "1.x.x",
      "date": "YYYY-MM-DD",
      "title": "简短描述",
      "content": "- 第一条\n- 第二条"
    }
  ]
}
```

- 每次 `minor` 版本递增时，在 `entries` 数组顶部追加一条新记录。
- `content` 使用纯文本轻量标记，由人工维护，**不写 HTML 标签**：
  - 以 `-` 或 `*` 开头的行渲染为列表项
  - 其余非空行渲染为段落
  - 行内支持 `**加粗**`、`` `等宽` `` 和 `[文字](链接)`
  - 换行用 `\n`
- 解析由 `Client/src/lib/changelog.ts` 完成，渲染不使用 `dangerouslySetInnerHTML`。
- `currentVersion` 与最新 entry 的 `version` 保持一致。
