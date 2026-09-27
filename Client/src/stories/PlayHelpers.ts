/**
 * 故事的 play 用合成点击打开浮层或切换控件后，焦点停在被点的按钮上，
 * 浏览器会按键盘交互画出焦点环，真实的鼠标点击并不会。截图前把这类焦点移走；
 * 文本输入框保留焦点，真实交互里它们本来就显示聚焦态。
 */
export function dropFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !active.matches("input, textarea, [contenteditable='true']")) active.blur();
}
