import { expect, waitFor } from "storybook/test";

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
 * 等元素真的能接收指针再交给合成点击或输入：页面过渡与浮层入场期间，祖先会暂时关掉指针事件
 * （过渡中不响应点击是有意的），这时 userEvent 会直接报「pointer-events: none」。
 * 机器忙时过渡会拖长，所以按状态等，不按固定时长等。
 */
export async function untilPointerReady<T extends Element>(element: T): Promise<T> {
  await waitFor(() => expect(getComputedStyle(element).pointerEvents).not.toBe("none"), {
    timeout: 5000,
  });
  return element;
}
