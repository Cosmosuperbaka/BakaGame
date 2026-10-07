import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/MatchMedia";
import { VolumeControl } from "./VolumeControl";

afterEach(() => vi.unstubAllGlobals());

it("窄屏由图标按钮弹出音量滑块，弹出层里照常调节音量", async () => {
  const user = userEvent.setup();
  stubMatchMedia(false);
  const onVolumeChange = vi.fn();
  render(<VolumeControl volume={0.5} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "调节音量" }));
  const panel = await screen.findByRole("dialog", { name: "播放音量" });
  within(panel).getByRole("slider", { name: "播放音量" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(onVolumeChange).toHaveBeenCalledWith(0.51);
});

it("视口放大到 sm 时收起弹出层", async () => {
  const user = userEvent.setup();
  const media = stubMatchMedia(false);
  render(<VolumeControl volume={0.5} onVolumeChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "调节音量" }));
  expect(await screen.findByRole("dialog", { name: "播放音量" })).toBeInTheDocument();
  expect(media.queries).toContain("(min-width: 40rem)");
  act(() => media.crossBreakpoint(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("点图标静音，再点恢复到静音前的音量；拖到 0 后恢复到最近一次可听的音量", async () => {
  const user = userEvent.setup();
  stubMatchMedia(true);
  const onVolumeChange = vi.fn();
  const view = render(<VolumeControl volume={0.4} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "静音" }));
  expect(onVolumeChange).toHaveBeenLastCalledWith(0);
  view.rerender(<VolumeControl volume={0} onVolumeChange={onVolumeChange} />);
  expect(screen.getByRole("button", { name: "取消静音" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "取消静音" }));
  expect(onVolumeChange).toHaveBeenLastCalledWith(0.4);
});

it("进房时就是静音，取消静音回到默认音量", async () => {
  const user = userEvent.setup();
  stubMatchMedia(true);
  const onVolumeChange = vi.fn();
  render(<VolumeControl volume={0} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "取消静音" }));
  expect(onVolumeChange).toHaveBeenLastCalledWith(0.65);
});

it("点读数原地换成输入框，回车提交百分比、越界夹住，Esc 放弃", async () => {
  const user = userEvent.setup();
  stubMatchMedia(true);
  const onVolumeChange = vi.fn();
  render(<VolumeControl volume={0.26} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "音量 26%，点击输入" }));
  const input = screen.getByRole("textbox", { name: "输入音量百分比" });
  expect(input).toHaveValue("26");
  await user.clear(input);
  await user.type(input, "80{Enter}");
  expect(onVolumeChange).toHaveBeenLastCalledWith(0.8);
  expect(screen.queryByRole("textbox", { name: "输入音量百分比" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /点击输入/ }));
  await user.clear(screen.getByRole("textbox", { name: "输入音量百分比" }));
  await user.type(screen.getByRole("textbox", { name: "输入音量百分比" }), "250{Enter}");
  expect(onVolumeChange).toHaveBeenLastCalledWith(1);

  onVolumeChange.mockClear();
  await user.click(screen.getByRole("button", { name: /点击输入/ }));
  await user.type(screen.getByRole("textbox", { name: "输入音量百分比" }), "5{Escape}");
  expect(onVolumeChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "输入音量百分比" })).not.toBeInTheDocument();
});

it("读数只给读屏一份真实数值，滚轮字形不进文本", () => {
  stubMatchMedia(true);
  render(<VolumeControl volume={0.07} onVolumeChange={vi.fn()} />);
  const readout = screen.getByRole("button", { name: "音量 7%，点击输入" });
  expect(readout).toHaveTextContent(/^7%$/);
});
