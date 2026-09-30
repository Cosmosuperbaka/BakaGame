import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SettingSelect, SettingStepper, SettingSwitchRow } from "./SettingFields";

it("开关行用可见标签命名开关，说明挂为开关的描述", () => {
  render(<>
    <SettingSwitchRow label="天使" description="8 人开启" checked={false} disabled onCheckedChange={vi.fn()} />
    <SettingSwitchRow label="允许旁观" checked onCheckedChange={vi.fn()} />
  </>);
  const angel = screen.getByRole("switch", { name: "天使" });
  expect(angel).toHaveAccessibleDescription("8 人开启");
  expect(angel).toBeDisabled();
  expect(screen.getByRole("switch", { name: "允许旁观" })).toHaveAccessibleDescription("");
});

it("步进输入框由可见标签连同单位命名，手动输入在失焦时夹到范围内再提交", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SettingStepper label="每次行动限时" description="设为 0 表示不限行动时间。" unit="秒" value={0} minimum={0} maximum={120} step={10} onChange={onChange} />);
  const input = screen.getByRole("textbox", { name: "每次行动限时（秒）" });
  expect(input).toHaveAccessibleDescription("设为 0 表示不限行动时间。");
  expect(screen.getByRole("button", { name: "减少每次行动限时" })).toBeDisabled();

  await user.clear(input);
  await user.type(input, "500");
  expect(onChange).not.toHaveBeenCalled();
  await user.tab();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(120);
});

it("下拉选择的可见标签命名触发器，没有候选时整项禁用", () => {
  render(<SettingSelect label="指定出题人" value="" options={[{ value: "", label: "暂无可选出题人" }]} disabled onChange={vi.fn()} />);
  const trigger = screen.getByRole("combobox", { name: "指定出题人" });
  expect(trigger).toBeDisabled();
  expect(trigger).toHaveTextContent("暂无可选出题人");
});
