import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  SettingSelect,
  SettingStepper,
  SettingSwitchRow,
  SettingTextField,
  SettingYearRange,
} from "./SettingFields";

it("开关行用可见标签命名开关，说明挂为开关的描述", () => {
  render(
    <>
      <SettingSwitchRow
        label="天使"
        description="8 人开启"
        checked={false}
        disabled
        onCheckedChange={vi.fn()}
      />
      <SettingSwitchRow label="允许旁观" checked onCheckedChange={vi.fn()} />
    </>
  );
  const angel = screen.getByRole("switch", { name: "天使" });
  expect(angel).toHaveAccessibleDescription("8 人开启");
  expect(angel).toBeDisabled();
  expect(screen.getByRole("switch", { name: "允许旁观" })).toHaveAccessibleDescription("");
});

it("步进输入框由可见标签连同单位命名，手动输入在失焦时夹到范围内再提交", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <SettingStepper
      label="每次行动限时"
      description="设为 0 表示不限行动时间。"
      unit="秒"
      value={0}
      minimum={0}
      maximum={120}
      step={10}
      onChange={onChange}
    />
  );
  const input = screen.getByRole("spinbutton", { name: "每次行动限时（秒）" });
  expect(input).toHaveAccessibleDescription("设为 0 表示不限行动时间。");
  expect(screen.getByRole("button", { name: "减少每次行动限时" })).toBeDisabled();

  await user.clear(input);
  await user.type(input, "500");
  expect(onChange).not.toHaveBeenCalled();
  await user.tab();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(120);
});

it("文本输入由可见标签命名，密码框同样能按标签找到", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <>
      <SettingTextField
        label="房间名称"
        value=""
        placeholder="输入房间名称"
        maxLength={32}
        onChange={onChange}
      />
      <SettingTextField
        label="房间密码"
        type="password"
        value=""
        placeholder="设置房间密码"
        onChange={vi.fn()}
      />
    </>
  );
  const name = screen.getByRole("textbox", { name: "房间名称" });
  expect(name).toHaveAttribute("maxlength", "32");
  await user.type(name, "新");
  expect(onChange).toHaveBeenCalledWith("新");
  expect(screen.getByLabelText("房间密码")).toHaveAttribute("type", "password");
});

it("下拉选择的可见标签命名触发器，没有候选时整项禁用", () => {
  render(
    <SettingSelect
      label="指定出题人"
      value=""
      options={[{ value: "", label: "暂无可选出题人" }]}
      disabled
      onChange={vi.fn()}
    />
  );
  const trigger = screen.getByRole("combobox", { name: "指定出题人" });
  expect(trigger).toBeDisabled();
  expect(trigger).toHaveTextContent("暂无可选出题人");
});

it("步进输入框是数值调节控件：读得出范围与当前值，上下方向键调节", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <SettingStepper
      label="每次行动限时"
      unit="秒"
      value={30}
      minimum={0}
      maximum={120}
      step={10}
      onChange={onChange}
    />
  );
  const input = screen.getByRole("spinbutton", { name: "每次行动限时（秒）" });
  expect(input).toHaveAttribute("aria-valuemin", "0");
  expect(input).toHaveAttribute("aria-valuemax", "120");
  expect(input).toHaveAttribute("aria-valuenow", "30");
  await user.click(input);
  await user.keyboard("{ArrowUp}");
  expect(onChange).toHaveBeenLastCalledWith(40);
});

it("年份输入同样是数值调节控件，留空时不报当前值", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <SettingYearRange
      label="番剧年份"
      start={2010}
      end={undefined}
      optional
      minimum={1900}
      maximum={2200}
      onChange={onChange}
    />
  );
  const start = screen.getByRole("spinbutton", { name: "番剧年份起始" });
  expect(start).toHaveAttribute("aria-valuemin", "1900");
  expect(start).toHaveAttribute("aria-valuemax", "2200");
  expect(start).toHaveAttribute("aria-valuenow", "2010");
  const end = screen.getByRole("spinbutton", { name: "番剧年份结束" });
  expect(end).not.toHaveAttribute("aria-valuenow");
  await user.click(start);
  await user.keyboard("{ArrowUp}");
  expect(onChange).toHaveBeenLastCalledWith(2011, undefined);
});
