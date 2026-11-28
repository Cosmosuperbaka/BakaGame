import { expect, screen, waitFor, within } from "storybook/test";

/**
 * 故事的 play 用合成点击打开浮层或切换控件后，焦点停在被点的按钮上，
 * 浏览器会按键盘交互画出焦点环，真实的鼠标点击并不会。截图前把这类焦点移走；
 * 文本输入框保留焦点，真实交互里它们本来就显示聚焦态。
 */
export function dropFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !active.matches("input, textarea, [contenteditable='true']"))
    active.blur();
}

/**
 * 等元素真的能接收指针再交给合成点击或输入：浮层入场与退场期间，元素或祖先会暂时关掉指针事件
 * （过渡中不响应点击是有意的），这时 userEvent 会直接报「pointer-events: none」。
 * 机器忙时过渡会拖长，所以按状态等，不按固定时长等。
 */
async function untilPointerReady<T extends Element>(element: T): Promise<T> {
  await waitFor(() => expect(getComputedStyle(element).pointerEvents).not.toBe("none"), {
    timeout: 5000,
  });
  return element;
}

/**
 * 找到弹窗或抽屉，等它能接收指针后返回其内部查询。故事里要在浮层里输入或点击时一律经由这里，
 * 不直接用 `screen.findByRole("dialog")`：Radix 的模态层挂载后先在副作用里把 body 设成
 * `pointer-events: none`，浮层自身的 `pointer-events: auto` 要等层登记后的下一次渲染才补上；
 * 这几帧里浮层已经能按角色查到，里面的输入框与按钮却继承了 none。
 */
export async function findDialog(name?: string | RegExp): Promise<ReturnType<typeof within>> {
  const dialog = await screen.findByRole("dialog", name === undefined ? undefined : { name });
  return within(await untilPointerReady(dialog));
}
