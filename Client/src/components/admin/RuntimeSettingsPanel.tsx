import { useState } from "react";
import type { AdminRuntimeSetting } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  SettingSwitchRow,
  SettingTextField,
  SettingsFields,
} from "@/components/common/room/SettingFields";
import { AdminTable, AdminToolbar, QueryState } from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { formatDateTime } from "@/lib/AdminFormat";

/** 旋钮对管理员只有「开 / 关」与「版本号」两种读法；`true`/`false` 只存在于存储与校验里。 */
const readValue = (kind: AdminRuntimeSetting["kind"], value: string): string =>
  kind === "boolean" ? (value === "true" ? "开" : "关") : value || "不设门槛";

/** 生效值与库内覆盖值不一致，说明库里那条已经不被当前校验接受。 */
const isStaleStored = (item: AdminRuntimeSetting): boolean =>
  item.storedValue !== null && item.storedValue !== item.effectiveValue;

function Editor({
  item,
  value,
  onChange,
}: {
  item: AdminRuntimeSetting;
  value: string;
  onChange: (value: string) => void;
}) {
  if (item.kind === "boolean") {
    return (
      <SettingSwitchRow
        label={item.title}
        description={item.note}
        checked={value === "true"}
        onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
      />
    );
  }
  return (
    <SettingTextField
      label={item.title}
      value={value}
      onChange={onChange}
      placeholder="0.1.2，留空表示不设门槛"
      maxLength={64}
      description={item.note}
    />
  );
}

/** 改一个旋钮：只提交这一个键，成功后整表刷新，失败文案留在弹窗里。 */
function EditDialog({
  item,
  onOpenChange,
  onSaved,
}: {
  item: AdminRuntimeSetting;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(item.effectiveValue);
  const action = useAdminAction();
  const save = async () => {
    const ok = await action.run(
      "save",
      async () => {
        await api.admin.settings.set({ key: item.key, value });
        onSaved();
      },
      "保存失败，请稍后重试"
    );
    if (ok) onOpenChange(false);
  };
  return (
    <Dialog open onOpenChange={(next) => !action.busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item.title}</DialogTitle>
          <DialogDescription>
            环境变量 {item.envVar} 的缺省值是 {readValue(item.kind, item.defaultValue)}。
            这里填的值会盖过它；填成与缺省相同的值即可回到跟随环境变量。
          </DialogDescription>
        </DialogHeader>
        <SettingsFields>
          <Editor item={item} value={value} onChange={setValue} />
        </SettingsFields>
        {action.error ? (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(action.busy)}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" loading={Boolean(action.busy)} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 运行期旋钮（T3）：值存在数据库里，环境变量同名项只是缺省（见 Server/docs/Database.md）。
 * 改完本进程立刻生效，其余分片按缓存周期收敛。
 */
export function RuntimeSettingsPanel() {
  const query = useAdminQuery(
    "runtimeSettings",
    async () => (await api.admin.settings.list()).items,
    "运行期设置加载失败"
  );
  const [editing, setEditing] = useState<AdminRuntimeSetting | null>(null);
  const items = query.data ?? [];

  return (
    <div>
      <AdminToolbar
        title="运行期旋钮"
        onReload={query.reload}
        loading={query.loading && Boolean(query.data)}
      />
      <p className="mb-4 text-sm text-muted-foreground">
        这几项的生效值存在站点数据库里，环境变量同名项只作缺省；改完不需要重建容器。
        保存的写操作会记进审计。
      </p>
      <QueryState
        loading={query.loading}
        error={query.error}
        empty={Boolean(query.data) && !items.length}
        hasData={Boolean(query.data)}
        onRetry={query.reload}
        emptyText="没有可运行期调整的配置项"
      />
      {items.length ? (
        <AdminTable label="运行期旋钮">
          <thead>
            <tr>
              <th scope="col">旋钮</th>
              <th scope="col">生效值</th>
              <th scope="col">取值来源</th>
              <th scope="col">环境变量缺省</th>
              <th scope="col">最后修改</th>
              <th scope="col"> </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td className="max-w-64">
                  <span className="block font-medium">{item.title}</span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    {item.note}
                  </span>
                </td>
                <td className="whitespace-nowrap font-mono">
                  {readValue(item.kind, item.effectiveValue)}
                </td>
                <td className="whitespace-nowrap">
                  <span className="flex flex-wrap gap-1">
                    {item.storedValue === null ? (
                      <Badge variant="subtle" size="xs">
                        环境变量缺省
                      </Badge>
                    ) : (
                      <Badge variant="active" size="xs">
                        库内覆盖
                      </Badge>
                    )}
                    {isStaleStored(item) ? (
                      <Badge variant="restricted" size="xs">
                        库值已失效
                      </Badge>
                    ) : null}
                  </span>
                </td>
                <td className="whitespace-nowrap font-mono text-muted-foreground">
                  {readValue(item.kind, item.defaultValue)}
                  <span className="ml-2 font-sans text-xs">{item.envVar}</span>
                </td>
                <td className="whitespace-nowrap text-muted-foreground">
                  {item.updatedAt
                    ? `${item.updatedBy ?? "未知"} · ${formatDateTime(item.updatedAt)}`
                    : "—"}
                </td>
                <td>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={query.loading}
                    onClick={() => setEditing(item)}
                  >
                    修改
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      {editing ? (
        <EditDialog
          key={editing.key}
          item={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={query.reload}
        />
      ) : null}
    </div>
  );
}
