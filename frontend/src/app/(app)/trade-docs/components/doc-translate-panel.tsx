"use client";

/**
 * 单证「中译英」面板（A13）
 *
 * 为什么放在「单证加固」新 tab，而不是详情工具栏：
 * - 它是**单证级的内容处理**（一次翻一批手工字段），不是对某个输入框的上下文操作；
 *   工具栏已有「签发 / 关闭」等页级动作，再加第三个按钮会让页级动作和内容动作混在一起。
 * - 加固区已经拿得到 `docId` / `status`，tab 容器现成；不用改 `page.tsx` 工具栏，
 *   并行开发时改动面最小。
 *
 * 诚实性约束（后端契约见 `ws_docs_ext.py translate_trade_doc`）：
 * - `path="template"` = **AI 不可用、后端原样返回** ⇒ 必须提示"请人工翻译"，不能显示成已翻译；
 * - 非 draft 后端不写回 ⇒ UI 明说"未写回（非草稿）"，不假装已保存；
 * - 逐行标出"译文=原文"的字段（AI 解析层对没译到的键会回退原文）。
 */
import { useMemo, useState } from "react";
import { ArrowRight, Languages, Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  aiProviderOf,
  buildTranslateFields,
  collectTranslatableFields,
  isTemplateFallback,
  isUnchangedTranslation,
  translatePathLabel,
  type TranslateResponse,
  type TranslatableField,
} from "@/lib/trade-doc/translate";

import {
  useTradeDocRenderData,
  useTranslateTradeDoc,
} from "../hooks/use-trade-docs";

interface Outcome {
  response: TranslateResponse;
  requested: Record<string, string>;
}

function describeError(err: unknown): string {
  const response = (err as { response?: { data?: { detail?: unknown } } })
    ?.response;
  const detail = response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") {
    const record = detail as { detail?: unknown; message?: unknown };
    const nested = record.detail ?? record.message;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return err instanceof Error && err.message.trim()
    ? err.message
    : "翻译请求失败";
}

export function DocTranslatePanel({
  docId,
  status,
}: {
  docId: number;
  status: string | null;
}) {
  const renderData = useTradeDocRenderData(docId);
  const translate = useTranslateTradeDoc(docId);
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const doc = renderData.data?.doc ?? null;
  const docType = doc?.doc_type ?? "";
  const custom = doc?.raw_payload?.custom ?? null;
  const fields = useMemo(
    () => collectTranslatableFields(docType, custom),
    [docType, custom],
  );

  const selected: Record<string, boolean> = {};
  for (const field of fields) selected[field.name] = !unchecked[field.name];
  const selectedCount = fields.filter((field) => selected[field.name]).length;
  const isDraft = (status ?? doc?.status ?? "") === "draft";

  const labelOf = (name: string): string =>
    fields.find((field) => field.name === name)?.label ?? name;

  const run = async () => {
    const payload = buildTranslateFields(fields, selected);
    if (Object.keys(payload).length === 0) return;
    setOutcome(null);
    try {
      const response = await translate.mutateAsync({
        fields: payload,
        target: "en",
      });
      setOutcome({ response, requested: payload });
    } catch {
      // 真错误（404/403/网络）由下方 isError 分支展示，这里只清空旧结论
      setOutcome(null);
    }
  };

  if (renderData.isLoading) {
    return (
      <p className="py-6 text-sm text-muted-foreground">正在读取单据内容…</p>
    );
  }
  if (renderData.isError) {
    return (
      <p className="py-6 text-sm text-destructive">
        读取单据内容失败，无法列出可翻译的内容。
      </p>
    );
  }

  const fallback = Boolean(
    outcome && isTemplateFallback(outcome.response.path),
  );
  const provider = outcome ? aiProviderOf(outcome.response.path) : null;

  return (
    <div className="space-y-3">
      <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        只翻译<b>手工填写的内容</b>里<b>含中文的文本内容项</b>
        ；上游带入的英文 / 日期 / 数字 / 图片不在此列。翻译由系统自动完成
        —— 未开通自动翻译时会<b>原样返回</b>，请以结果区提示为准。
      </div>

      {fields.length === 0 ? (
        <p
          data-testid="translate-empty"
          className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground"
        >
          当前没有需要翻译的中文内容（已填英文或尚未填写）。
        </p>
      ) : (
        <>
          <ul className="divide-y rounded-md border">
            {fields.map((field: TranslatableField) => {
              const checked = selected[field.name];
              return (
                <li key={field.name} className="flex gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    data-field={field.name}
                    aria-label={`选择翻译内容项 ${field.label}`}
                    checked={checked}
                    onChange={(event) =>
                      setUnchecked((prev) => ({
                        ...prev,
                        [field.name]: !event.target.checked,
                      }))
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{field.label}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {field.text}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void run()}
              disabled={translate.isPending || selectedCount === 0}
            >
              {translate.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Languages className="mr-1 h-4 w-4" />
              )}
              翻译为英文（{selectedCount} 项内容）
            </Button>
            <span className="text-xs text-muted-foreground">
              {isDraft
                ? "草稿态：翻译成功后会自动写回并记录一条内容版本"
                : "非草稿：只显示译文，不写回单据"}
            </span>
          </div>
        </>
      )}

      {translate.isError && !outcome && (
        <p
          data-testid="translate-error"
          className="rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning-muted-foreground"
        >
          翻译请求失败：{describeError(translate.error)}
        </p>
      )}

      {outcome && (
        <div
          data-testid="translate-result"
          className={
            fallback
              ? "space-y-2 rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-warning-muted-foreground"
              : "space-y-2 rounded-md border border-success/40 bg-success-muted px-3 py-2 text-success-muted-foreground"
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {fallback ? (
              <ShieldAlert className="h-4 w-4" />
            ) : (
              <Languages className="h-4 w-4" />
            )}
            <span className="font-medium">
              {translatePathLabel(outcome.response.path)}
            </span>
            {provider && <StatusBadge tone="success">AI 已返回</StatusBadge>}
            {fallback && <StatusBadge tone="warning">未翻译</StatusBadge>}
          </div>

          {fallback ? (
            <p className="text-xs">
              自动翻译暂不可用：系统已<b>原样返回原文</b>，请
              <b>人工翻译</b>后再填写。
              {isDraft
                ? "草稿态会把这批原样值写回并记一条内容版本（值没变，等于没翻译）。"
                : "非草稿：未写回。"}
            </p>
          ) : (
            <p className="text-xs">
              {isDraft
                ? "已写回草稿，并记录一条内容版本。"
                : "未写回（非草稿）：译文仅供参考，如需保存请退回草稿或手工填写。"}
            </p>
          )}

          <ul className="space-y-1">
            {Object.entries(outcome.requested).map(([name, original]) => {
              const translated = outcome.response.fields[name] ?? "";
              const unchanged =
                isUnchangedTranslation(original, translated) && !fallback;
              return (
                <li
                  key={name}
                  className="rounded-md bg-white/60 px-2 py-1 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-1 font-medium">
                    <span>{labelOf(name)}</span>
                    {unchanged && (
                      <StatusBadge tone="warning">
                        未翻译（回退原文）
                      </StatusBadge>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <span className="break-words opacity-80">{original}</span>
                    <ArrowRight className="h-3 w-3 opacity-60" />
                    <span className="break-words font-medium">
                      {translated || "（系统没有返回这一项的译文）"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
