import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

export function CCBSelect({ label, value, onChange, options, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>; disabled?: boolean;
}) {
  return <Select value={value || "__all"} onValueChange={(next) => onChange(next === "__all" ? "" : next)} disabled={disabled}>
    <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option.value || "__all"} value={option.value || "__all"}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
