import type { GameId, SitePageControl, SitePageView } from "@bakagame/shared";
import { gameOfPath, isAgentPagePath, roomIdOfPath } from "@bakagame/shared/values";

/**
 * Agent 看到的页面：只从渲染好的 DOM 取人类此刻能看到的内容。
 *
 * 这里没有任何后门：不读 Store、不读存储、不读隐藏节点。服务端本来就不把他人的答案发给
 * 这张标签页，页面上没有的东西 Agent 也看不到；页面上有但人类看不到的（隐藏、透明、模糊、
 * 屏幕阅读器专用），这里同样跳过。带 `data-agent-sensitive` 的区域对 Agent 不存在，
 * `data-agent-layer` 是接管层自己。
 */
const MAX_LINE_LENGTH = 400;
const MAX_LINES = 240;
const MAX_OFFSCREEN_LINES = 120;
const MAX_TEXT = 12_000;
const MAX_CONTROLS = 120;
const MAX_LABEL = 80;
const MAX_OPTIONS = 32;

const CONTROL_ID = /^[A-Za-z0-9_.:-]{1,96}$/;

export const SENSITIVE_SELECTOR = "[data-agent-sensitive]";
const OFF_LIMITS_SELECTOR = `${SENSITIVE_SELECTOR},[data-agent-layer]`;

const SKIPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "AUDIO",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
]);

const CONTROL_ROLES = [
  "button",
  "link",
  "checkbox",
  "switch",
  "radio",
  "tab",
  "menuitem",
  "option",
  "combobox",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
];
const LEAF_CONTROL_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  ...CONTROL_ROLES.map((role) => `[role='${role}']`),
].join(",");

const clip = (text: string, limit: number): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
};

/** 屏幕阅读器专用文本：布局上压成一个像素，人类看不到。 */
const isVisuallyClipped = (element: HTMLElement, style: CSSStyleDeclaration): boolean => {
  if (style.position !== "absolute") return false;
  const rect = element.getBoundingClientRect();
  return rect.width <= 1 && rect.height <= 1;
};

const isHiddenFromHuman = (element: HTMLElement, style: CSSStyleDeclaration): boolean =>
  SKIPPED_TAGS.has(element.tagName) ||
  Boolean(element.hidden) ||
  element.hasAttribute("inert") ||
  element.getAttribute("aria-hidden") === "true" ||
  element.matches(OFF_LIMITS_SELECTOR) ||
  style.display === "none" ||
  style.visibility === "hidden" ||
  style.visibility === "collapse" ||
  style.opacity === "0" ||
  (style.filter ?? "").includes("blur") ||
  isVisuallyClipped(element, style);

const isInViewport = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  return (
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
};

/** 控件在页面生命周期内的短 id；重新渲染出的新节点拿新的 id，旧的自然失效。 */
const refOf = new WeakMap<HTMLElement, string>();
const refTargets = new Map<string, WeakRef<HTMLElement>>();
let refSeq = 0;

const assignRef = (element: HTMLElement): string => {
  const existing = refOf.get(element);
  if (existing) return existing;
  refSeq += 1;
  const id = `e${refSeq}`;
  refOf.set(element, id);
  refTargets.set(id, new WeakRef(element));
  return id;
};

const controlIdOf = (element: HTMLElement, taken: Set<string>): string => {
  const named = element.dataset.agentControl;
  // 同一控件在宽窄布局各有一份时只有第一份能用语义 id，其余退回短 id。
  if (named && CONTROL_ID.test(named) && !taken.has(named)) return named;
  return assignRef(element);
};

const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  password: "password",
  search: "searchbox",
  submit: "button",
  button: "button",
};

const TAG_ROLES: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  SELECT: "select",
  TEXTAREA: "textbox",
  SUMMARY: "button",
};

const roleOf = (element: HTMLElement): string => {
  const declared = element.getAttribute("role");
  if (declared) return declared.slice(0, 24);
  if (element instanceof HTMLInputElement) return INPUT_ROLES[element.type] ?? "textbox";
  if (element.isContentEditable) return "textbox";
  return TAG_ROLES[element.tagName] ?? "clickable";
};

const labelledBy = (element: HTMLElement): string | undefined => {
  const ids = element.getAttribute("aria-labelledby");
  if (!ids) return undefined;
  const text = ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  return clip(text, MAX_LABEL) || undefined;
};

const formLabel = (element: HTMLElement): string | undefined => {
  const labels = (element as HTMLInputElement).labels;
  const text = labels?.[0]?.textContent;
  return text ? clip(text, MAX_LABEL) || undefined : undefined;
};

export const controlLabelOf = (element: HTMLElement): string =>
  clip(element.getAttribute("aria-label") ?? "", MAX_LABEL) ||
  labelledBy(element) ||
  formLabel(element) ||
  clip((element as HTMLInputElement).placeholder ?? "", MAX_LABEL) ||
  clip(element.title ?? "", MAX_LABEL) ||
  clip(element.textContent ?? "", MAX_LABEL);

const NEVER_READ_INPUT_TYPES = new Set(["password", "checkbox", "radio"]);

const rangedValueOf = (element: HTMLElement): string | null =>
  element.getAttribute("aria-valuetext") ?? element.getAttribute("aria-valuenow");

/**
 * 控件当前值的读取表，按顺序取第一个命中的。表首的条目不可挪动：
 * 密码类输入框永不读取，Agent 只需要知道它存在，填过什么不该再带出去；勾选类的状态走 `states`。
 */
const VALUE_READERS: ReadonlyArray<
  readonly [
    matches: (element: HTMLElement) => boolean,
    read: (element: HTMLElement) => string | undefined,
  ]
> = [
  [(e) => e instanceof HTMLInputElement && NEVER_READ_INPUT_TYPES.has(e.type), () => undefined],
  [
    (e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement,
    (e) => {
      const { value } = e as HTMLInputElement;
      return value ? clip(value, MAX_LINE_LENGTH) : undefined;
    },
  ],
  [
    (e) => e instanceof HTMLSelectElement,
    (e) =>
      clip((e as HTMLSelectElement).selectedOptions[0]?.textContent ?? "", MAX_LABEL) || undefined,
  ],
  [(e) => Boolean(rangedValueOf(e)), (e) => clip(rangedValueOf(e) ?? "", MAX_LABEL)],
  [
    (e) => e.getAttribute("role") === "combobox" || e.isContentEditable,
    (e) => clip(e.textContent ?? "", MAX_LINE_LENGTH) || undefined,
  ],
];

const controlValueOf = (element: HTMLElement): string | undefined =>
  VALUE_READERS.find(([matches]) => matches(element))?.[1](element);

const ARIA_STATES: ReadonlyArray<readonly [string, string, string]> = [
  ["aria-checked", "true", "checked"],
  ["aria-selected", "true", "selected"],
  ["aria-expanded", "true", "expanded"],
  ["aria-pressed", "true", "pressed"],
  ["aria-disabled", "true", "disabled"],
  ["aria-current", "page", "current"],
];

const controlStatesOf = (element: HTMLElement): string[] => {
  const states = ARIA_STATES.filter(
    ([attribute, value]) => element.getAttribute(attribute) === value
  ).map(([, , state]) => state);
  const field = element as HTMLInputElement;
  if (field.disabled === true && !states.includes("disabled")) states.push("disabled");
  if (field.checked === true && !states.includes("checked")) states.push("checked");
  if (field.readOnly === true) states.push("readonly");
  if (field.required === true) states.push("required");
  return states.slice(0, 8);
};

const describeControl = (element: HTMLElement, taken: Set<string>): SitePageControl => {
  const id = controlIdOf(element, taken);
  taken.add(id);
  const value = controlValueOf(element);
  const states = controlStatesOf(element);
  const options =
    element instanceof HTMLSelectElement
      ? [...element.options]
          .slice(0, MAX_OPTIONS)
          .map((option) => clip(option.textContent ?? "", MAX_LABEL))
      : undefined;
  return {
    id,
    role: roleOf(element),
    label: controlLabelOf(element),
    inView: isInViewport(element),
    ...(value ? { value } : {}),
    ...(options ? { options } : {}),
    ...(states.length > 0 ? { states } : {}),
  };
};

interface Collector {
  lines: string[];
  offscreenLines: string[];
  controls: SitePageControl[];
  taken: Set<string>;
  buffer: string;
  bufferInView: boolean;
  chars: number;
  truncated: boolean;
}

const pushLine = (collector: Collector, line: string, inView: boolean): void => {
  const target = inView ? collector.lines : collector.offscreenLines;
  const limit = inView ? MAX_LINES : MAX_OFFSCREEN_LINES;
  if (target.at(-1) === line) return;
  if (target.length >= limit || collector.chars + line.length > MAX_TEXT) {
    collector.truncated = true;
    return;
  }
  target.push(line);
  collector.chars += line.length;
};

const flushLine = (collector: Collector): void => {
  const line = clip(collector.buffer, MAX_LINE_LENGTH);
  collector.buffer = "";
  if (line) pushLine(collector, line, collector.bufferInView);
};

const appendText = (collector: Collector, text: string, owner: Element): void => {
  if (!text.trim()) return;
  if (!collector.buffer) collector.bufferInView = isInViewport(owner);
  collector.buffer += text;
};

const isBlockLevel = (style: CSSStyleDeclaration): boolean =>
  !style.display.startsWith("inline") && style.display !== "contents";

/** 没有语义的可点元素（卡片、行）只能靠光标判断；继承来的 pointer 算在父元素头上。 */
const isPointerTarget = (element: HTMLElement, style: CSSStyleDeclaration): boolean => {
  if (style.cursor !== "pointer") return false;
  const parent = element.parentElement;
  return !parent || getComputedStyle(parent).cursor !== "pointer";
};

const collectControl = (
  element: HTMLElement,
  style: CSSStyleDeclaration,
  collector: Collector
): boolean => {
  const leaf = element.matches(LEAF_CONTROL_SELECTOR);
  if (leaf || element.dataset.agentControl !== undefined || isPointerTarget(element, style))
    collector.controls.push(describeControl(element, collector.taken));
  return leaf;
};

const visitElement = (element: Element, collector: Collector): void => {
  if (!(element instanceof HTMLElement)) return;
  const style = getComputedStyle(element);
  if (isHiddenFromHuman(element, style)) return;
  const block = isBlockLevel(style);
  if (block) flushLine(collector);
  if (element instanceof HTMLImageElement && element.alt)
    appendText(collector, `[图片：${element.alt}]`, element);
  if (!collectControl(element, style, collector)) visitChildren(element, collector);
  if (block) flushLine(collector);
};

const visitChildren = (parent: HTMLElement, collector: Collector): void => {
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) appendText(collector, child.textContent ?? "", parent);
    else if (child.nodeType === Node.ELEMENT_NODE) visitElement(child as Element, collector);
  }
};

/** 最上层的弹窗：Agent 据此知道当前被什么挡着；敏感弹窗只说「受限」，不带标题。 */
const topDialogOf = (): string | undefined => {
  const dialogs = [
    ...document.querySelectorAll<HTMLElement>("[role='dialog'],[role='alertdialog']"),
  ];
  const top = dialogs.at(-1);
  if (!top) return undefined;
  if (top.closest(SENSITIVE_SELECTOR)) return "受限内容";
  return labelledBy(top) ?? (clip(top.getAttribute("aria-label") ?? "", MAX_LABEL) || "弹窗");
};

/**
 * 页面实际滚动的容器：多数页面滚的是文档，房间页滚的是内层面板。
 * 取可滚动距离最大的一个，人类滚轮落在哪里 Agent 就滚哪里。
 */
export const primaryScroller = (): HTMLElement => {
  const fallback = (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  if (fallback.scrollHeight > fallback.clientHeight + 1) return fallback;
  const candidates = [
    ...document.querySelectorAll<HTMLElement>("main,[data-scroll-region]"),
  ].filter((element) => element.scrollHeight > element.clientHeight + 1);
  candidates.sort(
    (left, right) =>
      right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight)
  );
  return candidates[0] ?? fallback;
};

const locationOf = (pathname: string): { game?: GameId; roomId?: string } => {
  const game = gameOfPath(pathname);
  const roomId = roomIdOfPath(pathname);
  return { ...(game ? { game } : {}), ...(roomId ? { roomId } : {}) };
};

const focusedControlId = (controls: readonly SitePageControl[]): string | undefined => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return undefined;
  const id = active.dataset.agentControl ?? refOf.get(active);
  return id && controls.some((control) => control.id === id) ? id : undefined;
};

const restrictedView = (path: string): SitePageView => ({
  path,
  title: "",
  restricted: true,
  scroll: { top: 0, max: 0, viewport: 0 },
  lines: [],
  offscreenLines: [],
  controls: [],
});

const pruneRefs = (): void => {
  for (const [id, target] of refTargets) if (!target.deref()?.isConnected) refTargets.delete(id);
};

const collectPage = (): Collector => {
  pruneRefs();
  const collector: Collector = {
    lines: [],
    offscreenLines: [],
    controls: [],
    taken: new Set(),
    buffer: "",
    bufferInView: true,
    chars: 0,
    truncated: false,
  };
  visitChildren(document.body, collector);
  flushLine(collector);
  return collector;
};

export const readPageView = (): SitePageView => {
  const pathname = window.location.pathname;
  const path = pathname.slice(0, 96) || "/";
  if (!isAgentPagePath(pathname)) return restrictedView(path);
  const scroller = primaryScroller();
  const collector = collectPage();
  // 视口内的控件排在前面：超出上限时先舍弃要滚动才看得到的。
  const controls = [
    ...collector.controls.filter((control) => control.inView),
    ...collector.controls.filter((control) => !control.inView),
  ];
  if (controls.length > MAX_CONTROLS) collector.truncated = true;
  const kept = controls.slice(0, MAX_CONTROLS);
  const dialog = topDialogOf();
  const focused = focusedControlId(kept);
  return {
    path,
    title: document.title.slice(0, 64),
    ...locationOf(pathname),
    ...(dialog ? { dialog } : {}),
    ...(focused ? { focused } : {}),
    scroll: {
      top: Math.round(scroller.scrollTop),
      max: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
      viewport: Math.round(scroller.clientHeight),
    },
    lines: collector.lines,
    offscreenLines: collector.offscreenLines,
    controls: kept,
    ...(collector.truncated ? { truncated: true } : {}),
  };
};

/**
 * 人类此刻能不能操作这个元素：隐藏、敏感区域与接管层都不算。
 * 与读视图共用同一个「对人不可见」判据，沿祖先链逐个核对：视图里没有列出的控件，
 * 即使 Agent 猜中它的语义名也操作不了。
 */
export const isOperable = (element: HTMLElement): boolean => {
  if (!element.isConnected) return false;
  if (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  ) {
    return false;
  }
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (isHiddenFromHuman(node, getComputedStyle(node))) return false;
  }
  return true;
};

const namedControls = (id: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>("[data-agent-control]")].filter(
    (element) => element.dataset.agentControl === id
  );

/** 按 id 找到页面上真正可操作的那一个元素；找不到就是 Agent 看的是旧画面。 */
export const findPageControl = (id: string): HTMLElement | null => {
  const named = namedControls(id).find(isOperable);
  if (named) return named;
  const referenced = refTargets.get(id)?.deref();
  return referenced && isOperable(referenced) ? referenced : null;
};

/** 焦点框用：刷新后只剩语义 id 可用，节点还没渲染出来就返回空，由焦点层继续等。 */
export const findControlForFocus = (id: string): HTMLElement | null =>
  namedControls(id).find(isOperable) ?? null;
