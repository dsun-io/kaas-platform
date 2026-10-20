"use client";

/**
 * 签发闸门的阻断清单（A7-3）
 *
 * 用户价值：签发被拦时**不能只弹一句 toast**。业务员需要知道"是哪一项、为什么、
 * 去哪改" —— 所以这里列出后端 422 里的整份 `blocking`，并把「去确认事实」做成
 * 直达按钮（切到事实面板）。只展示**后端给的**阻断项，前端不自己造判定。
 *
 * 刻意**不暴露** `allow_lint_override`：越过闸门是运维/紧急场景的内部动作
 * （后端会写审计），界面上不给入口就不会被误点成"常规操作"。
 */
import { AlertTriangle, ArrowRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BlockingItem, ConfirmBlocked } from "@/lib/trade-doc/hardening";

/** 四种阻断 code 的人话解释（与后端 `ws_docs_hardening` 的错误码一一对应）。 */
const CODE_LABEL: Record<string, { title: string; hint: string }> = {
  FACT_UNVERIFIED: {
    title: "存在未确认事实",
    hint: "付款条款等推断值必须逐项核对确认后才能签发",
  },
  FACT_IMMUTABLE: {
    title: "不可改写事实被修改",
    hint: "派生单只能原值引用基线事实，改值需作废重开或改上游",
  },
  DOC_REF_BROKEN: {
    title: "引用单证不可用",
    hint: "引用的单证不存在或未签发 —— 派生单只能引用已签发的单证",
  },
  DOC_SET_NOT_ALLOWED: {
    title: "越权出单",
    hint: "清单标注该单据由对方出单，但同交易域已存在我方开的这类单据",
  },
};

function labelOf(item: BlockingItem) {
  return (
    CODE_LABEL[item.code] ?? {
      title: item.code,
      hint: "后端未登记的阻断类型，按明细处置",
    }
  );
}

interface Props {
  blocked: ConfirmBlocked | null;
  /** 切到事实面板（用户点「去确认事实」） */
  onGoToFacts: () => void;
  onDismiss?: () => void;
}

export function DocConfirmGate({ blocked, onGoToFacts, onDismiss }: Props) {
  if (!blocked) return null;
  const primary = CODE_LABEL[blocked.code];

  return (
    <div
      role="alert"
      className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" />
        签发被阻断：{primary?.title ?? blocked.code}
        {blocked.message && (
          <span className="text-xs font-normal text-muted-foreground">
            {blocked.message}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" onClick={onGoToFacts}>
            去确认事实
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          {onDismiss && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="关闭阻断提示"
              onClick={onDismiss}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {blocked.blocking.map((item, index) => {
          const label = labelOf(item);
          return (
            <li
              key={`${item.code}-${index}`}
              className="rounded-md bg-background/70 px-2 py-1 text-xs"
            >
              <span className="font-mono text-destructive">{item.code}</span>
              <span className="ml-1 font-medium">{label.title}</span>
              {item.keys?.length ? (
                <span className="ml-1 text-muted-foreground">
                  涉及事实：{item.keys.join("、")}
                </span>
              ) : null}
              {item.doc_no ? (
                <span className="ml-1 text-muted-foreground">
                  单据：{item.doc_no}
                </span>
              ) : null}
              <p className="mt-0.5 text-muted-foreground">
                {item.detail || label.hint}
              </p>
              {item.evidence_ref ? (
                <p className="text-muted-foreground">
                  证据要求：{item.evidence_ref}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
