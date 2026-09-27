"use client";

/**
 * 多产品报价 · 整单汇总与提交动作。
 *
 * 汇总的口径与单证完全同源（逐行求和、金额不预先舍入）：
 * 报价工位看到的总额、单证上 TOTAL 行的金额、报价单落库的 `total_amount`
 * 三者必须逐分一致 —— 凡是在某一处先四舍五入再相加，就会差 1 分，
 * 而这种差异在界面上"看着完全正常"。
 */
import { AlertTriangle, FileText, Loader2, Save, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { QuoteSummary } from "../lib/line-to-item";

export interface DocTypeOption {
  value: string;
  label: string;
}

interface Props {
  summary: QuoteSummary;
  currency: string;
  /** 实际占用体积（已按产品定义声明的口径扣减）；无声明时为 null */
  effectiveVolume: number | null;
  /** 逐行缺失的单证要素（行号从 1 起） */
  missing: { index: number; keys: string[] }[];
  /** 被分摊的整批费用项名（已按件数分摊） */
  amortizedFees: string[];
  docTypes: DocTypeOption[];
  docPick: string[];
  onDocPickChange: (next: string[]) => void;
  onGenerateDocs: () => void;
  onSave: () => void;
  onIssue: () => void;
  saving: boolean;
  issuing: boolean;
  generating: boolean;
  saved: { id: number; quote_no: string; status: string } | null;
  notice: { tone: "info" | "error"; text: string } | null;
}

function num(value: number, digits = 2): string {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function QuoteSummaryCard({
  summary,
  currency,
  effectiveVolume,
  missing,
  amortizedFees,
  docTypes,
  docPick,
  onDocPickChange,
  onGenerateDocs,
  onSave,
  onIssue,
  saving,
  issuing,
  generating,
  saved,
  notice,
}: Props) {
  const hasLines = summary.lineCount > 0;

  const toggleDoc = (value: string) => {
    onDocPickChange(
      docPick.includes(value)
        ? docPick.filter((v) => v !== value)
        : [...docPick, value],
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">整单汇总</CardTitle>
            <p className="text-xs text-muted-foreground">
              {summary.lineCount} 个产品行 · 总额 = 各行小计之和（与单证 TOTAL 同源）
            </p>
          </div>
          {saved && (
            <div className="text-right text-xs">
              <div className="font-medium">{saved.quote_no}</div>
              <div className="text-muted-foreground">
                {saved.status === "draft" ? "草稿（可继续改）" : saved.status}
              </div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 xl:grid-cols-6">
          <div>
            <dt className="text-muted-foreground">总额（{currency}）</dt>
            <dd className="text-base font-semibold tabular-nums">
              {hasLines ? num(summary.totalAmount) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">总卷数</dt>
            <dd className="tabular-nums">{num(summary.totalQty, 0)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">总米数</dt>
            <dd className="tabular-nums">{num(summary.totalMeters, 0)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">净重 / 毛重（KGS）</dt>
            <dd className="tabular-nums">
              {num(summary.totalNetWeight)} / {num(summary.totalGrossWeight)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">体积（CBM）</dt>
            <dd className="tabular-nums">
              {num(summary.totalBoxVolume, 4)}
              {effectiveVolume !== null && effectiveVolume !== summary.totalBoxVolume && (
                <span className="ml-1 text-muted-foreground">
                  （实际占用 {num(effectiveVolume, 4)}）
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">单证要素</dt>
            <dd className={cn(missing.length > 0 && "text-warning-muted-foreground")}>
              {missing.length === 0 ? "齐全" : `${missing.length} 行待补`}
            </dd>
          </div>
        </dl>

        {amortizedFees.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            整批费用（{amortizedFees.join("、")}）已按**件数比例**分摊到每个产品行，
            逐行累加等于你填写的整批金额；摊到单卷后各行一致。
          </p>
        )}

        {missing.length > 0 && (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              第 {missing.map((m) => m.index).join("、")} 行缺
              {Array.from(new Set(missing.flatMap((m) => m.keys))).join("、")}。
              空白会原样留在单证上（不填 0），请在单证工位补齐后再签发。
            </p>
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium">生成单证</p>
          <div className="flex flex-wrap gap-2">
            {docTypes.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => toggleDoc(t.value)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-xs transition-colors",
                  docPick.includes(t.value)
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "border-input text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            单据会继承本报价单的产品行、金额与贸易条款；签发后才结算为正式凭证。
          </p>
        </div>

        {notice && (
          <p
            className={cn(
              "text-xs",
              notice.tone === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {notice.text}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={!hasLines || saving}
            onClick={onSave}
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            {saved ? "保存修改" : "保存为报价单"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={!hasLines || generating}
            onClick={onGenerateDocs}
          >
            {generating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileText className="size-3.5" />
            )}
            生成所选单证（{docPick.length}）
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!saved || saved.status !== "draft" || issuing}
            onClick={onIssue}
          >
            {issuing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            签发报价单
          </Button>
          {!hasLines && (
            <span className="text-[11px] text-muted-foreground">
              至少计算一行后才能保存
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
