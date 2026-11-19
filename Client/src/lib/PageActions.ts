import type { SitePageCommand, SitePageResult } from "@bakagame/shared";
import { isAgentPagePath } from "@bakagame/shared/values";
import { agentPace } from "@/lib/motion/NamedMoves";
import {
  controlLabelOf,
  findPageControl,
  isOperable,
  primaryScroller,
  readPageView,
  SENSITIVE_SELECTOR,
} from "@/lib/PageView";
import { getAgentFocus, setAgentFocus, type AgentFocus } from "@/stores/UsePageControl";

/**
 * Agent 动作的执行端：所有动作都落在真实控件上，触发的是人类同样的事件与处理函数，
 * 校验、敏感词与游戏规则一条都绕不开。每一步先把焦点移到目标、停一拍再动手，
 * 人类看得出它要做什么；中途收回控制时立即停下。
 */
export interface PageActionContext {
  navigate: (path: string) => void;
  signal: AbortSignal;
}

class PageActionError extends Error {}

const refuse = (message: string): never => {
  throw new PageActionError(message);
};

const reducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PageActionError("接管已结束"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PageActionError("接管已结束"));
    };
    // 正常到点也要摘掉监听：接管期间 signal 常驻，逐字输入每个字都挂一个会无限增长。
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** 等页面安静下来：路由切换、弹窗展开与服务端回包都表现为 DOM 变化，定时刷新的页面靠上限兜底。 */
const waitForQuiet = (context: PageActionContext): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(limitTimer);
      observer.disconnect();
      context.signal.removeEventListener("abort", finish);
      resolve();
    };
    let quietTimer = setTimeout(finish, agentPace.quietMs);
    const limitTimer = setTimeout(finish, agentPace.quietLimitMs);
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, agentPace.quietMs);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    context.signal.addEventListener("abort", finish, { once: true });
  });

/** 底部留给接管条：目标压在收回入口下面时，人类看不清它要点什么。 */
const isOnScreen = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= window.innerHeight - agentPace.barReservePx;
};

/** 平滑滚动的终点不可知：连续两次采样位置不变才算到位。 */
const waitForScrollEnd = async (element: HTMLElement, signal: AbortSignal): Promise<void> => {
  let last = Number.NaN;
  for (let elapsed = 0; elapsed < agentPace.scrollLimitMs; elapsed += agentPace.scrollPollMs) {
    await wait(agentPace.scrollPollMs, signal);
    const top = element.getBoundingClientRect().top;
    if (top === last) return;
    last = top;
  }
};

/** 把目标带进视野，焦点框移过去，等人类看清再动手。 */
const approach = async (
  element: HTMLElement,
  action: AgentFocus["action"],
  context: PageActionContext
): Promise<void> => {
  if (!isOnScreen(element)) {
    element.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    await waitForScrollEnd(element, context.signal);
  }
  setAgentFocus({
    action,
    element,
    label: controlLabelOf(element),
    ...(element.dataset.agentControl ? { controlId: element.dataset.agentControl } : {}),
  });
  await wait(reducedMotion() ? agentPace.reducedMoveMs : agentPace.moveMs, context.signal);
};

/** 目标必须是人类此刻能操作的元素：过期的 id、隐藏、禁用与敏感区域都拒绝。 */
const resolveTarget = (id: string): HTMLElement => {
  const element = findPageControl(id);
  if (!element) return refuse(`当前页面没有控件 ${id}，先 page_state 看最新画面`);
  if (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  )
    return refuse(`控件 ${id} 当前不可用`);
  return element;
};

/** 链接只能留在站内可达范围：外链、下载与敏感页面都不替人类点开。 */
const assertLinkAllowed = (element: HTMLElement): void => {
  const link = element.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;
  if (link.hasAttribute("download")) refuse("不能下载文件");
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin || link.target === "_blank") refuse("不能打开站外链接");
  if (!isAgentPagePath(url.pathname)) refuse(`不在 Agent 可达位置内：${url.pathname}`);
};

const pointerEventOf = (type: string, init: MouseEventInit): Event =>
  typeof PointerEvent === "function"
    ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
    : new MouseEvent(type, init);

/** 完整回放一次按下：Radix 的下拉与标签页响应 pointerdown / mousedown，只调 click 不够。 */
const pressElement = (element: HTMLElement): void => {
  const rect = element.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 1,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  element.dispatchEvent(pointerEventOf("pointerdown", init));
  element.dispatchEvent(new MouseEvent("mousedown", init));
  element.focus({ preventScroll: true });
  const released = { ...init, buttons: 0 };
  element.dispatchEvent(pointerEventOf("pointerup", released));
  element.dispatchEvent(new MouseEvent("mouseup", released));
  element.click();
};

/** 绕过 React 的受控值追踪：直接赋值不触发 onChange，必须走原型上的 setter 再发 input。 */
const setFieldValue = (field: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "file"]);

const isTextField = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(element.type));

/** 真实键盘的 `code`：字母 `KeyX`、数字 `DigitN`、空格 `Space`，具名键（Enter、Escape……）与键名相同，其余字符没有对应物理键。 */
const codeOfKey = (key: string): string => {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === " " || key === "Space") return "Space";
  return /^[A-Za-z][A-Za-z0-9]+$/.test(key) ? key : "";
};

const fireKey = (element: Element, type: string, key: string): boolean =>
  element.dispatchEvent(
    new KeyboardEvent(type, {
      key: key === "Space" ? " " : key,
      code: codeOfKey(key),
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );

const appendChar = (field: HTMLInputElement | HTMLTextAreaElement, char: string): void => {
  if (field.maxLength > 0 && field.value.length >= field.maxLength) return;
  if (fireKey(field, "keydown", char)) setFieldValue(field, field.value + char);
  fireKey(field, "keyup", char);
};

const typeInto = async (
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  replace: boolean,
  context: PageActionContext
): Promise<void> => {
  if (field.readOnly || field.disabled) refuse("输入框当前不可编辑");
  field.focus({ preventScroll: true });
  if (replace) setFieldValue(field, "");
  const chars = Array.from(text);
  // 逐字节拍随长度收紧：长文本也要在一步的时限内打完。
  const interval = Math.min(
    agentPace.keyMaxMs,
    Math.max(agentPace.keyMinMs, agentPace.typeBudgetMs / Math.max(chars.length, 1))
  );
  for (const char of chars) {
    appendChar(field, char);
    await wait(interval, context.signal);
  }
};

const nextFocusable = (from: Element | null): HTMLElement | undefined => {
  const focusable = [
    ...document.querySelectorAll<HTMLElement>(
      "a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex='-1'])"
    ),
  ].filter(isOperable);
  const index = from instanceof HTMLElement ? focusable.indexOf(from) : -1;
  return focusable[index + 1] ?? focusable[0];
};

/** 按键的默认行为：合成事件不会触发浏览器默认动作，人类能得到的效果要在这里补上。 */
const applyKeyDefault = (target: Element, key: string): void => {
  if (key === "Tab") {
    nextFocusable(target)?.focus();
    return;
  }
  if (key === "Backspace" && isTextField(target)) {
    setFieldValue(target, target.value.slice(0, -1));
    return;
  }
  if (key !== "Enter" && key !== "Space") return;
  if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) {
    target.click();
    return;
  }
  if (key === "Enter" && target instanceof HTMLInputElement) target.form?.requestSubmit();
};

const pressKey = (target: Element, key: string): void => {
  if (fireKey(target, "keydown", key)) applyKeyDefault(target, key);
  fireKey(target, "keyup", key);
};

const currentTarget = (): Element => {
  const active = document.activeElement;
  if (!active || active === document.body) return document.body;
  if (active.closest(SENSITIVE_SELECTOR)) return refuse("当前焦点在受限区域");
  return active;
};

const selectNative = (element: HTMLSelectElement, value: string): void => {
  const option = [...element.options].find(
    (candidate) => candidate.value === value || candidate.textContent?.trim() === value
  );
  if (!option) return refuse(`没有选项：${value}`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
    element,
    option.value
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const setRangeInput = (element: HTMLInputElement, value: string): void => {
  setFieldValue(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

/** 滑杆只认键盘：按方向键走到目标值，值不再变化或步数到顶就停，防止目标不可达时空转。 */
const stepSlider = async (
  element: HTMLElement,
  value: string,
  context: PageActionContext
): Promise<void> => {
  const target = Number(value);
  if (!Number.isFinite(target)) refuse("滑杆的取值必须是数字");
  element.focus({ preventScroll: true });
  for (let step = 0; step < agentPace.sliderStepLimit; step += 1) {
    const current = Number(element.getAttribute("aria-valuenow"));
    if (current === target) return;
    pressKey(element, current < target ? "ArrowRight" : "ArrowLeft");
    await wait(agentPace.keyMinMs, context.signal);
    if (Number(element.getAttribute("aria-valuenow")) === current) return;
  }
};

/** 自绘下拉：点开、等选项出现、点中选项，和人类的两次点击一样。 */
const pickOption = async (
  element: HTMLElement,
  value: string,
  context: PageActionContext
): Promise<void> => {
  pressElement(element);
  await waitForQuiet(context);
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find(
    (candidate) => candidate.textContent?.trim() === value && isOperable(candidate)
  );
  if (!option) {
    pressKey(element, "Escape");
    return refuse(`没有选项：${value}`);
  }
  await approach(option, "select", context);
  pressElement(option);
};

const selectValue = async (
  element: HTMLElement,
  value: string,
  context: PageActionContext
): Promise<void> => {
  if (element instanceof HTMLSelectElement) return selectNative(element, value);
  if (element instanceof HTMLInputElement) return setRangeInput(element, value);
  if (element.getAttribute("role") === "slider") return stepSlider(element, value, context);
  return pickOption(element, value, context);
};

const scrollPage = (direction: SitePageCommand["direction"]): void => {
  const scroller = primaryScroller();
  const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
  const page = scroller.clientHeight * agentPace.scrollPageRatio;
  if (direction === "top") scroller.scrollTo({ top: 0, behavior });
  else if (direction === "bottom") scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  else scroller.scrollBy({ top: direction === "up" ? -page : page, behavior });
};

type ActionRunner = (command: SitePageCommand, context: PageActionContext) => Promise<void>;

const targetOf = (command: SitePageCommand): HTMLElement =>
  resolveTarget(command.control ?? refuse("缺少 control"));

const ACTIONS: Record<SitePageCommand["action"], ActionRunner> = {
  read: () => {
    // 看页面不换目标：框留在上一个控件上，刷新后找回的焦点也不会被一次读取冲掉。
    const { element, controlId } = getAgentFocus() ?? {};
    setAgentFocus({
      action: "read",
      ...(element ? { element } : {}),
      ...(controlId ? { controlId } : {}),
    });
    return Promise.resolve();
  },
  navigate: async (command, context) => {
    const path = command.path ?? refuse("缺少导航目标");
    if (!isAgentPagePath(path)) refuse(`不在 Agent 可达位置内：${path}`);
    setAgentFocus({ action: "navigate", label: path });
    await wait(reducedMotion() ? 0 : agentPace.dwellMs, context.signal);
    context.navigate(path);
  },
  click: async (command, context) => {
    const element = targetOf(command);
    assertLinkAllowed(element);
    await approach(element, "click", context);
    pressElement(element);
  },
  focus: async (command, context) => {
    const element = targetOf(command);
    await approach(element, "focus", context);
    element.focus({ preventScroll: true });
  },
  type: async (command, context) => {
    const field = command.control ? targetOf(command) : currentTarget();
    if (!isTextField(field)) return refuse("目标不是输入框，先 focus 到输入框");
    await approach(field, "type", context);
    await typeInto(field, command.text ?? "", command.replace === true, context);
  },
  press: async (command, context) => {
    const target = command.control ? targetOf(command) : currentTarget();
    const key = command.key ?? "Enter";
    // 回车和空格等于点击：焦点停在链接上时同样不能绕过站外与敏感页面的限制。
    if (target instanceof HTMLElement && (key === "Enter" || key === "Space"))
      assertLinkAllowed(target);
    if (target instanceof HTMLElement && target !== document.body)
      await approach(target, "press", context);
    pressKey(target, key);
  },
  select: async (command, context) => {
    const element = targetOf(command);
    await approach(element, "select", context);
    await selectValue(element, command.value ?? "", context);
  },
  scroll: async (command, context) => {
    if (command.control) {
      await approach(targetOf(command), "scroll", context);
      return;
    }
    setAgentFocus({ action: "scroll" });
    scrollPage(command.direction);
    await wait(reducedMotion() ? 0 : agentPace.scrollSettleMs, context.signal);
  },
};

/**
 * 受限页面上只能读取和离开：按钮也可能把页面带过去，或者人类本来就停在那里，
 * 只查链接目标拦不住，而 Tab 加回车不需要控件 id 就能盲操作。
 */
const assertPageAllowed = (action: SitePageCommand["action"]): void => {
  if (action === "read" || action === "navigate") return;
  const { pathname } = window.location;
  if (!isAgentPagePath(pathname)) refuse(`不在 Agent 可达位置内：${pathname}`);
};

/** 执行一步并回报结果。失败也带上最新画面：Agent 看的多半是旧状态，要能立刻重新决策。 */
export async function runPageCommand(
  command: SitePageCommand,
  context: PageActionContext
): Promise<SitePageResult> {
  try {
    assertPageAllowed(command.action);
    await ACTIONS[command.action](command, context);
    if (command.action !== "read" && !command.withView) return { id: command.id, ok: true };
    await waitForQuiet(context);
    return { id: command.id, ok: true, view: readPageView() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "页面执行失败";
    return { id: command.id, ok: false, error: message.slice(0, 160), view: readPageView() };
  }
}
