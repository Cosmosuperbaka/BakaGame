import { useState } from "react";
import { Check, EyeOff, Gamepad2, Globe, Lock, Settings, Users, X } from "lucide-react";
import type { CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { SettingsAccordion, SettingsStack } from "@/components/common/room/SettingsAccordion";
import { SettingReveal, SettingSwitchRow, SettingTextField, SettingsFields } from "@/components/common/room/SettingFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { ccbRoomPath } from "@/lib/CCBSession";
import { CCBGameSettings } from "./CCBGameSettings";
import { CCBTeamPicker } from "./CCBTeamPicker";

/**
 * CCB 等待页，与另外两个游戏同一结构：房主在折叠面板里直接改设置（防抖自动保存），底部只有开始按钮，
 * 房主没有准备态；其他玩家看到同一份设置结构（只读）与准备按钮。房间设置的改动与题目设置分开保存，互不覆盖。
 * 出题方式在设置里：随机出题要等其他人都准备；指定出题人点开始后进入选人阶段，出题人不必准备。
 */
export function CCBWaiting({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  // 准备进度只算房主以外的参与者，与另外两个游戏同口径。
  const others = snapshot.players.filter((player) => player.membership === "active" && player.id !== snapshot.hostPlayerId);
  const readyCount = others.filter((player) => player.ready).length;
  const manual = snapshot.settings.answerMode === "manual";
  const { run, pending } = useCCBAction();
  const starting = pending.has("ccb.game.start");
  const readying = pending.has("ccb.player.ready");
  const [roomOpen, setRoomOpen] = useState(false);

  // 房间设置的草稿：名称、是否公开、是否允许旁观与私密密码。
  const [roomDraft, setRoomDraft] = useState(() => ({
    name: snapshot.name,
    visibility: snapshot.visibility,
    allowSpectators: snapshot.allowSpectators,
    password: "",
  }));
  const [roomNotice, setRoomNotice] = useState("");

  // 私密房间必须有密码——这是增强房的语义，原版房没有密码机制，
  // 那里的「不公开」只表示不进大厅，不能因此拦住保存。
  const roomValidation =
    snapshot.source === "native" && roomDraft.visibility === "private" && !roomDraft.password.trim() && !snapshot.hasPassword
      ? "私密房间需要密码，填写后才会保存"
      : "";

  useAutoSave(roomDraft, async (value) => {
    await useCCBStore.getState().sendCommand("ccb.room.update", {
      name: value.name.trim(),
      visibility: value.visibility,
      allowSpectators: value.allowSpectators,
      password: value.password.trim() || null,
    });
    setRoomNotice("");
  }, {
    enabled: isHost && snapshot.phase === "waiting" && !roomValidation && Boolean(roomDraft.name.trim()),
    onError: (error) => setRoomNotice(ccbErrorMessage(error)),
  });

  // 非房主读当前快照；房主读草稿。
  const roomValues = isHost ? roomDraft : { visibility: snapshot.visibility, allowSpectators: snapshot.allowSpectators };
  const editRoom = <K extends keyof typeof roomDraft>(key: K, value: (typeof roomDraft)[K]) =>
    setRoomDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title={isHost ? "等待玩家加入" : "等待开始"} />

      <RoomLinkShare
        path={ccbRoomPath(snapshot.roomId)}
        onCopyError={() => useCCBStore.getState().setNotice("复制失败，请手动复制", "error")}
      />

      {others.length ? <ReadyProgress ready={readyCount} total={others.length} variant={isHost ? "host" : "guest"} /> : null}

      <CCBTeamPicker snapshot={snapshot} privateState={privateState} />

      <SettingsStack>
        <CCBGameSettings settings={snapshot.settings} waiting={snapshot.phase === "waiting"} readOnly={!isHost} />

        <SettingsAccordion icon={Settings} title="房间设置" open={roomOpen} onOpenChange={setRoomOpen} readOnly={!isHost}
          summary={[
            snapshot.visibility === "private" ? (snapshot.source === "original" ? "不在大厅显示" : "私密房间") : "公开房间",
            snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
          ]}>
          <SettingsFields>
            <SettingTextField
              label="房间名称"
              value={isHost ? roomDraft.name : snapshot.name}
              maxLength={snapshot.source === "original" ? 30 : 32}
              placeholder="输入房间名称"
              onChange={(value) => editRoom("name", value)}
            />
            {/* 与建房弹窗同一措辞：增强房的私密房设密码，原版房没有密码机制，开关只控制是否进大厅。 */}
            <SettingSwitchRow
              label={snapshot.source === "original" ? "不在大厅显示" : "私密房间"}
              description={snapshot.source === "original" ? "开启后不在大厅列出，凭链接仍可进入。" : undefined}
              icon={roomValues.visibility !== "private" ? Globe : snapshot.source === "original" ? EyeOff : Lock}
              checked={roomValues.visibility === "private"}
              onCheckedChange={(checked) => editRoom("visibility", checked ? "private" : "public")}
            />
            {isHost && snapshot.source === "native" ? (
              <SettingReveal open={roomDraft.visibility === "private"}>
                <SettingTextField
                  label="房间密码"
                  type="password"
                  value={roomDraft.password}
                  placeholder={snapshot.hasPassword ? "留空则保留当前密码" : "设置房间密码"}
                  onChange={(value) => editRoom("password", value)}
                />
              </SettingReveal>
            ) : null}
            {snapshot.source === "native" ? (
              <SettingSwitchRow
                label="允许旁观"
                icon={Users}
                checked={roomValues.allowSpectators}
                onCheckedChange={(checked) => editRoom("allowSpectators", checked)}
              />
            ) : null}
            {roomValidation ? <p role="alert" className="text-xs text-destructive">{roomValidation}</p> : null}
            {roomNotice ? <p role="alert" className="text-xs text-destructive">{roomNotice}</p> : null}
          </SettingsFields>
        </SettingsAccordion>
      </SettingsStack>

      {isHost ? (
        <Button size="lg" className="w-full text-base" disabled={starting || !privateState.canStart} loading={starting}
          onClick={() => void run("ccb.game.start", {})}>
          {privateState.canStart ? (manual ? "开始并指定出题人" : "开始游戏")
              : others.length === 0 ? "等待玩家加入"
                : manual ? "暂无可选出题人" : `等待玩家准备 (${readyCount}/${others.length})`}
        </Button>
      ) : me?.membership === "active" ? (
        <div className="flex justify-center">
          <Button variant={me.ready ? "outline" : "default"} size="lg" className="min-w-[120px] gap-2" disabled={readying} loading={readying}
            onClick={() => void run("ccb.player.ready", { ready: !me.ready })}>
            {me.ready ? <>{readying ? null : <X className="h-4 w-4" />}取消准备</> : <>{readying ? null : <Check className="h-4 w-4" />}准备</>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
