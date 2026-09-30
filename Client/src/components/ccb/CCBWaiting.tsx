import { useId, useState } from "react";
import { Check, Play, Settings } from "lucide-react";
import type { CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { SettingsAccordion, SettingsChips } from "@/components/common/room/SettingsAccordion";
import { SettingSwitchRow } from "@/components/common/room/SettingFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { ccbRoomPath } from "@/lib/CCBSession";
import { CCBGameSettings } from "./CCBGameSettings";
import { CCBSetterPicker } from "./CCBSetterPicker";

/** 非房主看到的只读设置摘要。 */
function settingsChips(snapshot: CCBRoomSnapshot): string[] {
  const { settings } = snapshot;
  return [
    settings.syncMode ? "同步模式" : "普通模式",
    settings.nonstopMode ? "血战模式" : "首位猜中结束",
    `${settings.maxAttempts} 次机会`,
    settings.timeLimit ? `每次 ${settings.timeLimit} 秒` : "不限行动时间",
  ];
}

/**
 * CCB 等待页。房主在折叠面板里直接改设置，防抖自动保存；
 * 非房主只看设置摘要与准备按钮。房间设置的改动与题目设置分开保存，互不覆盖。
 */
export function CCBWaiting({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const activePlayers = snapshot.players.filter((player) => player.membership === "active");
  const readyCount = activePlayers.filter((player) => player.ready).length;
  const { run, busy } = useCCBAction();
  const [roomOpen, setRoomOpen] = useState(false);

  // 房间设置的草稿：名称、是否公开、是否允许旁观与私密密码。
  const [roomDraft, setRoomDraft] = useState(() => ({
    name: snapshot.name,
    visibility: snapshot.visibility,
    allowSpectators: snapshot.allowSpectators,
    password: "",
  }));
  const nameFieldId = useId();
  const passwordFieldId = useId();
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

  const editRoom = <K extends keyof typeof roomDraft>(key: K, value: (typeof roomDraft)[K]) =>
    setRoomDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PhaseHeader icon={Play} title="等待玩家准备" />

      <RoomLinkShare
        path={ccbRoomPath(snapshot.roomId)}
        onCopyError={() => useCCBStore.getState().setNotice("复制失败，请手动复制", "error")}
      />

      <ReadyProgress ready={readyCount} total={activePlayers.length} variant={isHost ? "host" : "guest"} />

      {isHost ? (
        <div className="space-y-3">
          <CCBGameSettings settings={snapshot.settings} waiting={snapshot.phase === "waiting"} />

          <SettingsAccordion icon={Settings} title="房间设置" open={roomOpen} onOpenChange={setRoomOpen}>
            <div className="space-y-4">
              <div className="grid gap-1.5">
                <Label htmlFor={nameFieldId} className="text-xs">房间名称</Label>
                <Input
                  id={nameFieldId}
                  value={roomDraft.name}
                  maxLength={snapshot.source === "original" ? 30 : 32}
                  onChange={(event) => editRoom("name", event.target.value)}
                />
              </div>
              <SettingSwitchRow
                label="公开显示在大厅"
                description={snapshot.source === "original" ? "关闭后不在大厅列出，凭链接仍可进入。" : undefined}
                checked={roomDraft.visibility === "public"}
                onCheckedChange={(checked) => editRoom("visibility", checked ? "public" : "private")}
              />
              {roomDraft.visibility === "private" && snapshot.source === "native" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={passwordFieldId} className="text-xs">房间密码</Label>
                  <Input
                    id={passwordFieldId}
                    type="password"
                    value={roomDraft.password}
                    placeholder={snapshot.hasPassword ? "留空沿用原密码" : "请输入密码"}
                    onChange={(event) => editRoom("password", event.target.value)}
                  />
                </div>
              ) : null}
              {snapshot.source === "native" ? (
                <SettingSwitchRow
                  label="允许旁观"
                  checked={roomDraft.allowSpectators}
                  onCheckedChange={(checked) => editRoom("allowSpectators", checked)}
                />
              ) : null}
              {roomValidation ? <p role="alert" className="text-xs text-destructive">{roomValidation}</p> : null}
              {roomNotice ? <p role="alert" className="text-xs text-destructive">{roomNotice}</p> : null}
              <p className="text-[11px] text-muted-foreground">改动会自动保存。</p>
            </div>
          </SettingsAccordion>
        </div>
      ) : (
        <SettingsChips items={settingsChips(snapshot)} />
      )}

      <div className="flex flex-wrap justify-center gap-2">
        {me?.membership === "active" ? (
          <Button
            variant={me.ready ? "secondary" : "default"}
            disabled={busy}
            onClick={() => void run("ccb.player.ready", { ready: !me.ready })}
          >
            <Check />{me.ready ? "取消准备" : "准备"}
          </Button>
        ) : null}
        {isHost ? (
          <Button disabled={busy || !privateState.canStart} loading={busy} onClick={() => void run("ccb.game.start", {})}>
            <Play />随机出题
          </Button>
        ) : null}
      </div>

      {isHost ? <div className="space-y-4 border-t pt-5"><CCBSetterPicker snapshot={snapshot} privateState={privateState} /></div>
        : <p className="text-center text-xs text-muted-foreground">准备完成后由房主开始</p>}
    </div>
  );
}
