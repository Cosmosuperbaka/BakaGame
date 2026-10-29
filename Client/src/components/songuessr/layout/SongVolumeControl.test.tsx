import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/MatchMedia";
import { SongVolumeControl } from "./SongVolumeControl";

afterEach(() => vi.unstubAllGlobals());

it("窄屏由图标按钮弹出音量滑块，弹出层里照常调节音量", async () => {
  const user = userEvent.setup();
  stubMatchMedia(false);
  const onVolumeChange = vi.fn();
  render(<SongVolumeControl volume={0.5} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "调节音量" }));
  const panel = await screen.findByRole("dialog", { name: "播放音量" });
  within(panel).getByRole("slider", { name: "播放音量" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(onVolumeChange).toHaveBeenCalledWith(0.51);
});

it("视口放大到 sm 时收起弹出层", async () => {
  const user = userEvent.setup();
  const media = stubMatchMedia(false);
  render(<SongVolumeControl volume={0.5} onVolumeChange={vi.fn()} />);
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
  const view = render(<SongVolumeControl volume={0.4} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "静音" }));
  expect(onVolumeChange).toHaveBeenLastCalledWith(0);
  view.rerender(<SongVolumeControl volume={0} onVolumeChange={onVolumeChange} />);
  expect(screen.getByRole("button", { name: "取消静音" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "取消静音" }));
  expect(onVolumeChange).toHaveBeenLastCalledWith(0.4);
});

it("进房时就是静音，取消静音回到默认音量", async () => {
  const user = userEvent.setup();
  stubMatchMedia(true);
  const onVolumeChange = vi.fn();
  render(<SongVolumeControl volume={0} onVolumeChange={onVolumeChange} />);
  await user.click(screen.getByRole("button", { name: "取消静音" }));
  expect(onVolumeChange).toHaveBeenLastCalledWith(0.65);
});

it("点读数原地换成输入框，回车提交百分比、越界夹住，Esc 放弃", async () => {
  const user = userEvent.setup();
  stubMatchMedia(true);
  const onVolumeChange = vi.fn();
  render(<SongVolumeControl volume={0.26} onVolumeChange={onVolumeChange} />);
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

it("读数按钮展示真实数值，无多余占位与字符", () => {
  stubMatchMedia(true);
  render(<SongVolumeControl volume={0.07} onVolumeChange={vi.fn()} />);
  const readout = screen.getByRole("button", { name: "音量 7%，点击输入" });
  expect(readout).toHaveTextContent(/^7$/);
});

it("所有整十音量（0–100）读数与无障本文本均精准匹配，绝不出现整十少 10 偏差", () => {
  stubMatchMedia(true);
  const tens = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (const t of tens) {
    const { unmount } = render(<SongVolumeControl volume={t / 100} onVolumeChange={vi.fn()} />);
    const readout = screen.getByRole("button", { name: `音量 ${t}%，点击输入` });
    expect(readout).toHaveTextContent(new RegExp(`^${t}$`));
    unmount();
  }
});

it("点击静音开关时平滑过渡音量显示值，手动交互时立即响应", async () => {
  const user = userEvent.setup();
  stubMatchMedia(true);
  const onVolumeChange = vi.fn();
  const { rerender } = render(<SongVolumeControl volume={0.65} onVolumeChange={onVolumeChange} />);
  const muteBtn = screen.getByRole("button", { name: "静音" });

  await user.click(muteBtn);
  expect(onVolumeChange).toHaveBeenLastCalledWith(0);
  rerender(<SongVolumeControl volume={0} onVolumeChange={onVolumeChange} />);

  // 动画平滑落定到 0，读数绝不悬留在 1
  await waitFor(() => {
    expect(screen.getByRole("slider", { name: "播放音量" })).toHaveAttribute("aria-valuenow", "0");
    const readout = screen.getByRole("button", { name: "音量 0%，点击输入" });
    expect(readout).toHaveTextContent(/^0$/);
  });
});
