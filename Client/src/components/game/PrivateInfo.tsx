import { Shield, Eye, BookOpen, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PrivateState } from "@/types";

interface Props {
  privateState: PrivateState;
}

export function PrivateInfo({ privateState }: Props) {
  const identityRows = privateState.questionerView;

  if (identityRows?.length) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="gap-1.5 px-3 py-1 text-xs font-medium">
          {privateState.isQuestioner ? (
            <Shield className="h-3.5 w-3.5 text-purple-600" />
          ) : (
            <Eye className="h-3.5 w-3.5 text-blue-600" />
          )}
          {privateState.isQuestioner ? "出题人视角" : "旁观视角"}
        </Badge>
      </div>
    );
  }

  if (!privateState.word && !privateState.angelWordOptions && !privateState.blankHint) return null;

  return (
    <div className="flex items-center gap-3 rounded-md border bg-card/80 px-4 py-2 shadow-2xs backdrop-blur-xs">
      {privateState.word && (
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs text-muted-foreground font-medium">你的词语</span>
          <span className="text-sm font-bold text-foreground bg-primary/10 text-primary px-2.5 py-0.5 rounded-md">
            {privateState.word}
          </span>
        </div>
      )}

      {privateState.angelWordOptions && (
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-xs text-muted-foreground font-medium">候选词</span>
          <span className="text-sm font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded-md">
            {privateState.angelWordOptions[0]} / {privateState.angelWordOptions[1]}
          </span>
        </div>
      )}

      {privateState.blankHint && (
        <div className="flex items-center gap-2 border-l pl-3">
          <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-xs text-muted-foreground font-medium">提示</span>
          <span className="text-sm font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded-md">
            {privateState.blankHint}
          </span>
        </div>
      )}
    </div>
  );
}
