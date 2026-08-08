# BakaGame 版本号与提交规范

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

## Commit Message 规范

格式：

```
type(scope): 中文摘要
```

规则：

1. 摘要必须使用中文，且不超过 12 个中文字（含标点）。
2. `type` 使用 Angular 标准类型：`feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`、`perf`。
3. `scope` 填写受影响游戏的缩写：

| 游戏 | 缩写 |
|---|---|
| WhoIsFaker | `Faker` |
| SongGuessr | `Song` |
| AnimeCharacterGuessr | `CCB` |
| 公共能力、基础设施、主页 | `Core` |

一次提交影响多个游戏时，以主要受影响的游戏为准，或拆分提交。

示例：

```
feat(Faker): 新增白板猜词
fix(Core): 修复健康检查
docs(Faker): 更新游戏规则
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
      "title": "简短描述",
      "content": "- 第一条\n- 第二条"
    }
  ]
}
```

- 新增版本时，在 `entries` 数组前部添加条目。
- `content` 使用纯文本轻量标记，由 `Client/src/lib/changelog.ts` 解析；禁止写 HTML 或使用 `dangerouslySetInnerHTML`。
- 更新日志直接从源码导入，随前端构建产物发布，不放入 `public/` 的固定 URL。
- 构建期生成的数据同样不得落在 `public/`：文件名不带 hash，CDN 会按 `immutable` 长期缓存，内容更新后老用户取不到。表情包清单由 `vite.config.ts` 的 `sticker-manifest` 插件以虚拟模块 `virtual:sticker-manifest` 提供，在 `lib/stickers.ts` 中用动态 `import` 按需加载，声明见 `Client/src/vite-env.d.ts`。
