# 开源致谢与版本信息页

维护 `/credits`（开源致谢 / 更新日志 / 提交历史）、参与开发的大模型名单、品牌图标或依赖许可证数据时查阅本文。页面布局与交互规范见 [Design §7.5](Design.md#75-版本信息与开源致谢页)，页面转场见 [Animation §2.4](Animation.md)，更新日志文案与版本结算见 [Commitment](Commitment.md)。

| 工作范围 | 查阅章节 |
|---|---|
| 页面入口、标签与转场 | §1 |
| 数据来源与虚拟模块 | §2 |
| 模型署名与品牌标识 | §3 |
| 展示约定、依赖两级列表与许可证抽屉 | §4 |
| 文件职责 | §5 |
| 验证 | §6 |
| 维护 | §7 |

## 1. 页面与入口

- `/credits` 是完整页面，由主页页脚版本号进入（默认落在 `?tab=changelog`），标签顺序为「开源致谢 / 更新日志 / 提交历史」，当前标签写进 `?tab=`。
- 版本信息由完整页面承载，不得塞回弹窗。开合走跨页 View Transition 的专属形态（整页自底缘升起、关闭落回页脚），实现见 `Client/src/index.css` 的 `credits-page-rise` / `credits-page-sink` 与 `hooks/UsePageTransition` 的 `data-page-transition="credits"`。
- 页面外壳固定为视口高度，只有当前标签的内容区内部滚动；三段内容顺序固定为「参与开发的大模型 → 核心技术栈 → 依赖清单」，三段 H2 标题下不加说明段。

## 2. 数据来源

| 数据 | 真相源 | 时机 |
|---|---|---|
| 更新日志 | `Client/src/data/changelog.json`（经 `lib/Changelog.ts` 解析与排序） | 源码导入，构建期进产物 |
| 提交历史 | `virtual:commit-history`（`vite.config.ts` 的 `commit-history` 插件；优先 GitHub 接口，失败降级本地 git，再降级空数组） | 构建期 |
| 依赖清单与依赖图 | `virtual:credits`（`vite.config.ts` 的 `credits-manifest` 插件） | 构建期扫描当前安装的依赖闭包 |
| 许可证原文 | `virtual:credits-licenses-<bucket>`（同一插件按包名首字母分桶） | 展开抽屉里的许可证区时按桶懒加载 |
| 参与开发的大模型 | `Client/src/data/CreditsContent.ts` 的 `CONTRIBUTING_MODELS` | 手写维护，见 §3 |
| 核心技术栈 | `Client/src/data/CreditsContent.ts` 的 `CORE_TECH_STACK` 与 `TECH_STACK_CATEGORIES` | 手写维护，版本从依赖清单取 |

依赖清单与许可证原文的契约在 `Client/src/lib/Credits.ts`，虚拟模块声明在 `Client/src/vite-env.d.ts`。依赖范围是 Client `package.json` 的 dependencies + devDependencies 及其传递依赖（运行时与开发依赖都收，传递依赖沿依赖链归类）；构建环境里装不到的 optional/平台包不会出现在清单中。

- 清单按包名排序，每个包带 `dependencies: string[]`：只收本次构建确实安装、且能在页面里点开的子依赖；依赖图用于二级抽屉逐级下钻，页面一级只渲染 `direct === true` 的主包。
- 包链接 `url` 只放行绝对 http(s)：`homepage` 优先，其次把 `repository` 的常见写法（`git+https://…`、`git@host:owner/repo.git`、`git://…`、`ssh://…`、`github:owner/repo`、裸 `owner/repo`）归一成仓库页；认不出的写法给空串，页面据此不渲染「项目主页」。不要把简写原样输出——`sindresorhus/globals` 这类值当 `href` 会解析成站内相对路径（`/credits/sindresorhus/globals`），点开是死链。
- 许可证原文按 `licenseBucket(name)` 分桶，展开某个包的许可证区时只下载它所在的一桶；原文不在页面上常驻渲染。
- 依赖或版本变化不需要手工改清单：重新构建即从当前安装树重新生成；新增包或新许可证类型时，分桶与筛选项都由数据自动派生。

## 3. 模型署名与品牌标识

`CONTRIBUTING_MODELS` 是「实际参与过本项目开发的大模型」的唯一定义处：

- **只在实际改动后署名**：提交过代码、数据、文档、样式或配置等仓库文件改动的模型，在完成改动后把自己的名字加入对应公司；仅参与讨论、咨询、评审或规划的不算，不要署名。
- **按公司与发布时间排**：公司顺序取数组声明顺序，同一公司的模型按 `releasedAt`（ISO 日期，只用于排序、不展示）从早到晚；展示前统一经 `lib/Credits.ts` 的 `sortModelsByRelease` 收口，数据文件里追加时不需要手动插到正确位置。
- **只写模型名**：不写分工、日期或宣传语；页面上除模型名、Logo 与发布页链接外不渲染额外字段。
- **发布页链接**：每条模型尽量带 `url`，点击徽章在新标签打开。选链优先级是「厂商官方新闻/公告页 → 官方文档的版本说明」；例如 `Deepseek V4.1 Flash` 指向官网新闻页、`1017` 指向文档站新闻页，只有 API 更新记录的 `0731` 才退到文档站更新日志，并且要深链到 `2026-07-31` 那一节（`#deepseek-v4-flash-更新`）——日志首页首屏是别的版本，浅链等于链错。确实没有公开页面时省略 `url`，徽章退化为静态标签而不是死链。
- **新增公司追加到末尾**：第一次出现在名单里的公司加在数组末尾；分组标题写公司或 AI 团队名（深度求索、智谱清言、OpenAI、Google DeepMind、腾讯混元、Anthropic、阿里千问），不写模型家族名。
- 每条数据都必须带 `logo`（`CreditBrandId`）：公司用厂商标识，模型用模型家族标识（Deepseek、GLM、GPT、Gemini、Hunyuan、Claude 等）。厂商与家族是两枚不同的官方字形时分别登记，不全部复用公司 Logo；两者相同时可以重复用同一个键（如 OpenAI 与 GPT）。

品牌标识统一走 `components/credits/CreditsIcons.tsx` 的 `CreditBrandMark`：

- 优先 `@icons-pack/react-simple-icons`，按 `icons/SiXxx` 逐图标子路径引入，不走聚合入口。
- AI 厂商与模型家族的字形来自 `@lobehub/icons-static-svg`（MIT，纯 SVG 资产包，无运行时依赖）：按 `@lobehub/icons-static-svg/icons/<name>.svg?url` 导入，交给 Vite 生成哈希资源 URL；页面以 CSS mask 渲染成单色（颜色跟随 `currentColor`），不直接贴彩色位图。覆盖 Deepseek、OpenAI、Google、Gemini、Anthropic、Claude、Zhipu、Z.ai（GLM）、Tencent、Hunyuan（Hy）、Alibaba、Qwen。
- simple-icons 与 LobeHub 都没有、但页面明确需要的官方字形才放进 `Client/public/assets/brands/`，同样以 mask 渲染：

| 文件 | 用途 | 来源 | 许可 |
|---|---|---|---|
| `elysia.svg` | Elysia 技术栈 | <https://elysiajs.com/assets/elysia.svg> | 官方站点资源，Elysia 项目 MIT |
| `playwright.svg` | Playwright 技术栈 | `devicon-plain/playwright`（Iconify） | Devicon MIT |
| `zustand.svg` | Zustand 技术栈 | `devicon-plain/zustand`（Iconify） | Devicon MIT |
| `jsdom.svg` | jsdom 依赖 | <https://github.com/jsdom/jsdom/blob/main/logo.svg> | jsdom 仓库 MIT |
| `orpc.svg` | `@orpc/*` 依赖 | <https://orpc.dev/icon.svg> | oRPC 项目 MIT |
| `sharp.svg` | sharp 依赖 | <https://github.com/lovell/sharp/blob/main/docs/public/sharp-logo-mono.svg> | logo 资源 CC0 1.0（sharp 本体 Apache-2.0） |
| `fontsource.svg` | `@fontsource*` 字体包 | <https://github.com/fontsource/fontsource/blob/main/website/public/logo.svg> | Fontsource MIT |

每个文件末尾用 HTML 注释登记来源 URL、许可证与改法；资产校验测试（`CreditsIcons.test.tsx`）会核对文件清单、SVG 形状、无脚本/外链与来源注释。npm 别名包（如 `typescript7`，实为 `npm:typescript@7`）与被别名的包共用同一品牌键。

- 品牌图标只标注依赖、技术栈或模型/厂商本身；指向站外平台的链接图标仍按 [Design §2](Design.md#2-技术基线) 走 FontAwesome。没有品牌字形的包/技术用 `lucide-react` 的通用图标回退，不用近似品牌顶替。
- 新增品牌的最小路径：在 `lib/Credits.ts` 的 `CreditBrandId` 加键 → 在 `CreditsIcons.tsx` 的映射里给出图标来源（simple-icons 子路径、图标包子路径或 `public/assets/brands` 资产）→ 在数据文件里引用。优先复用已引入的图标包，只有确实没有时才新增自备资产。

## 4. 展示约定

- **参与开发的大模型**在核心技术栈上方：按公司分组，布局为「厂商行」——左侧厂商 Logo、公司名与模型数，右侧模型徽章流式排列；每个模型徽章含模型家族 Logo 与名称，组内按发布时间排序。不展示日期、分工或说明文案。
- **核心技术栈**按 `TECH_STACK_CATEGORIES` 的四组顺序展示（前端、后端、脚手架、运维与开发辅助），每组一个小标题与卡片网格。卡片含品牌图标、名称、项目内的职责与按 `packageName` 取的实际版本；非 npm 运行时或非 Client 依赖不展示版本。整卡外链官方站点。
- **依赖清单一级只列直接依赖**：搜索即时过滤包名 / 版本 / License，License 用 `Select` 筛选（选项与计数由 `creditLicenseOptions` 派生，未知固定最后），右侧显示「N 个主包」计数；搜索、筛选、空状态都作用在主包上。行可按压（`optionTappable`），带子依赖数量提示，点击打开二级抽屉。
- **二级抽屉**（`ui/Sheet`）承担单个包的详情与下钻：
  - 面包屑/返回：从子依赖进入时显示「返回上一层」；
  - 包身份：品牌图标、包名、版本、License、直接/开发依赖标记与简介；
  - 跳转区：项目主页与 npm 页面是两枚等宽 `Button variant="outline"`（带图标），不是小号文字链；
  - 依赖构成：直接子依赖数与间接依赖数（间接依赖用 `collectTransitiveDependencyNames` 计算）；
  - 子依赖列表：每行可点，继续下钻；没有子依赖时给弱化文案；
  - 许可证原文：默认折叠，展开后才调用 `loadLicense`；加载中、未附带原文、加载失败（可重试）是独立状态；原文等宽字体折行、随抽屉滚动。
- 关闭抽屉后焦点回到触发的依赖行；抽屉动画使用 `sheetSlide`，下钻与折叠沿用现有列表 / `Collapsible` 动效。

## 5. 文件分布

| 文件 | 职责 |
|---|---|
| `Client/src/lib/Credits.ts` | 数据类型（含 `CreditBrandId`、依赖图与四组分类）、许可证分桶、筛选/排序/依赖闭包纯函数 |
| `Client/src/lib/Credits.test.ts` | 上述纯函数的单测 |
| `Client/src/lib/CreditsLicenseLoader.ts` | 许可证原文的按桶懒加载与缓存（失败不缓存） |
| `Client/src/data/CreditsContent.ts` | 参与开发的大模型、核心技术栈与分组标题的唯一手写数据源 |
| `Client/src/lib/Changelog.ts` / `CommitHistory.ts` | 更新日志解析与提交历史数据契约（页面复用） |
| `Client/src/components/credits/CreditsIcons.tsx` | `CreditBrandId` → 图标渲染、依赖包名映射与回退 |
| `Client/src/components/credits/` | 展示层：`CreditsView`、模型/技术栈/依赖清单、二级抽屉、更新日志/提交历史面板与夹具 |
| `Client/public/assets/brands/` | simple-icons 未提供的官方品牌 SVG（见 §3） |
| `Client/src/components/ui/Sheet.tsx` | 通用侧边抽屉（Radix Dialog + `sheetSlide`） |
| `Client/src/pages/CreditsPage.tsx` | 路由容器：读虚拟数据、版本号口径、标签状态写进 `?tab=` |
| `Client/src/vite-env.d.ts` | `virtual:credits` / `virtual:credits-licenses*` 的模块声明 |
| `Client/vite.config.ts` 的 `creditsManifestPlugin` | 构建期依赖闭包/依赖图、许可证原文与分桶虚拟模块 |
| `Client/src/lib/CreditsPlugin.test.ts` | 用临时 fixture 目录验证闭包、归类、依赖图、原文读取与分桶 |

## 6. 验证

验证范围与命令统一见 [Testing](Testing.md#验证范围)：数据管线改动对应「局部客户端逻辑」与「资源、构建插件」，页面改动对应「页面样式或动效」与「Storybook 故事」。

浏览器检查至少覆盖 390 / 900 / 1440 三档宽度、亮/暗主题、模型/技术栈分组、搜索无结果、License 筛选、一级清单只含主包、抽屉下钻与返回、许可证折叠展开后的加载中/有原文/未附带原文状态，以及开启「减弱动效」后的表现；页面转场按 [Animation §8](Animation.md) 的验收清单核对。

## 7. 维护

- 改动确认的模型署名、依赖数据或展示约束，在对应修改点同步回本文与 `Client/src/data/CreditsContent.ts` 的注释，不只留在聊天或提交信息里。
- 新增技术栈条目改 `CORE_TECH_STACK`（名称、职责、分类、外链、可选 `packageName`），同时确认 `CreditBrandMark` 能渲染对应 `icon`；新增品牌图标按 §3 的路径维护。
- 依赖清单的规模随安装树变化，不在页面或文档里写死依赖数量或包名列表；新增依赖不需要手工登记，构建期自动生成。
