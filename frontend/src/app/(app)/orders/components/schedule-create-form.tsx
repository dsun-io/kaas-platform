"use client";

/**
 * 「新增收款计划」内联表单（从巨面板拆出）。
 *
 * 表单只管渲染与受控输入；草稿 state 与提交/错误由外层编排（Panel）持有 ——
 * 这样「收起表单」「成功后重置草稿」不需要把业务副作用塞进表单组件。
 *
 * 契约提示（与后端一致）：金额优先，留空才按比例 × 订单总额；比例与金额至少填一个
 * （前端先拦，最终仍由后端校验）。
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SCHEDULE_TYPES,
  SCHEDULE_TYPE_LABEL,
} from "@/lib/orders/payment-schedules";

export interface ScheduleDraft {
  schedule_type: string;
  ratio: string;
  amount: string;
  due_date: string;
  notes: string;
}

export const EMPTY_SCHEDULE_DRAFT: ScheduleDraft = {
  schedule_type: "deposit",
  ratio: "",
  amount: "",
  due_date: "",
  notes: "",
};

export function ScheduleCreateForm({
  draft,
  onChange,
  onSubmit,
  pending,
  error,
}: {
  draft: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5">
      <label className="space-y-1">
        <span className="text-sm font-medium">类型 *</span>
        <select
          aria-label="收款类型"
          className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
          value={draft.schedule_type}
          onChange={(event) => onChange({ schedule_type: event.target.value })}
        >
          {SCHEDULE_TYPES.map((type) => (
            <option key={type} value={type}>
              {SCHEDULE_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-sm font-medium">比例（0~1）</span>
        <Input
          aria-label="比例"
          value={draft.ratio}
          inputMode="decimal"
          placeholder="如 0.3"
          onChange={(event) => onChange({ ratio: event.target.value })}
        />
      </label>
      <label className="space-y-1">
        <span className="text-sm font-medium">金额</span>
        <Input
          aria-label="金额"
          value={draft.amount}
          inputMode="decimal"
          placeholder="留空 = 按比例 × 订单总额"
          onChange={(event) => onChange({ amount: event.target.value })}
        />
      </label>
      <label className="space-y-1">
        <span className="text-sm font-medium">到期日</span>
        <Input
          aria-label="到期日"
          type="date"
          value={draft.due_date}
          onChange={(event) => onChange({ due_date: event.target.value })}
        />
      </label>
      <label className="space-y-1">
        <span className="text-sm font-medium">备注</span>
        <Input
          aria-label="备注"
          value={draft.notes}
          onChange={(event) => onChange({ notes: event.target.value })}
        />
      </label>
      <div className="sm:col-span-2 lg:col-span-5">
        <Button size="sm" onClick={onSubmit} disabled={pending}>
          {pending ? "创建中…" : "创建收款计划"}
        </Button>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          后端以「金额优先、否则比例×订单总额」补算金额；比例与金额至少填一个（前端先拦）。
        </p>
      </div>
    </div>
  );
}
