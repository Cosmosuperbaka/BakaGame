# 动效设计规范

新增或修改按压反馈、浮层、过渡或动效令牌时使用本文。§2 是实现边界，§3 与 §5 用于选令牌；只有遇到对应缺陷时阅读 §4 解法，验收读 §7—§8。颜色与布局查 [Design](Design.md)，歌词原生动画查 [SonGuessrLyrics](SonGuessrLyrics.md)。

## 1. 根本原则：动效是编舞，不是出现方式

动效的职责不是「让元素好看地出现」，而是回答两个问题：

1. **什么导致了它** — 每段动画都必须能追溯到一个具体成因：用户的某次点击、服务端推送的某次状态变化、或某个元素的进出场。找不到成因的动画不加。
2. **它从哪来、到哪去** — 元素的起点与终点必须在空间上可解释。从屏幕中心凭空淡入、或凭空消失，都是不可接受的。

由此推出本规范的取舍标准：**界面是一个连续的空间，不是一叠互不相关的区块**。用户点击一个按钮后看到的一切，都应当读作那次点击在这个空间里引发的后果。

不满足上述条件的动画一律删除，而不是调参数。宁可没有动画，也不要有解释不通的动画。

## 2. 硬性约束

以下为不可协商的规则，违反即视为实现错误。

### 2.1 交互反馈覆盖

- 每个可点击组件都应接入项目既有反馈：按钮、列表、卡片、表格行、开关、标签页、浮层触发器及关闭入口均在此范围。公共组件已内置的反馈直接复用。
- 普通交互至少有按压态，仅有 hover 颜色变化不够。`Button` 的 `link` 变体沿用既有下划线反馈；`asChild` 由实际交互元素承担反馈，不叠加缩放。禁用/加载态及用户减弱动效偏好优先。
- 新增可点击元素时，在同次提交接入本节规定的反馈；上述公共组件例外直接复用既有行为。

### 2.2 禁止 `opacity + translateY` 批量 reveal

- **禁止**把 `opacity` 配 `translateY` 作为主要动画手段，尤其禁止对批量列表项施加统一纵向位移 —— 多行同时平移会产生「一堆东西一起飘进来」的廉价感。
- 列表项进场统一使用 `listItem`：以自身左缘为原点做等比缩放淡入，读作「被推到前面来」。要继承父级 `listContainer` 错峰的项只写 `variants={listItem}`，退场写对象 `exit={listItemExit}`，不写 `exit="exit"`：标签会让该项自成一级变体节点，不再继承起止与错峰。父级在加载完成时换 `key`，让整列从头错峰重播（大厅房间卡片与空状态）。
- 纵向位移只允许用于单个、有明确方向语义的元素（如日出图标自下升起、步进数字沿增减方向滑动），且必须是该元素独立的动作，不能是批量节奏的一部分。

### 2.3 除 hover 外必须引入非线性

- `hover` 可以使用简单的线性或匀速渐变（颜色、边框、阴影）。
- **其余所有动效**（点击反馈、点击后的过渡、进出场、布局变化、跨区域位移）必须是非线性的：使用 `spring.*` 弹性过渡，或 `duration.*` 配 `ease.*` 曲线。
- 禁止 `ease: "linear"`，例外只有两处：持续旋转的加载指示（`spinner`），匀速旋转本身就是「进行中」的正确表达；倒计时进度条（`countdownTickMs`），匀速走完才读作时间在流逝。
- 禁止 framer-motion 的字符串简写（`"easeOut"`、`"easeInOut"` 等），必须从 `lib/Motion.ts` 取值。

### 2.4 点击之间必须有状态延续或视觉因果

- 浮层必须表达来源。弹窗用 `useOriginTracker` 捕获触发按钮的视口中心，经 `Dialog` 的 `origin` 传入，由 `emergeFromOrigin` 自按钮位置展开；关闭时按原路收回，开合互为逆过程。
- 就近弹出层（Popover）使用 `popover`，缩放原点朝向触发元素：Radix 浮层在内容元素上加 `origin-(--radix-popover-content-transform-origin)`，由 Radix 按实际落位（含避让翻转）给出原点；不写死 `origin-top` 之类的方向。Popover 一律受控（`open` / `onOpenChange`），`Portal` 与 `Content` 都带 `forceMount`，外包 `AnimatePresence` 按 `open` 条件渲染，退场播完再卸载；不受控时 Radix 关闭即卸载，没有退场。
- 跨区域移动的同一个对象，必须是**同一个 DOM 元素在连续位移**，不允许用两个元素做交接。唯一例外是跨页：两页之间没有共用的节点，改由 View Transitions 把同名元素读作同一个对象，浏览器连续移动并交叉淡化（见下条）。
- 页面导航一律经 `hooks/UsePageTransition` 的 `usePageNavigate`（默认 `viewTransition: true`），路由必须是数据路由（`AppRouter.tsx` 的 `createBrowserRouter`，页面走路由级 `lazy`，分块到齐后才开始过渡）。旧页连同按下的触发元素定格成快照向前退出、新页自后方推入；回到更浅一层的页面（房间→大厅→主页，浏览器后退同理）时两层对调，方向由 `RootLayout` 写到 `<html data-page-direction>`。不再先等按压播完再导航，快照本身就保留了点击的结果。
  - 跨页共享元素用 `useSharedElementName(name, partner)` 取 `view-transition-name`，只在本次过渡的另一端是 `partner` 时命名：同一页上有多个候选（主页三张游戏卡、大厅每张房间卡）时，一律命名会重名，不相干的过渡里它们也会脱离整页单独淡出。现有两对：主页卡片标题 ↔ 大厅顶栏游戏名（`game-title`），大厅房间卡房名 ↔ 房间顶栏房名（`room-title`，单人模式不命名）。被命名的元素宽度要贴合内容（`w-fit`），否则整行留白会随快照一起缩放。
  - 只在一页出现的具名元素（手机上顶栏房名隐藏、CCB 大厅仍是骨架屏）由 `:only-child` 规则随整页退出或进入，不按共享元素的时长拖尾。
  - 经过渡到达的页面不再自己整页显影：`usePageTransitionEnds()` 非空时 `initial={false}`（`LobbyPage`），直接打开链接时照常显影。
  - 会改动当前页内容的副作用放在换页之后。离开房间先导航、房间页卸载后再退房（谁是卧底、猜歌在卸载 cleanup 里调 `leaveRoom`，CCB 由大厅挂载时退房并重新订阅）：先退再走，快照拍到的是清空后的加入中占位，清空还会触发「脱离房间」的 effect 再导航一次、打断进行中的过渡。退房回包可能晚于下一次进房，store 只清掉发起这次退房的会话。
  - 过渡期间页面不响应点击，时长即冻结时长：整页约 0.42s（`spring.swift`），带共享元素约 0.6s（`spring.settle`）。
- 折叠区域展开时，其触发标题的指示箭头必须同步翻转，两者是同一个状态的两种表现。
- 选中指示器（`SegmentedControl` 的胶囊底块、`Tabs` 的下划线、CCB 队伍面板的方块）是容器里唯一的一个 `ui/SlidingIndicator`，位置由 `hooks/UseIndicatorRect` 用 `offsetLeft` / `offsetWidth` 这类布局值量出，按 `indicatorSlide` 滑到新选中项；首次出现直接落位。不用 `layoutId` 交接：`layoutId` 按包围盒插值，所在弹窗正在缩放开合、或关闭后重新打开时，底块会从旧位置或屏幕别处飞进来。
- 搜索结果面板（`SearchCombobox`）按 `popover` 自输入框一侧展开；面板高度由 `hooks/UseMeasuredHeight` 量出内容的布局高度，按 `spring.settle` 补间，换一批结果、进出二级列表时平滑伸缩。旧的一批候选经 `AnimatePresence mode="popLayout"` 抽出文档流按序淡出，新的一批同时以 `listItem` 推入，两批交叉而不是先清空再出现。
- 标签内容切换用 `tabSwap`：方向取标签先后，新内容从目标标签一侧滑入、旧内容向另一侧让出，与底块同向；旧内容经 `AnimatePresence mode="popLayout"` 抽出文档流叠在原位，两块交叉而不是先清空再出现。并列面板取同一固定高度（更新日志弹窗两个标签都是 `h-[min(58vh,34rem)]`），切换时外层不跟着伸缩。
- 同一格里交替的两态（空状态 ↔ 表格、搜索栏或输入栏 ↔ 回执、占位 ↔ 图片、选项网格 ↔ 回执卡）放在同一个 `AnimatePresence mode="popLayout"`（或 `grid` 叠放）里交叉，不先清空再出现。回执用 `receiptCard`（退场走它的 `exit` 原路收回，不回弹），卡内对勾用 `receiptMarkFollow`；原点取被点的选项（`useOriginTracker`），没有点击来源（刷新后已提交）时从自身中心展开。回执下的从属段落晚一拍：外层 `delayChildren: followDelay`，内层 `listItem`。
- 两态共用同一个外框时（限时栏、读数块），内容用 `readoutSwap` 配 `popLayout` 交替，外框高度经 `useMeasuredHeight` 量出、按 `spring.settle` 补间，不先塌再撑开。
- 只会在末尾追加的标记串（CCB 猜测标记）用 `AnimatePresence initial={false}` 配 `receiptMark`：新标记落位，挂载时已有的不重播。新提交的猜测行用 `listItem` 加 `layout="position"`，旧行让位不缩放。
- 玩家栏换组（玩家 ↔ 旁观）是一次整列重排：玩家栏包在 `PlayerListLayout`（按实例命名的 `LayoutGroup`，桌面侧栏与抽屉互不串台）里，行传 `layoutId={player.id}`，从旧分组滑到新分组；两处 `SpectatorToggle` 共用一个 `layoutId`，入口随之滑到另一组，图标与文案以 `readoutSwap` 在途中换掉。分组标题与入口带 `layout="position"`，行列表用 `AnimatePresence mode="popLayout"`（行组件逐层转交 `ref`），退场行立即抽出文档流，其余行不等它淡完才让位。换组的行、让位的行、标题与入口统一取 `playerRelayout`（`spring.settle`），同时起步、同时落定。行的 `key` 取 `hooks/UsePlayerRowKeys`（玩家编号加换组次数），不直接用玩家编号：退场还没播完就换回原组时，同 key 的子项会被 `AnimatePresence` 原地复活，framer-motion 会把它停在 `initial` 的透明缩小态且不补播入场，行就此看不见；每换一次组换一个 key，换回来的总是新挂载的一行，跨组滑动仍由 `layoutId` 负责。

### 2.5 禁止写死数值

- 所有时长、曲线、弹性参数、缩放幅度只能取自 `Client/src/lib/Motion.ts`。
- 业务组件内不得出现裸数字时长、裸贝塞尔数组或自行编写的 `whileTap`；位移与缩放幅度（`y: 4`、`scale: 0.94` 之类）同样写成 §5 的具名变体，组件里只展开引用。等动画结束的 `setTimeout` 用 §5 的计时令牌，不写裸毫秒。
- 按压缩放不用 CSS `active:scale-*`：它没有过渡、按下松开都是硬切，也不受 `MotionConfig` 的减弱动效约束。Radix 触发器用 `asChild` 包一个 `motion.button` 接预设（如 `TabsTrigger`）。唯一例外是 `Switch` 滑块的 `group-active:scale-90`，见该组件注释。
- 需要新的动效语汇时，先在 `lib/Motion.ts` 中定义具名令牌并写清适用场景，再在组件中引用。
- CSS 侧只有一个来源：`installMotionTokens()`（应用入口与 Storybook 预览各调用一次）把 `ease.*`、`duration.*`（`none`、`hold` 除外）、每档 `spring.*` 解出的 `linear()` 曲线与静止时长、`popover` 起止尺度、跨页过渡的前后两层尺度写进 `:root`，变量名 `--motion-ease-out`、`--motion-duration-quick`、`--motion-spring-swift`、`--motion-spring-swift-duration`、`--motion-popover-enter-scale`、`--motion-page-behind-scale` 依此类推。`index.css` 不手写任何 `--motion-*` 值。减弱动效时只把 `--motion-spring-*-duration` 归零（弹性只驱动位移与缩放），颜色过渡保留。
- Tailwind 过渡类不写 `duration-*` / `ease-*`：`--default-transition-duration` 与 `--default-transition-timing-function` 已指向 `--motion-duration-quick`、`--motion-ease-out`。需要弹性观感的 CSS 过渡写 `duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)`（如 `Switch` 滑块）。
- 唯一的匀速补间是倒计时进度条：宽度在两次刷新之间按 `countdownTickMs` 匀速走完，读作连续流逝的时间。

### 2.6 禁止使用不存在的动画类

- 项目**未安装** `tailwindcss-animate`。`animate-in`、`animate-out`、`zoom-in-95`、`fade-out-0`、`slide-in-from-top-2` 等类名全部无效，写了等于没有动画。
- Radix 浮层的开合动画只有两种正确做法：
  - 能包 `AnimatePresence` 的（`Dialog`）由 framer-motion 接管，退出动画播完再卸载。
  - 只受 `data-state` 驱动、无法包裹的（`Select`、`Tooltip`）由 `index.css` 中的 `overlay-emerge` / `overlay-retract` 关键帧提供：尺度取 `--motion-popover-*-scale`，打开走 `--motion-spring-swift`，与 `popover` 变体同一组参数；内容元素带 `origin-(--radix-select-content-transform-origin)` / `origin-(--radix-tooltip-content-transform-origin)`，从触发元素一侧展开。

### 2.7 手势预设只在真正的交互元素上使用

- `pressable`、`tappable`、`selectable` 等预设都含 `whileTap`。framer-motion 见到带 `whileTap` 的元素且其 `tabIndex` 未定义时，会**自动补上 `tabIndex=0`**（`framer-motion` 的 `useHTMLProps`）。因此把预设挂在只承担动画的外层包裹元素上，会凭空多出一个 Tab 停靠点；全站统一焦点环之后，这个多余停靠点还会被画上聚焦框，肉眼可见。
- 规则：手势预设与 `role`、`tabIndex`、键盘事件挂在**同一个**元素上，让动画元素与被聚焦元素是同一个。整行可点的卡片（`RoomListCard`）把预设挂在外层 `motion.div`、`role="button"` 挂在内层 `Card` 时，外层必须显式写 `tabIndex={-1}`。
- 分段控件（`SegmentedControl`）的聚焦点在视觉隐藏的原生 `radio` 上，承载按压动画的 `label` 同样显式写 `tabIndex={-1}`，由 `index.css` 的 `label:has(> input.sr-only:focus-visible)` 把环画到 `label` 上。
- 验收：新增或改动带手势预设的组件后，用键盘逐次 Tab 走查该区域，确认每个可点元素**恰好占一个**停靠点，且停靠点都是可交互元素本身。

## 3. 六个维度

每段动效都要同时兼顾以下六项。缺失任一项都算实现不完整。

### 3.1 缓动

按「被移动物体的质量感」选择弹性档位，越轻的越快：

| 令牌 | 质量感 | 适用 |
|---|---|---|
| `spring.snap` | 最轻 | 按压、开关、标记切换、小控件即时反馈 |
| `spring.swift` | 轻 | 浮层、抽屉、弹窗、列表项进出 |
| `spring.settle` | 中 | 布局重排、面板宽高变化 |
| `spring.drift` | 重 | 跨区域长距离位移 |
| `spring.impulse` | 低阻尼 | 需要落位回弹的确认反馈 |

需要确定收束时间时（擦除、折叠、退出）才用 `duration.*` 配 `ease.*`：`ease.out` 用于进场与展开，`ease.inOut` 用于折叠与退出，`ease.emphasized` 用于跨区域强调位移。

### 3.2 延迟

- 延迟用于建立**因果次序**，不用于制造节奏感。
- 列表用 `listContainer(count)` 的 stagger 形成一次扫过的节奏，步长随数量收敛，避免长列表尾部等待过久。
- 确认反馈中，对勾略迟于卡片落位（约 60ms），读作「卡片先到位、确认再生效」。
- 折叠展开时不透明度略迟于高度，收起时反之：先褪去内容再收拢高度，避免内容被压扁。
- 任何延迟都不得推迟玩家的实际操作能力。

### 3.3 层级

- 同屏多个动画元素必须有明确的前后关系。阶段切换用 `phaseSwap`：新内容自后方推入（`scale` 0.97 → 1），旧内容继续向前退出（`scale` 1 → 1.03），尺度方向相反才能形成层次，而不是对称淡入淡出。
- 覆盖层背板（`backdrop`）先于内容出现、后于内容消失。
- `z-index` 层级与动画方向必须一致：向观察者靠近的元素层级更高。

### 3.4 物理感

- 元素的缩放原点必须落在它「实际被抓住」的位置：列表项用左缘，浮层用触发按钮，聊天气泡用发送方一侧的底角。
- 尺寸变化优先用 `transform: scale` 而非改动 `width` / `height` / `font-size`，保证过程中不触发重排、字形不模糊。
- 跨越大尺度差异时（如词语从 36px 缩到停靠尺寸），两端都渲染为清晰字形，中间过程只有 `transform` 在变。

### 3.5 声/触觉替代反馈

桌面端没有触觉马达，用尺度与位移替代按压手感。按压反馈必须落在**按下那一刻**，松手后由弹性过渡收回：

| 令牌 | 适用 |
|---|---|
| `pressable` | 常规可点击元素 |
| `pressableStrong` | 主要操作与危险操作，幅度更大 |
| `tappable` | 密集列表中的行内小控件，只按压不悬停缩放 |
| `iconTappable` | 图标按钮，配合底色变化 |
| `headerTappable` | 顶栏紧凑入口与整行折叠标题，只按压不悬停缩放，免得整行文字随指针晃动 |
| `optionTappable` | 浮层列表里的整行候选（搜索结果），幅度比 `tappable` 小得多：行宽接近浮层宽度，只读出「按下了」 |
| `selectable` | 选项卡片，按压时同时收缩与轻微下压 |

`Button` 已按变体内置分级反馈，`size="icon"` 不分变体自动取 `iconTappable`，其上不得再叠加缩放或手动展开预设。`link` 变体只保留下划线，不做尺度变化。

### 3.6 性能

- 只动 `transform` 与 `opacity`。`width`、`height`、`top`、`left`、`filter` 仅在无替代方案时使用，且必须限定作用范围。
- 长距离位移期间设置 `willChange`，动画结束后清除残留 `transform`，避免分数缩放导致文本子像素抖动（见 4.3）。
- `App.tsx` 顶层已配置 `<MotionConfig reducedMotion="user" />`（包在 `RouterProvider` 外层）：Framer Motion 按此偏好降低变换与布局动效，不代表所有 opacity、CSS 或原生动画都会自动停用。新增 CSS 关键帧动画必须自行包裹 `@media (prefers-reduced-motion: no-preference)`，Tailwind 的 `animate-pulse` 写成 `motion-safe:animate-pulse`。跨页过渡同理：减弱动效时 `index.css` 把全部 `::view-transition-*` 伪元素的动画置为 `none`，直接换页。Tailwind 的 `animate-spin` 等内置关键帧同样不受 MotionConfig 约束，加载指示一律用 `Spinner`：它走 `spinner` 令牌，减弱动效下静止。
- 循环动画只允许用于表达真实的持续状态（加载中、等待发言），不做纯装饰。

## 4. 三类问题的正确解法

以下三种缺陷曾在本项目出现过，其解法已固化为规范。

### 4.1 浮层没有来源

**错误表现**：更新日志、创建房间、房间设置弹窗直接出现，或从屏幕中心淡入。

**正确做法**：让浮层从触发按钮里被「吸出来」。

1. 触发处调用 `useOriginTracker()`，在 `onClick` 里 `capture(event)` 记录按钮的视口中心。
2. 把 `origin` 传给 `Dialog`。
3. `DialogContent` 内部经 `useOriginStyle` 把该点换算成浮层自身坐标系中的 `transform-origin`，配合 `emergeFromOrigin` 展开。
4. 关闭时沿同一原点收回，保证开合是同一动作的正反两面。

无法取得触发点位置时（如固定位置的浮动按钮），至少要把 `transformOrigin` 手动指向按钮所在方向，不允许留在中心。

### 4.2 跨区域位移不连续

**错误表现**：开局展示的词语从游戏区中央「瞬移」到顶栏。根因是两个不同元素通过 `layoutId` 交接，字号差异过大，交接瞬间字形被替换。

**正确做法**：全程只用一个元素。

- 词语始终以放大尺寸渲染，用 `position: fixed` 脱离文档流，通过 `x` / `y` / `scale` 在「游戏区居中」与「顶栏停靠」两个落点之间连续移动。
- 顶栏只放一个等尺寸的空占位元素，撑开布局空间，避免停靠时挤动相邻内容。
- 落点坐标由 `getBoundingClientRect` 实测，并监听 `resize` 与 `ResizeObserver` 重新测量，防止面板尺寸变化后停靠位漂移。
- 过渡取 `spring.drift`（质量最重的一档），符合大尺度位移的物理预期。

推广：**任何需要「元素 A 变成元素 B」的场景，都应改造成同一个元素在移动**，而不是两个元素交接。

### 4.3 动画结束后文本像素抖动

**错误表现**：阶段切换的文本渐显结束后，文字发生轻微的像素偏移闪现。

**根因**：弹性过渡收敛到 `scale: 1` 时残留极小的分数值（如 0.99997），浏览器对该状态下的文本按子像素栅格化，与 `scale` 完全移除后的栅格结果不同，交接瞬间即为可见抖动。

**正确做法**（两者必须同时做到）：

1. `phaseSwap` 的 `animate` 收紧 `restDelta` 与 `restSpeed`，让弹性更早判定为静止。
2. 动画结束回调中清空内联 `transform`，把渲染完全交还 CSS，消除残留变换。

任何对**含文本区块**做整体缩放的动画都必须执行这两步。

## 5. 编排变体清单

`lib/Motion.ts` 中的具名变体及其语义。新增变体必须在此登记。

| 变体 | 语义 |
|---|---|
| `listItem` / `listItemExit` | 列表项以左缘为原点缩放淡入；`listItemExit` 是同一退场的对象形式，继承父级错峰的项写 `exit={listItemExit}`（§2.2） |
| `listContainer(count)` | 子项按序进入，步长随数量收敛 |
| `phaseSwap` | 阶段切换，新内容自后推入、旧内容向前退出 |
| `indicatorSlide` | 选中指示器在选项之间滑动（`spring.swift`），见 §2.4 |
| `tabSwap` / `tabShift` | 标签内容横向交叉：`custom` 传方向（1 往后、-1 往前、0 只淡化），位移幅度 `tabShift` 只够读出方向 |
| `backdrop` | 覆盖层背板 |
| `popover` | 就近弹出层，自触发点方向展开 |
| `emergeFromOrigin` | 浮层自触发按钮位置被吸出，按原路收回 |
| `collapsible` | 折叠区域，高度与不透明度分离。不直接手写 `AnimatePresence` + `collapsible`：内容区用 `ui/Collapsible` 的 `CollapsibleRegion`（外层只补间高度，内边距与边框写在子元素上）。裁切只在补间期间生效：变体在展开落定后把 `overflow` 放回 `visible`、收起起步时切回 `hidden`，区内字段的悬停描边与 3px 聚焦晕光不被区域边缘切掉；调用处与 `SettingsSection` 不再自加 `overflow-hidden`，需要 BFC 时用 `flow-root`，指示箭头用 `DisclosureChevron`；行内折叠用 `Collapsible`，整行设置分组用 `SettingsAccordion`，不写原生 `<details>` |
| `wipeFromLeft` | 自左缘擦入的覆盖面板，读作「拉开」 |
| `ellipsisDot` | 等待占位省略号，三点依次浮起落回 |
| `sharedTransfer` | 跨区域共享元素位移 |
| `lyricOverview` | 原生歌词同节点位移与整体缩放共用时间轴 |
| `spinner` | 匀速持续旋转的加载指示，只经 `Spinner` 组件使用 |
| `urgentPulse` | 倒计时末段（≤10 秒）的图标脉动，表达「快到时间了」这一持续状态；`CountdownBadge` 与谁是卧底限时栏同一阈值与脉动。秒数逐秒以 `readoutTick` 换值（`CountdownBadge`） |
| `countdownTickMs` | 倒计时刷新步长，进度条宽度按同一时长匀速补间 |
| `popoverScale` | 就近弹出层起止尺度，`popover` 变体与 CSS 关键帧共用 |
| `springToCss` / `installMotionTokens` | 把令牌生成 `:root` 上的 CSS 变量（见 §2.5） |
| `spring.launch` | 聊天消息自输入框飞出（`chatMessageLaunch`），起步有力、轻微过冲 |
| `followDelay` | 从属元素晚主体一拍：回执卡内对勾、折叠区显影 |
| `receiptCard` / `receiptMark` / `receiptMarkFollow` | 提交回执：卡片回弹落位，对勾单独落位或晚一拍跟随卡片；`receiptCard.exit` 以确定时长原路收回起点、不回弹（撤销或换回输入栏），用法见 §2.4 |
| `wordDock` | 谁是卧底词语停靠顶栏时的缩放（`scale`），顶栏占位按同一比例预留宽高 |
| `readoutSwap` / `readoutTick` | 读数替换：离散替换（猜词槽、音量图标分档）自下顶上；步进器数值按增减方向取 `y` 的正负，新值顺着方向顶上来（`readoutTick`）。音量百分比这类连续跟手的读数用 `FollowNumber`：每位一只滚轮，位置由 `digitRoll.follow`（`spring.snap`）的弹簧驱动，目标变了带着当前速度续上，快速拖动不会像 `AnimatedNumber` 那样逐次重滚、互相打断而被吞掉；离散的分数变化仍用 `AnimatedNumber`。音量轨道粗细与滑块显隐走 CSS 的 `--motion-spring-snap` |
| `toastItem` / `bannerRise` / `dropIn` | 提示自右缘推入、横幅自底部升起、状态条自上方落下 |
| `sunrise` | 日出图标自下升起（§2.2 允许的单元素纵向位移） |
| `systemNotice` | 聊天系统提示从中线纵向展开 |
| `speechReveal` | 发言内容沿基线浮现并由失焦变清晰 |
| `scoreReveal` / `scoreRevealDelay` / `scoreRow` | 结算表逐行揭示：与 `listItem` 同一个入场，行距 `step` 比普通列表宽，名次才读得出先后；总跨度封顶在 `span`，人多时步长收窄。`ScoreTable` 逐行经 `custom` 传入 `scoreRevealDelay(index, count, ranked)`，不靠外层 stagger：按名次排列（`ranked`）自末行往上、第一名最后落定，按座次自上而下。`land` 是一行起播到大致落定的时长，行内数字从这时开始滚（`scoreRollDelay`） |
| `digitRoll` / `gainFloat` | 分数逐位滚动与「+N」浮标，只经 `ui/AnimatedNumber` 使用：每位一条竖排数字带，增加向上、减少向下滚到新值，跨过 9/0 接着滚而不倒转，个位先动、每高一位晚 `stagger`；「+N」只在增加时自分数旁弹起、停一拍后淡出（上升即「增加」，§2.2 允许的单元素位移）。真实数值始终留在文档流里，滚动时变透明撑住宽度与基线，上面叠 aria-hidden 的数字带，滚完即移除；装饰层的字形一律画在 `::before`（`data-glyph` 取值）里、不写文本节点，按文字查找、复制与读屏都只看到真实数值。玩家栏分数变化即滚、「+N」在上方；结算表的行给 `rollFrom` 起点，落定后滚（累计分从赛前分滚起、「+N」在左侧，增量列从 0 滚起、只滚不浮）。挂载时的值不算变化，换布局或开抽屉重新挂载不重播 |
| `winnerSweep` / `winnerSweepDelay` | 胜者扫光：整表揭示完（最晚一行落定、数字按 `digitRoll` 滚完之后），一道浅色光带自左向右扫过胜者行一次，不循环。只动 transform：光层挂在行首格里（`tr` 上的定位各浏览器不一致），宽度取滚动容器的 `100cqw` 横跨整行，`-z-10` 从文字底下经过、区块 `isolate` 兜住层叠；起止位移与光带渐变只占中间 30%–70% 配套，静止时整段停在行外，减弱动效下直接落到终点、看不见。胜者由各游戏给行标 `winner` |
| `contributorWash` / `contributorWashDelay` | 贡献者行的浅底：本局真正做出贡献的玩家（CCB 猜中者、猜歌本轮答对者）行落定后浮起常驻的 `primary/10` 浅底，读作「这几分是他挣的」而不是过后消失的提示，与扫光各说一件事（扫光说名次，浅底说出力）。定位与层叠同 `winnerSweep`（挂行首格、`100cqw`、`-z-10`）；延迟为行落定之后再一拍（`scoreRevealDelay` + `scoreReveal.land`），与行内数字同时起。只铺底色不加描边：这是流内区块，与行悬停的 `accent/40` 不同层。贡献者由各游戏给行标 `contributor`（CCB 取 `guesses` 的 `correct`，作品命中只拿 partial 分不算；猜歌取 `correctPlayerIds`） |
| `sealDrop` / `sealCard` | 结算答案卡的「落定 + 印章」：卡以 `sealCard`（`impulse`，`scale` 0.97→1）回弹落位，印章以 `sealDrop` 晚 `followDelay` 落在卡上——比 `receiptMark` 多出角度回正（-12°→-6°）与按落方向的一点位移（-3→0），读作被按下去而不是凭空弹出，低阻尼的 `impulse` 给出落力。只用于结算这类一次性揭晓，不循环；减弱动效下停在既定的 -6° 上，静态仍是一枚印。印章经 `ui/Seal` 渲染，整枚 `aria-hidden`（可读名由阶段标题给足），窄屏缩到 `size-14`、信息列让出 `pr-16` |
| `skeletonFade` | 骨架屏退场：数据到达时骨架原地淡出，真实内容在同一格里（外层 `grid`，两者都写 `[grid-area:1/1]`，真实内容后渲染、叠在上面）以各自的入场推上来，两者交叉而不是先清空再出现。骨架与真实内容共用布局（大厅是 `RoomCardLayout`），只淡出不缩放；骨架只在首屏出现，入场不播放，只定义退场 |
| `pageScale` | 跨页过渡的前后两层尺度（后方 `behind`、前方 `ahead`），`index.css` 的 `page-leave` / `page-arrive` 关键帧经 `--motion-page-*-scale` 取用，幅度约为 `phaseSwap` 的一半 |
| `roomEntrance` / `roomEntranceMs` | 进房编排：顶栏、玩家栏、游戏区、聊天栏按 `parts` 顺序每栏晚 `step` 就位，读作「房间被搭起来」。玩家栏、聊天栏自外侧边缘等比展开（`scale` 起点），顶栏与游戏区只显影（游戏区内容另有 `phaseSwap` 自后推入，两层不叠缩放）。`RoomShell` 只在挂载后第一帧起的 `roomEntranceMs` 内给根元素加 `data-room-entering`（跨页过渡会暂停渲染直到新页就绪，CSS 动画也从那一帧才起播；从挂载就计时，窗口会在聊天栏的弹性收尾前撤掉），关键帧在 `index.css`，各栏延迟变量由 `parts` 生成；四栏在各自的真实元素上写 `data-room-part`（`RoomHeader`、`PlayerColumn`、`ChatColumn`、游戏区 `main`，自己拼玩家栏的页面写在栏本体上），不加包装层，免得打断 `section > aside` 这类直接父子关系。窗口过后才挂载的栏（断线重连后补上、CCB 加入成功后才有的栏）直接出现，不重播 |
| `wordRevealTiming` / `springSettleMs(token)` | 计时器用的毫秒值：首日揭词的入场与停靠、等某档弹性静止后再改结构。组件里的 `setTimeout` 不写裸毫秒；结算表之外的分数滚动（猜歌单人的累计分）延迟取 `springSettleMs(sealCard.transition)`，等答案卡落定再滚 |

## 6. 状态反馈的边界

成功、失败、断线及异步提交反馈遵循 [Design §8](Design.md)，不靠动画替代业务状态。

未提交的发言用 `PendingSpeech` 循环省略号；已提交但顺序未到用 `SubmittedSpeech` 一次性对勾。前者等待玩家操作，后者等待揭示，不复用同一等待动画。

## 7. 可访问性

- 所有可点击元素除动效外，仍必须具备可见的键盘聚焦态、禁用态与进行中态。
- 图标按钮必须提供 `aria-label`；可展开元素必须提供 `aria-expanded`；切换类控件必须提供 `aria-pressed`。
- 动效不得成为传达状态的唯一手段，必须同时有文字、图标、边框或颜色配合。
- 系统开启「减弱动效」后，界面必须仍然完整可用，所有状态变化仍然可辨。

## 8. 验收清单

仅核对本次动效实现涉及的条目；纯文档改动按 Testing 的文档检查交付：

- [ ] 新增或修改的交互已接入 §2.1 规定的反馈，无重复缩放。
- [ ] 没有任何裸数字时长、裸贝塞尔数组或字符串缓动简写。
- [ ] 没有使用 `animate-in` 系列失效类名。
- [ ] 没有对批量列表项施加统一 `translateY`。
- [ ] 除 hover 外的动效均为非线性。
- [ ] 每个浮层都能说明它从哪个元素展开、收回到哪里。
- [ ] 跨区域移动的对象是同一个 DOM 元素；跨页的共享元素两端同名，且每次过渡里每个名字只出现一次。
- [ ] 对含文本区块做缩放的动画已清除残留 `transform`。
- [ ] 折叠区域的指示箭头与展开状态同步。
- [ ] [Testing](Testing.md#验证范围) 中对应的构建、静态检查与专项回归通过。
- [ ] 已在浏览器中检查窄屏、`md`、`xl` 三种布局，以及开启「减弱动效」后的表现。

## 9. 规范维护

- 用户后续追加的动效约束必须写入本文件。
- 新增动效令牌只同步第 5 节清单与 `Motion.ts`，Design 通过链接引用，不复制列表。
- 不得把尚未实现的设想写成当前规范；需要改变基线时，先完成并验证实现，再更新文档。
