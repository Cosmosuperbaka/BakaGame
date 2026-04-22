import { useCallback } from "react";
import { AlertTriangle, Clock, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useGame } from "@/contexts/GameContext";

// 出题人处理掉线玩家
export function DisconnectHandler() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const isQuestioner = privateState?.isQuestioner ?? false;
  const pendingId = snapshot.status.pendingDisconnectPlayerId;
  const pendingPlayer = snapshot.players.find((p) => p.id === pendingId);

  if (!pendingId || !pendingPlayer) return null;

  const handleResolve = useCallback(
    async (resolution: "wait" | "eliminate") => {
      try {
        await sendCommand("game.resolveDisconnect", {
          playerId: pendingId,
          resolution,
        });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [pendingId, sendCommand, addToast]
  );

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-800">
            玩家 {pendingPlayer.name} 已掉线
          </span>
        </div>
        {isQuestioner && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleResolve("wait")}
              className="gap-1"
            >
              <Clock className="h-3.5 w-3.5" />
              等待重连
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => handleResolve("eliminate")}
              className="gap-1"
            >
              <UserX className="h-3.5 w-3.5" />
              淘汰并踢出
            </Button>
          </div>
        )}
        {!isQuestioner && (
          <p className="text-xs text-amber-700">等待出题人处理...</p>
        )}
      </CardContent>
    </Card>
  );
}
