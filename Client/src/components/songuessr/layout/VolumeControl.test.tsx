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
