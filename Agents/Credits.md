# 开源致谢与版本信息页

维护 `/credits`（开源致谢 / 更新日志 / 提交历史）、贡献模型署名或依赖许可证数据时查阅本文。页面布局与交互规范见 [Design §7.5](Design.md#75-版本信息与开源致谢页)，页面转场见 [Animation §2.4](Animation.md)，更新日志文案与版本结算见 [Commitment](Commitment.md)。

## 1. 页面与入口

- `/credits` 是完整页面，由主页页脚版本号进入（默认落在 `?tab=changelog`），标签顺序为「开源致谢 / 更新日志 / 提交历史」，当前标签写进 `?tab=`。
- 版本信息由完整页面承载，不得塞回弹窗。开合走跨页 View Transition 的专属形态（整页自底缘升起、关闭落回页脚），实现见 `Client/src/index.css` 的 `credits-page-rise` / `credits-page-sink` 与 `hooks/UsePageTransition` 的 `data-page-transition="credits"`。
- 页面外壳固定为视口高度，只有当前标签的内容区内部滚动；三段内容顺序固定为贡献模型 → 核心技术栈 → 依赖清单。

## 2. 数据来源

| 数据 | 真相源 | 时机 |
|---|---|---|
| 更新日志 | `Client/src/data/changelog.json`（经 `lib/Changelog.ts` 解析与排序） | 源码导入，构建期进产物 |
| 提交历史 | `virtual:commit-history`（`vite.config.ts` 的 `commit-history` 插件；优先 GitHub 接口，失败降级本地 git，再降级空数组） | 构建期 |
| 依赖清单 | `virtual:credits`（`vite.config.ts` 的 `credits-manifest` 插件） | 构建期扫描当前安装的依赖闭包 |
| 许可证原文 | `virtual:credits-licenses-<bucket>`（同一插件按包名首字母分桶） | 打开许可证抽屉时按桶懒加载 |
| 贡献模型 | `Client/src/data/CreditsContent.ts` 的 `CONTRIBUTING_MODELS` | 手写维护，见 §3 |
| 核心技术栈 | `Client/src/data/CreditsContent.ts` 的 `CORE_TECH_STACK` | 手写维护，版本从依赖清单取 |

依赖清单与许可证原文的契约在 `Client/src/lib/Credits.ts`，虚拟模块声明在 `Client/src/vite-env.d.ts`。依赖范围是 Client `package.json` 的 dependencies + devDependencies 及其传递依赖（运行时与开发依赖都列，传递依赖沿依赖链归类）；构建环境里装不到的 optional/平台包不会出现在清单中。清单按包名排序，许可原文按 `licenseBucket(name)` 分桶，打开一个包只下载它所在的那一桶。许可证原文不在页面上常驻渲染，只在右侧抽屉里按需查看。

依赖或版本变化不需要手工改清单：重新构建即从当前安装树重新生成；`credits-manifest` 插件新增包或新许可证类型时，分桶与筛选项都由数据自动派生。

## 3. 模型署名

`CONTRIBUTING_MODELS` 是「为本项目做出过实际改动的模型」的唯一定义处：

- **只在实际改动后署名**：提交过代码、数据、文档、样式或配置等仓库文件改动的模型，在完成改动后把自己的名字加入对应公司；仅参与讨论、咨询、评审或规划的不算，不要署名。
- **按公司与发布时间排**：公司顺序取数组声明顺序，同一公司的模型按 `releasedAt`（ISO 日期，只用于排序、不展示）从早到晚；展示前统一经 `lib/Credits.ts` 的 `sortModelsByRelease` 收口，数据文件里追加时不需要手动插到正确位置。
- **只写模型名**：不写分工、日期或宣传语；页面上除模型名外不渲染额外字段。
- **新增公司追加到末尾**：第一次出现在名单里的公司加在数组末尾，公司标签沿用其品牌名。
- 页面上写明「仅记录实际参与项目开发的大模型」与排序口径，避免读者把咨询也理解成贡献。

## 4. 展示约定

- **贡献模型**在核心技术栈上方，按公司分组，公司用首字方徽记与名称作组标题，模型名用 `Badge` 承载，组内按发布时间排序。
- **核心技术栈**是 8–12 张外链卡片：品牌图标、名称、项目内的职责与从依赖清单取到的实际版本；非 npm 运行时（Bun）不展示版本。图标用 `@icons-pack/react-simple-icons` 逐图标引入（`@icons-pack/react-simple-icons/icons/SiXxx`，聚合入口无法摇树），没有对应品牌图标的（Zustand、Elysia 等）回退 lucide 通用图标，不手绘、不用错误品牌。
- **依赖清单**是紧凑行列表：搜索即时过滤包名 / 版本 / License，License 用 `Select` 筛选（选项与计数由 `creditLicenseOptions` 派生，未知固定最后），右侧显示结果计数；没有命中时用虚线空状态与「清除筛选」。行可按压（`optionTappable`），点击打开许可证抽屉。
- **许可证抽屉**复用 `ui/Sheet`：右侧滑入、标题栏固定、内容独立滚动；先展示包元数据（名称、版本、License、简介、主页/仓库外链），再加载并展示每份许可证原文（等宽字体、保留换行）。加载中、未附带原文、加载失败（可重试）分别是独立状态；详情先出现，原文后到不推动布局。关闭后焦点回到触发的依赖行。
- 所有品牌图标只标注依赖/技术栈本身；指向站外平台的链接图标仍按 [Design §2](Design.md#2-技术基线) 走 FontAwesome。

## 5. 文件分布

| 文件 | 职责 |
|---|---|
| `Client/src/lib/Credits.ts` | 数据类型、许可证分桶、筛选与排序纯函数；构建期与客户端共用的契约 |
| `Client/src/lib/Credits.test.ts` | 上述纯函数的单测 |
| `Client/src/lib/CreditsLicenseLoader.ts` | 许可证原文的按桶懒加载与缓存（失败不缓存） |
| `Client/src/data/CreditsContent.ts` | 贡献模型与核心技术栈的唯一手写数据源 |
| `Client/src/lib/Changelog.ts` / `CommitHistory.ts` | 更新日志解析与提交历史数据契约（页面复用） |
| `Client/src/components/credits/` | 展示层：`CreditsView`、贡献模型、技术栈、依赖清单、许可证抽屉、更新日志/提交历史面板与夹具 |
| `Client/src/components/ui/Sheet.tsx` | 通用侧边抽屉（Radix Dialog + `sheetSlide`） |
| `Client/src/pages/CreditsPage.tsx` | 路由容器：读虚拟数据、版本号口径、标签状态写进 `?tab=` |
| `Client/src/vite-env.d.ts` | `virtual:credits` / `virtual:credits-licenses*` 的模块声明 |
| `Client/vite.config.ts` 的 `creditsManifestPlugin` | 构建期依赖闭包、许可证原文与分桶虚拟模块 |
| `Client/src/lib/CreditsPlugin.test.ts` | 用临时 fixture 目录验证闭包、归类、原文读取与分桶 |

## 6. 验证

改动数据管线（`vite.config.ts` 插件、虚拟模块、`lib/Credits.ts`）：

```bash
cd Client
npx vitest run src/lib/Credits.test.ts src/lib/CreditsPlugin.test.ts
npm run lint
npx tsc -b
npm run test:asset-smoke   # 构建插件变化时跑，覆盖生产构建与资源冒烟
```

改动页面、抽屉或卡片（`components/credits/`、`ui/Sheet.tsx`、`pages/CreditsPage.tsx`）：

```bash
cd Client
npx vitest run src/components/credits src/lib/Credits.test.ts
npm run lint
npx tsc -b
npm run build-storybook
npm run storybook:shots -- --filter 致谢
```

浏览器检查至少覆盖 390 / 900 / 1440 三档宽度、亮/暗主题、搜索无结果、License 筛选、抽屉的加载中/有原文/未附带原文三种状态，以及开启「减弱动效」后的开合；页面转场按 [Animation §8](Animation.md) 的验收清单核对。

## 7. 维护

- 改动确认的模型署名、依赖数据或展示约束，在对应修改点同步回本文与 `Client/src/data/CreditsContent.ts` 的注释，不只留在聊天或提交信息里。
- 新增技术栈条目只需改 `CORE_TECH_STACK`（名称、职责、外链、可选 `packageName`）；新增品牌图标时同步 `components/credits/CreditsIcons.tsx` 的映射，并优先使用 simple-icons 已有图标。
- 依赖清单的规模随安装树变化，不在页面或文档里写死依赖数量或包名列表。
