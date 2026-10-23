"use client";

/**
 * 「高级 JSON」页签（U-P1D2 从 product-spec-editor 拆出）。
 *
 * P14 硬约束：JSON 文本框原样保留。它是唯一真源，与表单双向同步；
 * 语法错误时主组件锁定表单并在这里提示。
 */
export function JsonTab({
  specJson,
  onChange,
  parseOk,
}: {
  specJson: string;
  onChange: (next: string) => void;
  parseOk: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        直接改 JSON（与表单双向同步，改完即生效）。语法错误时表单会锁定，修正后
        自动解锁。
      </p>
      <textarea
        value={specJson}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        className="w-full rounded border px-2 py-1 font-mono text-xs"
      />
      {!parseOk && (
        <p className="text-xs text-destructive">
          JSON 语法错误 —— 表单已锁定，修正后自动解锁。
        </p>
      )}
    </div>
  );
}
