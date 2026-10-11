"use client";

/**
 * 工位多选（注册页 / 建团队共用）。
 *
 * 为什么要有这个公用组件：注册和建团队都要"勾选要开通的工位"，
 * 抄两遍必然出现"两处选项顺序不同 / 名字不同"——选项一律由
 * `subscribableWorkstationOptions()`（读契约）派生。
 */
import { Label } from "@/components/ui/label";
import { subscribableWorkstationOptions } from "@/lib/workstation/visibility";

const STATION_OPTIONS = subscribableWorkstationOptions();

interface WorkstationPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 同一页面出现多个 picker 时区分 label 的 htmlFor */
  idPrefix?: string;
  hint?: string;
}

export function WorkstationPicker({
  value,
  onChange,
  disabled = false,
  idPrefix = "ws",
  hint = "之后可在「团队与工位」里随时开通或停用。",
}: WorkstationPickerProps) {
  function toggle(key: string) {
    onChange(
      value.includes(key) ? value.filter((k) => k !== key) : [...value, key],
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-stations`}>
        要开通的工位 *（当前全部免费）
      </Label>
      <div id={`${idPrefix}-stations`} className="grid grid-cols-2 gap-1.5">
        {STATION_OPTIONS.map((station) => (
          <label
            key={station.key}
            className="flex cursor-pointer items-center gap-1.5 text-sm"
          >
            <input
              type="checkbox"
              checked={value.includes(station.key)}
              onChange={() => toggle(station.key)}
              disabled={disabled}
            />
            {station.name}
          </label>
        ))}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
