import { Shield, AlertTriangle, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PrivateState } from "@/types";

interface Props {
  privateState: PrivateState;
}

// 显示玩家私有信息：角色、词语等
export function PrivateInfo({ privateState }: Props) {
  const identityRows = privateState.questionerView;

  if (identityRows?.length) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="gap-1">
          {privateState.isQuestioner ? <Shield className="h-3 w-3" /> : <Users className="h-3 w-3" />}
          {privateState.isQuestioner ? "出题人" : "旁观视角"}
        </Badge>
      </div>
    );
  }

  if (!privateState.word && !privateState.angelWordOptions && !privateState.blankHint) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      {privateState.word && (
        <Badge variant="outline">
          你的词语：{privateState.word}
        </Badge>
      )}
      {privateState.angelWordOptions && (
        <span className="text-xs text-muted-foreground">
          候选词：{privateState.angelWordOptions[0]} / {privateState.angelWordOptions[1]}
        </span>
      )}
      {privateState.blankHint && (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          提示：{privateState.blankHint}
        </span>
      )}
    </div>
  );
}
