## 变更说明

<!-- 做了什么、为什么做。 -->

## 关联 Issue

<!-- 例如 Closes #123；无关联 Issue 时写"无"并说明背景。 -->

## 变更类型

<!-- 与 commit type 对应，可多选。 -->

- [ ] feat 新功能
- [ ] fix 缺陷修复
- [ ] refactor 重构（不改变外部行为）
- [ ] perf 性能优化
- [ ] test 测试补充
- [ ] docs 文档
- [ ] chore 构建 / 依赖 / 工程化

## 影响范围

<!-- 与 commit scope 对应，多项可复选。 -->

- [ ] Faker（WhoIsFaker）
- [ ] Song（SongGuessr）
- [ ] CCB（AnimeCharacterGuessr）
- [ ] Core（公共能力、基础设施、主页）

## 验证

<!-- 按实际改动勾选，至少完成所改包的 verify；顺序与细节见 Agents/Testing.md。 -->

- [ ] Server：`bun install --frozen-lockfile` 后 `bun run verify` 通过
- [ ] Client：`npm ci` 后 `npm run verify` 通过
- [ ] 已手动验证主要流程，操作路径：
- [ ] 纯文档或流程变更，无需运行时验证

## 自查清单

- [ ] PR 标题符合 `type(scope): 中文摘要`，摘要不超过 12 个中文字（见 Agents/versioning.md）
- [ ] 修复缺陷时附带一条修复前会失败的回归测试（见 Agents/Testing.md）
- [ ] 协议、模型或共享定义的变更已同步双端与相关文档
- [ ] 替换旧规范时已删除旧实现，未保留兼容分支（见 Agents/Spec.md 第 4 条）
- [ ] 用户可见的行为变化已在 `Client/src/data/changelog.json` 记录，或说明无需记录
