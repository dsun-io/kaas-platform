"use client";

/**
 * 开单前「完整成品预览」（2026-10-24，用户需求 1）。
 *
 * 用户原话：「在正式生成单证之前我需要完整预览单证」。上一版用「样板底稿 + 表单已填值」
 * 在本地拼数据（`buildCreatePreviewData`），货物/金额/条款其实还是样板占位 —— 用户反馈
 * 那不算完整预览。现在改为：
 *   · 打开对话框（或切换类型）时调内核**只读**端点
 *     `POST /trade-docs/preview-render-data`（入参与开单 `POST /trade-docs` 同形状，单张）；
 *   · 用返回的 `data`（与已落库单据 `GET /trade-docs/{id}/render-data` 同源同形状）
 *     走 `renderTradeDoc(doc_type, data)` 在 iframe 里只读渲染 —— 真实货物/金额/条款；
 *   · 多选类型时对话框内可逐类切换，每类单独请求（查询键含全部入参）。
 *
 * 三条硬边界
 * ----------
 * - **不写库**：只调 `preview-render-data`，绝不调 `POST /trade-docs`（那是「开单」按钮的事）。
 * - **不拿样板冒充完整预览**：接口失败就显示明确错误 + 重试，不退回 `sample-data.json`。
 * - **只读**：不提供签发/归档/上传入口（那些需要真实单据 id），只校对成品内容与版式。
 *
 * 必填没填全（类型/客户/来源）时入口直接禁用，并把缺哪几项如实列出来 ——
 * 不让用户点开一个空单据猜「是我没填还是系统没带过来」。
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Eye, Loader2, RefreshCw } from "lucide-react";

import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { normalizeApiError } from "@/lib/api/api-error";
import { findMissingRequiredFields } from "@/lib/trade-doc/compliance";
import { renderTradeDoc } from "@/lib/trade-doc/render";
import { cn } from "@/lib/utils";

import {
  usePreviewRenderData,
  type PreviewRenderDataRequest,
} from "../hooks/use-preview-render-data";

/** 可预览的单证类型（中文名用于对话框标题与类型切换按钮）。 */
export interface DocPreviewTypeOption {
  docType: string;
  label: string;
}

export interface DocCreatePreviewProps {
  /** 表单当前勾选、可预览的类型（顺序 = 勾选顺序） */
  options: DocPreviewTypeOption[];
  /**
   * 开单公共入参（不含 doc_type）= 提交时也会原样送给后端的字段
   * （客户/币种/盖章/上游 id）；`null` = 连客户都还没选 ⇒ 入口禁用。
   */
  base: Omit<PreviewRenderDataRequest, "doc_type"> | null;
  /** 表单还缺哪些必填项（中文名）；非空 ⇒ 入口禁用并列出 */
  blockers: string[];
}

/**
 * 内核预览端点的业务错误码 → 中文说明（见 task-5 契约）。
 *
 * 只做**展示层**翻译：后端 422/404 的 `detail` 只有 error/code（没有 message），
 * 直接展示 axios 的英文 "Request failed with status code 404" 等于没告诉用户原因。
 * 未知码仍回退后端 message / 兜底文案，不吞错误。
 */
const PREVIEW_ERROR_TEXT: Record<string, string> = {
  // 缺 doc_type 的内核错误**只有 error 字符串**（没有 code / message）——
  // 按 error 值也放一条，否则展示层会退成英文 axios 文案。
  bad_doc_type: "单证类型无效，请重新选择要预览的类型",
  CUSTOMER_REQUIRED: "请先选择业务客户",
  PARENT_CONFLICT: "来源只能三选一（订单 / 报价单 / 询盘），不能同时给",
  INVALID_ORDER_ID: "来源订单无效（不存在或无权访问）",
  INVALID_QUOTE_ID: "来源报价单无效（不存在或无权访问）",
  INVALID_INQUIRY_ID: "询盘编号无效（不存在或无权访问）",
  CUSTOM_FIELD_PROTECTED: "有字段受保护，不能作为自定义字段传入",
  CUSTOMER_NOT_FOUND: "业务客户不存在，或当前账号无权访问",
  ORDER_NOT_FOUND: "来源订单不存在，或当前账号无权访问",
  QUOTE_NOT_FOUND: "来源报价单不存在，或当前账号无权访问",
  INQUIRY_NOT_FOUND: "询盘不存在，或当前账号无权访问",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 从异常里取内核错误体的原始字段（兼容扁平 `{error}` 与嵌套 `{detail:{...}}`）。
 *
 * 为什么要绕过 `normalizeApiError` 单独取：归一化结果只暴露 `code`，
 * 而这条端点有 `{"error":"bad_doc_type"}`（无 code）与 `detail.detail`（更具体的中文原因）
 * 两种形态，不取就只能显示英文 "-AxiosError: Request failed with status code 422"。
 */
function rawErrorFields(error: unknown): {
  code: string | null;
  error: string | null;
  detail: string | null;
} {
  const outer = asRecord(error);
  const response = asRecord(outer?.response);
  const body = asRecord(response?.data);
  const nested = asRecord(body?.detail);
  const source = nested ?? body;
  return {
    code: asText(source?.code) ?? asText(source?.error_code),
    error: asText(source?.error) ?? asText(body?.error),
    // 文档化错误里 detail.detail 是给人看的中文原因（还有 field/value 供定位）
    detail: asText(source?.detail),
  };
}

/** 预览失败的原因文案：具体中文原因 > 错误码映射 > 后端 message > 兜底。 */
function previewErrorMessage(error: unknown): string {
  const normalized = normalizeApiError(error);
  const raw = rawErrorFields(error);
  const key = normalized.code ?? raw.code ?? raw.error;
  const mapped = key ? PREVIEW_ERROR_TEXT[key] : undefined;
  return raw.detail ?? mapped ?? normalized.message;
}

/** 未知类型不该让整个对话框崩掉（与 DocPreview 同一口径）。 */
const RENDER_FAILED_HTML = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
  <h2>无法渲染该单证</h2><p>该单证类型没有对应模板，请换一种类型再预览。</p></body></html>`;

export function DocCreatePreview({
  options,
  base,
  blockers,
}: DocCreatePreviewProps) {
  const [open, setOpen] = useState(false);
  const [pickedType, setPickedType] = useState<string | null>(null);

  const blocked = blockers.length > 0 || options.length === 0 || base === null;
  const blockedReason =
    blockers.length > 0
      ? `完整预览不可用：还缺必填「${blockers.join("、")}」`
      : "完整预览不可用：请先选择单证类型";

  // 默认预览第一张；用户切换过后记住选择。表单类型被取消时自动退回第一张，
  // 不在 effect 里 setState（避免多一轮渲染）。
  const activeType =
    options.find((option) => option.docType === pickedType) ??
    options[0] ??
    null;
  const request: PreviewRenderDataRequest | null =
    activeType && base ? { ...base, doc_type: activeType.docType } : null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={blocked}
          onClick={() => setOpen(true)}
          title={
            blocked
              ? blockedReason
              : "按真实客户与上游数据预览完整成品（不写库、不生成单据）"
          }
        >
          <Eye className="mr-1 h-4 w-4" aria-hidden="true" />
          完整预览
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {blocked
            ? blockedReason
            : "开单前先看完整成品：按真实客户/上游数据渲染，不写库、不生成单据"}
        </span>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-full overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              完整成品预览 · {activeType?.label ?? "未选择类型"}
            </DialogTitle>
            <DialogDescription>
              内容由内核按当前表单的真实客户与上游（订单 / 报价单 / 询盘）装配，
              与开单后的成品同源同版式。预览只读、不写库、不生成单据，关闭即丢弃。
            </DialogDescription>
          </DialogHeader>

          {options.length > 1 && (
            <div
              role="group"
              aria-label="选择要预览的单证类型"
              className="flex flex-wrap gap-1.5"
            >
              {options.map((option) => {
                const active = option.docType === activeType?.docType;
                return (
                  <button
                    key={option.docType}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPickedType(option.docType)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs",
                      active
                        ? "border-primary bg-primary/10 font-medium"
                        : "hover:bg-muted",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}

          {/*
            只在对话框打开时才挂载预览体：关闭状态下不调用查询 hook
            ⇒ 页面/表单渲染时一个 `preview-render-data` 请求都不会发。
          */}
          {open && request ? (
            <PreviewBody request={request} label={activeType?.label ?? ""} />
          ) : null}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              关闭
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 单个类型的完整预览体：取数 → 渲染 → 加载/错误态。 */
function PreviewBody({
  request,
  label,
}: {
  request: PreviewRenderDataRequest;
  label: string;
}) {
  const query = usePreviewRenderData(request);
  const preview = query.data ?? null;

  const html = useMemo(() => {
    if (!preview) return "";
    try {
      return renderTradeDoc(
        request.doc_type,
        preview.data ?? ({} as Record<string, unknown>),
      );
    } catch {
      return RENDER_FAILED_HTML;
    }
  }, [preview, request.doc_type]);

  // 后端装配结果仍可能缺字段（例如直接挂客户、没有上游货物）——
  // 如实点出来，而不是让用户以为「完整预览」就一定齐全。
  const missing = useMemo(
    () =>
      preview
        ? findMissingRequiredFields(
            request.doc_type,
            preview.data ?? ({} as Record<string, unknown>),
          )
        : [],
    [preview, request.doc_type],
  );

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="flex items-center gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        正在按真实客户与上游装配完整成品…
      </div>
    );
  }

  if (query.isError) {
    const message = previewErrorMessage(query.error);
    return (
      <div
        role="alert"
        className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <div className="flex items-center gap-1 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          完整预览生成失败
        </div>
        <p className="text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          预览只是读取，不会生成单据；请确认客户与上游数据仍可用后重试。
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            className={cn(
              "mr-1 h-3.5 w-3.5",
              query.isFetching && "animate-spin",
            )}
            aria-hidden="true"
          />
          重试
        </Button>
      </div>
    );
  }

  if (!preview) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={missing.length === 0 ? "success" : "warning"} dot>
          {missing.length === 0
            ? "版式必填项齐全"
            : `成品有 ${missing.length} 个字段为空`}
        </StatusBadge>
        <StatusBadge tone="info" dot={false}>
          真实数据 · 未落库
        </StatusBadge>
        <span className="text-xs text-muted-foreground">
          {preview.doc?.doc_no
            ? preview.doc.id != null
              ? `该上游已有这张单：${preview.doc.doc_no}（预览的就是它）`
              : `预览编号（只读计算、未占用）：${preview.doc.doc_no}`
            : "单号：开单后生成"}
        </span>
        <span className="text-xs text-muted-foreground">
          只读预览：不能签发 / 归档，正式单据请开单后在单据预览里处理
        </span>
      </div>

      {!preview.company_profile_configured && (
        <div className="rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning-muted-foreground">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            企业信息尚未配置
          </div>
          卖方抬头、银行等公司信息为空，成品上的卖方块会是空的；
          可先去「企业信息」补齐（其余内容仍可预览）。
        </div>
      )}

      {missing.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning-muted-foreground">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            以下字段在这张成品上仍为空
          </div>
          {/* 如实告知 ≠ 阻塞：直接挂客户（没有上游）时货物/金额本来就没有，
              预览就该显示空；这里只提示"成品会长这样"，不催用户在本对话框里填。 */}
          <p className="mb-1 text-xs">
            预览如实反映开单结果；如需补全，可在开单后到单据详情里编辑。
          </p>
          <ul className="ml-5 list-disc space-y-0.5">
            {missing.map((item) => (
              <li key={item.field}>
                {item.label}
                <span className="ml-1 opacity-80">({item.field})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded-md border bg-white">
        <iframe
          title={`完整成品预览 ${label}`}
          srcDoc={html}
          className="h-[900px] w-full"
          sandbox="allow-same-origin"
        />
      </div>
    </>
  );
}
