import { useId, type ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import {
  ReadOnlyValue,
  SettingRow,
  StackedField,
  useSettingsReadOnly,
} from "@/components/common/room/settings/Layout";

/**
 * 单行文本设置（房间名称、房间密码、目录编号）：可见标签命名输入框，占位文案给出业务提示。
 * `action` 放在输入框右侧（「同步目录」「读取」）；只读时显示取值，密码只显示「已设置」。
 */
export function SettingTextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  maxLength,
  inputMode,
  description,
  action,
  readOnlyText,
  error,
  autoFocus,
  disabled = false,
  inputClassName,
  controlId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: "text" | "password";
  maxLength?: number;
  inputMode?: "numeric" | "text";
  description?: string;
  action?: ReactNode;
  /** 只读时的取值文字；缺省为输入框的值，密码框不显示 */
  readOnlyText?: string;
  /** 落在这个字段上的校验失败：输入框标 `aria-invalid`，文案写在下方并经 `aria-describedby` 关联 */
  error?: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
  /** 只改输入框的高度与字号（弹窗里的 `h-10`） */
  inputClassName?: string;
  /** Agent 操作追踪用的控件 id。 */
  controlId?: string;
}) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const readOnly = useSettingsReadOnly();
  if (readOnly) {
    if (type === "password") return null;
    const text = readOnlyText ?? value;
    return (
      <SettingRow label={label} description={description}>
        <ReadOnlyValue muted={!text}>{text || "未设置"}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <StackedField
      label={label}
      description={description}
      htmlFor={id}
      descriptionId={descriptionId}
    >
      <div className="flex gap-2">
        <Input
          id={id}
          type={type}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          inputMode={inputMode}
          autoFocus={autoFocus}
          disabled={disabled}
          className={inputClassName}
          data-agent-control={controlId}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [description ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ") ||
            undefined
          }
          onChange={(event) => onChange(event.target.value)}
        />
        {action}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </StackedField>
  );
}
