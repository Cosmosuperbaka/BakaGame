import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Badge } from "@/components/ui/Badge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/Utils";
import type { CCBGameSettings } from "@/types";

const CURRENT_YEAR = new Date().getFullYear();

const CATEGORY_OPTIONS = [
  { value: "全部", label: "全部分类" },
  { value: "游戏", label: "游戏" },
  { value: "书籍", label: "书籍" },
  { value: "三次元", label: "三次元" },
  { value: "", label: "全部动画" },
  { value: "TV", label: "TV" },
  { value: "Galgame", label: "Galgame" },
  { value: "WEB", label: "WEB" },
  { value: "OVA", label: "OVA" },
  { value: "剧场版", label: "剧场版" },
  { value: "动态漫画", label: "动态漫画" },
  { value: "其他", label: "其他" },
];

const SOURCE_OPTIONS = [
  { value: "", label: "全部来源" },
  { value: "原创", label: "原创" },
  { value: "漫画改", label: "漫画改" },
  { value: "游戏改", label: "游戏改" },
  { value: "小说改", label: "小说改" },
];

const GENRE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "科幻", label: "科幻" },
  { value: "喜剧", label: "喜剧" },
  { value: "百合", label: "百合" },
  { value: "校园", label: "校园" },
  { value: "惊悚", label: "惊悚" },
  { value: "后宫", label: "后宫" },
  { value: "机战", label: "机战" },
  { value: "悬疑", label: "悬疑" },
  { value: "恋爱", label: "恋爱" },
  { value: "奇幻", label: "奇幻" },
  { value: "推理", label: "推理" },
  { value: "运动", label: "运动" },
  { value: "耽美", label: "耽美" },
  { value: "音乐", label: "音乐" },
  { value: "战斗", label: "战斗" },
  { value: "冒险", label: "冒险" },
  { value: "萌系", label: "萌系" },
  { value: "穿越", label: "穿越" },
  { value: "玄幻", label: "玄幻" },
  { value: "乙女", label: "乙女" },
  { value: "恐怖", label: "恐怖" },
  { value: "历史", label: "历史" },
  { value: "日常", label: "日常" },
  { value: "剧情", label: "剧情" },
  { value: "武侠", label: "武侠" },
  { value: "美食", label: "美食" },
  { value: "职场", label: "职场" },
];

const PRESET_CONFIGS = {
  入门: {
    startYear: CURRENT_YEAR - 5,
    endYear: CURRENT_YEAR,
    topNSubjects: 30,
    characterNum: 3,
    useHints: [5, 3],
  },
  冻鳗高手: {
    startYear: CURRENT_YEAR - 20,
    endYear: CURRENT_YEAR,
    topNSubjects: 5,
    useSubjectPerYear: true,
    mainCharacterOnly: false,
    subjectSearch: false,
  },
  老番享受者: {
    startYear: 2000,
    endYear: 2015,
    topNSubjects: 5,
    useSubjectPerYear: true,
    subjectSearch: false,
  },
  瓶子严选: {
    startYear: 2005,
    endYear: CURRENT_YEAR,
    topNSubjects: 75,
    characterNum: 10,
    maxAttempts: 7,
    characterTagNum: 5,
  },
};

interface CCBSettingsDialogProps {
  open: boolean;
  settings: CCBGameSettings;
  isMultiplayer: boolean;
  onClose: () => void;
  onApply: (settings: CCBGameSettings) => void;
}

export function CCBSettingsDialog({
  open,
  settings,
  isMultiplayer,
  onClose,
  onApply,
}: CCBSettingsDialogProps) {
  const [localSettings, setLocalSettings] = useState<CCBGameSettings>(settings);
  const [guessExpanded, setGuessExpanded] = useState(true);
  const [answerExpanded, setAnswerExpanded] = useState(true);

  useEffect(() => {
    if (open) {
      setLocalSettings(settings);
    }
  }, [open, settings]);

  const updateSetting = useCallback(<K extends keyof CCBGameSettings>(
    key: K,
    value: CCBGameSettings[K],
  ) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const applyPreset = useCallback((presetName: keyof typeof PRESET_CONFIGS) => {
    const preset = PRESET_CONFIGS[presetName];
    if (preset) {
      setLocalSettings((prev) => ({ ...prev, ...preset }));
    }
  }, []);

  const handleApply = useCallback(() => {
    onApply(localSettings);
    onClose();
  }, [localSettings, onApply, onClose]);

  const exclusiveCategories = ["全部", "游戏", "书籍", "三次元", "Galgame"];
  const isExclusiveCategory = exclusiveCategories.includes(localSettings.metaTags[0] || "");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>游戏设置</DialogTitle>
          <DialogDescription>
            调整游戏难度、题库范围等设置
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-6">
            {/* 多人模式卡片 */}
            {isMultiplayer && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">多人模式</h3>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => updateSetting("globalPick", !localSettings.globalPick)}
                    className={cn(
                      "rounded-lg border-2 p-3 text-left transition-colors",
                      localSettings.globalPick
                        ? "border-red-500 bg-red-50"
                        : "border-border hover:border-muted-foreground/50",
                    )}
                  >
                    <div className="font-medium">角色全局BP</div>
                    <div className="text-xs text-muted-foreground">
                      角色只能被猜一次
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => updateSetting("tagBan", !localSettings.tagBan)}
                    className={cn(
                      "rounded-lg border-2 p-3 text-left transition-colors",
                      localSettings.tagBan
                        ? "border-orange-500 bg-orange-50"
                        : "border-border hover:border-muted-foreground/50",
                    )}
                  >
                    <div className="font-medium">标签全局BP</div>
                    <div className="text-xs text-muted-foreground">
                      命中的标签对别人隐藏
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const mode = localSettings.mode;
                      updateSetting("mode", mode === "sync" ? "normal" : "sync");
                    }}
                    className={cn(
                      "rounded-lg border-2 p-3 text-left transition-colors",
                      localSettings.mode === "sync"
                        ? "border-cyan-500 bg-cyan-50"
                        : "border-border hover:border-muted-foreground/50",
                    )}
                  >
                    <div className="font-medium">同步模式</div>
                    <div className="text-xs text-muted-foreground">
                      全员猜完才进下一轮
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const mode = localSettings.mode;
                      updateSetting("mode", mode === "bloodbath" ? "normal" : "bloodbath");
                    }}
                    className={cn(
                      "rounded-lg border-2 p-3 text-left transition-colors",
                      localSettings.mode === "bloodbath"
                        ? "border-pink-500 bg-pink-50"
                        : "border-border hover:border-muted-foreground/50",
                    )}
                  >
                    <div className="font-medium">血战模式</div>
                    <div className="text-xs text-muted-foreground">
                      直到最后一人猜对或次数耗尽
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* 预设配置 */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">预设配置</h3>
              <div className="grid grid-cols-4 gap-2">
                {Object.keys(PRESET_CONFIGS).map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    size="sm"
                    onClick={() => applyPreset(preset as keyof typeof PRESET_CONFIGS)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </div>

            {/* 猜测设置 */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setGuessExpanded(!guessExpanded)}
                className="flex w-full items-center justify-between"
              >
                <h3 className="text-sm font-semibold">猜测设置</h3>
                {guessExpanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>

              {guessExpanded && (
                <div className="space-y-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="subjectSearch">搜索作品</Label>
                    <Switch
                      id="subjectSearch"
                      checked={localSettings.subjectSearch}
                      onCheckedChange={(checked) => updateSetting("subjectSearch", checked)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="maxAttempts">猜测次数</Label>
                      <Input
                        id="maxAttempts"
                        type="number"
                        min={1}
                        max={100}
                        value={localSettings.maxAttempts}
                        onChange={(e) =>
                          updateSetting("maxAttempts", parseInt(e.target.value) || 10)
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="timeLimit">时间限制（秒，0=不限）</Label>
                      <Input
                        id="timeLimit"
                        type="number"
                        min={0}
                        max={300}
                        value={localSettings.timeLimitMs ? localSettings.timeLimitMs / 1000 : 0}
                        onChange={(e) => {
                          const seconds = parseInt(e.target.value) || 0;
                          updateSetting("timeLimitMs", seconds > 0 ? seconds * 1000 : 0);
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>文本提示（剩余次数）</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {[0, 1, 2].map((idx) => (
                        <Input
                          key={idx}
                          type="number"
                          min={0}
                          placeholder="-"
                          value={localSettings.useHints?.[idx] || ""}
                          onChange={(e) => {
                            const hints = [...(localSettings.useHints || [])];
                            const val = parseInt(e.target.value);
                            if (val > 0) {
                              hints[idx] = val;
                            } else {
                              hints.splice(idx, 1);
                            }
                            updateSetting("useHints", hints.filter((h) => h > 0));
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 答案设置 */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setAnswerExpanded(!answerExpanded)}
                className="flex w-full items-center justify-between"
              >
                <h3 className="text-sm font-semibold">答案设置</h3>
                {answerExpanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>

              {answerExpanded && (
                <div className="space-y-4 rounded-lg border p-4">
                  <div className="space-y-2">
                    <Label>作品筛选</Label>
                    <div className="grid grid-cols-3 gap-2">
                      <Select
                        value={localSettings.metaTags[0] || ""}
                        onValueChange={(value) => {
                          const newTags = [...localSettings.metaTags];
                          newTags[0] = value;
                          if (exclusiveCategories.includes(value)) {
                            newTags[1] = "";
                            newTags[2] = "";
                          }
                          updateSetting("metaTags", newTags);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORY_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value || "all"} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select
                        value={localSettings.metaTags[1] || ""}
                        disabled={isExclusiveCategory}
                        onValueChange={(value) => {
                          const newTags = [...localSettings.metaTags];
                          newTags[1] = value;
                          updateSetting("metaTags", newTags);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SOURCE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value || "all-source"} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select
                        value={localSettings.metaTags[2] || ""}
                        disabled={isExclusiveCategory}
                        onValueChange={(value) => {
                          const newTags = [...localSettings.metaTags];
                          newTags[2] = value;
                          updateSetting("metaTags", newTags);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GENRE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value || "all-genre"} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="startYear">起始年份</Label>
                      <Input
                        id="startYear"
                        type="number"
                        min={1800}
                        max={CURRENT_YEAR}
                        value={localSettings.startYear || CURRENT_YEAR - 10}
                        onChange={(e) =>
                          updateSetting("startYear", parseInt(e.target.value) || CURRENT_YEAR - 10)
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="endYear">结束年份</Label>
                      <Input
                        id="endYear"
                        type="number"
                        min={1800}
                        max={2038}
                        value={localSettings.endYear || CURRENT_YEAR}
                        onChange={(e) =>
                          updateSetting("endYear", parseInt(e.target.value) || CURRENT_YEAR)
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="topN">前N部作品</Label>
                      <Input
                        id="topN"
                        type="number"
                        min={0}
                        max={1000}
                        value={localSettings.topNSubjects}
                        onChange={(e) =>
                          updateSetting("topNSubjects", parseInt(e.target.value) || 50)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <Label htmlFor="perYear">按年榜</Label>
                      <Switch
                        id="perYear"
                        checked={localSettings.useSubjectPerYear}
                        onCheckedChange={(checked) =>
                          updateSetting("useSubjectPerYear", checked)
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="characterNum">角色数量</Label>
                      <Input
                        id="characterNum"
                        type="number"
                        min={1}
                        max={99}
                        value={localSettings.characterNum}
                        onChange={(e) =>
                          updateSetting("characterNum", parseInt(e.target.value) || 6)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <Label htmlFor="mainOnly">仅主角</Label>
                      <Switch
                        id="mainOnly"
                        checked={localSettings.mainCharacterOnly}
                        onCheckedChange={(checked) =>
                          updateSetting("mainCharacterOnly", checked)
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="characterTags">角色标签数</Label>
                      <Input
                        id="characterTags"
                        type="number"
                        min={0}
                        max={10}
                        value={localSettings.characterTagNum}
                        onChange={(e) =>
                          updateSetting("characterTagNum", parseInt(e.target.value) || 4)
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="subjectTags">作品标签数</Label>
                      <Input
                        id="subjectTags"
                        type="number"
                        min={0}
                        max={10}
                        value={localSettings.subjectTagNum}
                        onChange={(e) =>
                          updateSetting("subjectTagNum", parseInt(e.target.value) || 3)
                        }
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleApply}>应用设置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
