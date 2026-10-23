"use client";

/**
 * 向导顶部步骤条（U-P1D2 拆分）：标题 / 完成勾 / 当前步骤 / 提示行。
 * 只负责展示与跳转回调，不持有任何状态（状态在主组件的 data hook 里）。
 */
import { Check, ChevronRight } from "lucide-react";

export function WizardStepper({
  steps,
  step,
  maxStep,
  onGoTo,
}: {
  steps: readonly { title: string; hint: string }[];
  step: number;
  maxStep: number;
  onGoTo: (index: number) => void;
}) {
  return (
    <>
      <ol className="flex flex-wrap items-center gap-1" aria-label="建单步骤">
        {steps.map((item, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={item.title} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={active ? "step" : undefined}
                disabled={index > maxStep}
                onClick={() => onGoTo(index)}
                className={`inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
              >
                <span
                  className={`flex size-5 items-center justify-center rounded-full text-[11px] ${
                    done || active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="size-3" /> : index + 1}
                </span>
                {item.title}
              </button>
              {index < steps.length - 1 && (
                <ChevronRight className="size-3.5 text-muted-foreground/60" />
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{steps[step]?.hint}</p>
    </>
  );
}
