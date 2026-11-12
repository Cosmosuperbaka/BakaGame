import { useRef } from "react";
import { Download, Upload } from "lucide-react";
import type { CEESettings } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { SettingSelect } from "@/components/common/room/SettingFields";

/** 房主工具：套用预设、导出与导入玩法配置，以及导入失败的提示；非房主不出现。 */
export function CEEPresetBar({
  readOnly,
  presets,
  presetName,
  fileError,
  onApplyPreset,
  onExport,
  onImport,
}: {
  readOnly: boolean;
  presets: Record<string, CEESettings>;
  presetName: string;
  fileError: string;
  onApplyPreset: (name: string) => void;
  onExport: () => void;
  onImport: (file?: File) => void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  return (
    <>
      {!readOnly ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <SettingSelect
              label="玩法预设"
              value={presetName}
              onChange={(name) => {
                if (name) onApplyPreset(name);
              }}
              options={[
                { value: "", label: "选择预设" },
                ...Object.keys(presets).map((name) => ({ value: name, label: name })),
              ]}
            />
          </div>
          <Button variant="outline" onClick={onExport}>
            <Download />
            导出
          </Button>
          <Button variant="outline" onClick={() => upload.current?.click()}>
            <Upload />
            导入
          </Button>
          <input
            ref={upload}
            type="file"
            accept="application/json,.json"
            aria-label="导入玩法配置"
            className="hidden"
            onChange={(event) => {
              onImport(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      ) : null}
      {fileError ? (
        <p role="alert" className="text-xs text-destructive">
          {fileError}
        </p>
      ) : null}
    </>
  );
}
