/* eslint-disable react-refresh/only-export-components -- 私密文案、保存载荷与可保存判定随字段块一起被三个游戏与建房弹窗消费，拆文件只会让调用点各写一遍。 */
import type { ReactNode } from "react";
import { EyeOff, Globe, Lock, Users } from "lucide-react";
import type { RoomVisibility } from "@bakagame/shared";
import { SettingReveal } from "@/components/common/room/settings/Layout";
import { SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { SettingTextField } from "@/components/common/room/settings/TextFields";

export type RoomPrivacy = "password" | "unlisted";

/** 私密开关的标签与说明随含义变化；不在大厅显示的说明常驻，告诉房主链接仍然有效。 */
export const PRIVACY_COPY: Record<RoomPrivacy, { label: string; description?: string }> = {
  password: { label: "私密房间" },
  unlisted: { label: "不在大厅显示", description: "开启后不在大厅列出，凭链接仍可进入。" },
};

/** 房间基础字段的草稿：名称、私密与否、密码与旁观开关，三款等待页与建房弹窗共用同一口径。 */
export interface RoomBasicsValues {
  name: string;
  isPrivate: boolean;
  password: string;
  allowSpectators: boolean;
}

/**
 * 房间基础字段序列：名称、私密开关、密码（随私密展开）、允许旁观。
 * 只输出字段本身，外层的 `SettingsFields` 与折叠组留在调用点；各款独有的字段经 `children` 接在允许旁观之后。
 * 私密含义由 `privacy` 决定：增强房设密码（锁），原版房不进大厅（眼睛划掉），文案与图标都取自 `PRIVACY_COPY`。
 */
export function RoomBasicsFields({
  values,
  onEdit,
  nameMaxLength,
  privacy = "password",
  passwordField,
  hasPassword,
  spectatorsField = true,
  children,
}: {
  values: RoomBasicsValues;
  onEdit: <K extends keyof RoomBasicsValues>(key: K, value: RoomBasicsValues[K]) => void;
  nameMaxLength: number;
  privacy?: RoomPrivacy;
  /** 卧底、猜歌为 !readOnly；CEE 为 isHost && 增强房。 */
  passwordField: boolean;
  hasPassword: boolean;
  /** CEE 原版房没有旁观开关，传 false。 */
  spectatorsField?: boolean;
  children?: ReactNode;
}) {
  const privacyCopy = PRIVACY_COPY[privacy];
  return (
    <>
      <SettingTextField
        label="房间名称"
        value={values.name}
        maxLength={nameMaxLength}
        placeholder="输入房间名称"
        onChange={(value) => onEdit("name", value)}
      />
      <SettingSwitchRow
        label={privacyCopy.label}
        description={privacyCopy.description}
        // 原版房的「不在大厅显示」没有密码，开启时不用锁（DesignGuide §6）。
        icon={values.isPrivate ? (privacy === "unlisted" ? EyeOff : Lock) : Globe}
        checked={values.isPrivate}
        onCheckedChange={(value) => onEdit("isPrivate", value)}
      />
      {passwordField ? (
        <SettingReveal open={values.isPrivate}>
          {/* 还没有密码时留空不会保存（私密房间必须有密码），占位文案按是否已有密码区分。 */}
          <SettingTextField
            label="房间密码"
            type="password"
            value={values.password}
            onChange={(value) => onEdit("password", value)}
            placeholder={hasPassword ? "留空则保留当前密码" : "设置房间密码"}
          />
        </SettingReveal>
      ) : null}
      {spectatorsField ? (
        <SettingSwitchRow
          label="允许旁观"
          icon={Users}
          checked={values.allowSpectators}
          onCheckedChange={(value) => onEdit("allowSpectators", value)}
        />
      ) : null}
      {children}
    </>
  );
}

/** 房间基础字段的保存载荷：空名称交给服务端缺省，公开房把密码清成空串（与卧底、猜歌原口径一致）。 */
export function roomBasicsPayload(values: RoomBasicsValues): {
  name?: string;
  visibility: RoomVisibility;
  password?: string;
  allowSpectators: boolean;
} {
  return {
    name: values.name || undefined,
    visibility: values.isPrivate ? "private" : "public",
    password: values.isPrivate ? values.password || undefined : "",
    allowSpectators: values.allowSpectators,
  };
}

/** 私密房间必须有密码：还没有、也没填新的就先不保存。 */
export function canSaveRoomBasics(values: RoomBasicsValues, hasPassword: boolean): boolean {
  return !values.isPrivate || hasPassword || values.password.trim().length > 0;
}
