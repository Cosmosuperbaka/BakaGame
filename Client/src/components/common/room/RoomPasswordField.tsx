import { useId } from "react";
import { Input } from "@/components/ui/Input";

/** 进房弹窗里一次加入失败的文案；`invalid` 只在确属密码错误时标红输入框。 */
export interface RoomPasswordError {
  message: string;
  invalid: boolean;
}

/**
 * 进房输入密码的输入框：分享链接进房（`RoomJoinGate`）与大厅点开带锁房间（`JoinPasswordDialog`）共用这一种写法。
 * 失败文案写在框下并经 `aria-describedby` 关联；只有密码本身不对才标 `aria-invalid`，其余失败（次数过多等）只给文案。
 */
export function RoomPasswordField({
  value,
  onChange,
  disabled = false,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: RoomPasswordError | null;
}) {
  const errorId = useId();
  return (
    <div className="grid gap-1.5">
      <Input
        autoFocus
        type="password"
        aria-label="房间密码"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请输入密码"
        aria-invalid={error?.invalid || undefined}
        aria-describedby={error ? errorId : undefined}
        className="h-10"
      />
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
