import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Lock, Plus, RefreshCw, Users } from "lucide-react";
import type { CCBSource } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/Dialog";
import { RoomCardSkeleton } from "@/components/common/RoomCardSkeleton";
import { Seo } from "@/components/common/Seo";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { ccbRoomPath, CCB_SOURCE_LABELS } from "@/lib/CCBSession";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { useOriginTracker } from "@/hooks/UseOriginTracker";

const phases = { waiting: "等待中", preparing: "准备题目", answering: "出题中", guessing: "猜测中", settled: "已结算" };

export default function CCBPage() {
  const navigate = useNavigate();
  const rooms = useCCBStore((state) => state.rooms);
  const connected = useCCBStore((state) => state.connected);
  const ready = useCCBStore((state) => state.lobbyReady);
  const originalAvailable = useCCBStore((state) => state.originalAvailable);
  const [source, setSource] = useState<CCBSource>("native");
  const [name, setName] = useState(getSavedUsername);
  const [directRoom, setDirectRoom] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [privateRoom, setPrivateRoom] = useState(false);
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const origin = useOriginTracker();
  const [leaving, setLeaving] = useState(() => Boolean(useCCBStore.getState().roomId));
  const releaseStarted = useRef(false);
  useEffect(() => {
    const store = useCCBStore.getState();
    if (!store.roomId || releaseStarted.current) return;
    releaseStarted.current = true;
    void store.leaveRoom().then(() => store.subscribeLobby())
      .catch((failure) => store.setNotice(ccbErrorMessage(failure)))
      .finally(() => setLeaving(false));
  }, []);
  const enabled = connected && ready && !leaving && (source === "native" || originalAvailable);
  const visibleRooms = rooms.filter((room) => room.source === source);

  const goToRoom = (roomId: string) => {
    if (!roomId.trim()) return;
    saveUsername(name.trim());
    useCCBStore.getState().resetRoom();
    navigate(ccbRoomPath(roomId.trim()));
  };
  const create = async () => {
    if (!name.trim()) { setError("请先填写用户名"); return; }
    if (source === "native" && privateRoom && !password.trim()) { setError("请填写房间密码"); return; }
    setBusy(true); setError("");
    try {
      const values = crypto.getRandomValues(new Uint32Array(1));
      const roomId = String(1000 + values[0] % 9000);
      await useCCBStore.getState().createRoom({ source, roomId, userName: name.trim(),
        name: roomName.trim() || `${name.trim()}的房间`.slice(0, 32), visibility: source === "native" && privateRoom ? "private" : "public",
        allowSpectators: source === "original" || allowSpectators,
        ...(source === "native" && privateRoom ? { password } : {}) });
      saveUsername(name.trim());
      navigate(ccbRoomPath(useCCBStore.getState().roomId!));
    } catch (failure) { setError(ccbErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    try { await useCCBStore.getState().subscribeLobby(); }
    catch (failure) { useCCBStore.getState().setNotice(ccbErrorMessage(failure)); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <Seo path="/ccb" />
      <header className="border-b border-border/40 px-6 py-6">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/")}><ArrowLeft />返回主页</Button>
          <h1 className="text-xl font-semibold">二刺猿笑传之猜猜呗</h1>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={source} onValueChange={(value) => setSource(value as CCBSource)}>
            <TabsList><TabsTrigger value="native">增强房</TabsTrigger><TabsTrigger value="original">原版房</TabsTrigger></TabsList>
          </Tabs>
          <div className="flex min-w-0 items-center gap-2">
            <Input aria-label="用户名" placeholder="用户名" value={name} maxLength={32} onChange={(event) => setName(event.target.value)} className="w-32" />
            <Button disabled={!enabled} onClick={(event) => { origin.capture(event); setError(""); setCreateOpen(true); }}><Plus />创建房间</Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{source === "native" ? "增强房使用本项目的多人玩法与聊天功能。" : "与原版玩家一起游玩，聊天仅增强版玩家可见。"}</p>
        {source === "original" && ready && !originalAvailable ? <p role="status" className="rounded-md border p-4 text-sm">原版服务器暂未接入，请使用增强房。</p> : null}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); goToRoom(directRoom); }}>
          <Input aria-label="房间号" placeholder="输入房间号" maxLength={32} value={directRoom} onChange={(event) => setDirectRoom(event.target.value)} />
          <Button type="submit" variant="outline" disabled={!enabled || !directRoom.trim()}>加入房间</Button>
          <Button type="button" variant="ghost" size="icon" aria-label="刷新房间列表" disabled={!connected} onClick={() => void refresh()}><RefreshCw /></Button>
        </form>
        <div className="space-y-3">
          {!ready ? <RoomCardSkeleton count={3} /> : !visibleRooms.length ? <p className="rounded-md border border-dashed py-12 text-center text-sm text-muted-foreground">暂无房间</p> : visibleRooms.map((room) => (
            <Button key={`${room.source}:${room.roomId}`} variant="outline" className="h-auto w-full justify-between gap-3 bg-panel px-4 py-4" disabled={!enabled} onClick={() => goToRoom(room.roomId)}>
              <span className="min-w-0 text-left"><span className="block truncate">{room.name}</span><span className="font-mono text-xs text-muted-foreground">#{room.roomId}</span></span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{room.hasPassword ? <Lock aria-label="需要密码" /> : null}<span>{phases[room.phase]}</span><Users />{room.playerCount}</span>
            </Button>
          ))}
        </div>
      </main>
      <Dialog open={createOpen} onOpenChange={setCreateOpen} origin={origin.origin}>
        <DialogContent><DialogHeader><DialogTitle>创建{CCB_SOURCE_LABELS[source]}</DialogTitle><DialogDescription>邀请朋友加入同一个房间。</DialogDescription></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void create(); }} className="space-y-4">
            <Label className="block space-y-2">房间名称<Input value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={32} placeholder={`${name || "新"}的房间`} /></Label>
            {source === "native" ? <>
              <Label className="flex items-center justify-between">私密房间<Switch checked={privateRoom} onCheckedChange={setPrivateRoom} /></Label>
              {privateRoom ? <Input aria-label="房间密码" type="password" placeholder="房间密码" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={64} /> : null}
              <Label className="flex items-center justify-between">允许旁观<Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} /></Label>
            </> : null}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" loading={busy} disabled={!enabled}>创建</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
