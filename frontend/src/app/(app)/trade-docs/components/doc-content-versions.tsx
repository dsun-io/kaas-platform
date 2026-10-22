"use client";

/**
 * 单证内容版本面板（TODO(TODO:A1)）
 *
 * 为什么需要：草稿期改「填写单据内容」时 `raw_payload` 是**整块覆盖**，
 * 改前的内容找不回；`raw_payload._audit` 只有"谁/何时/改了哪些键"，
 * 不含整份快照、也不能回滚。后端因此按单据内递增版本号存整份快照
 * （`trade_doc_content_versions`），本面板负责**回看与恢复**。
 *
 * 边界（与后端 409 口径一致，界面先把话说清楚，不让人白点）：
 * - 仅 draft 可恢复：issued/void 是法律凭证，内容已冻结；
 * - 报价单（`doc_type='quotation'`）不给恢复：它由报价自动同步，
 *   恢复内容会在下次报价更新时被覆盖。
 *
 * 与「上传 PDF 的文件版本链」不是一回事：那条链管**文件**（v1/v2 的 PDF），
 * 本面板管**内容**（sources + custom 快照），同一份单据可以"内容 v3 + 文件 v2"。
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { listCustomFields } from "@/lib/trade-doc/custom-fields";

import {
  useRestoreTradeDocContentVersion,
  useTradeDocContentVersion,
  useTradeDocContentVersions,
  type ContentVersionSource,
} from "../hooks/use-trade-docs";

/** 版本产生原因的中文标签（与后端 `content_versions.py` 的 SOURCE_* 对应） */
const SOURCE_LABEL: Record<ContentVersionSource, string> = {
  custom_update: "手工编辑",
  refresh_sources: "重新带入上游",
  issue: "签发冻结",
  restore: "恢复历史",
  translate: "AI 翻译",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

/** 上游来源的中文说法（不把内部键名 order/quote 摆给用户） */
const SOURCE_KEY_LABELS: Record<string, string> = {
  order: "订单",
  quote: "报价单",
};

/** 文本预览：长文本截断（完整内容在填写面板里看，不在这里堆长文） */
function previewValue(value: unknown): string {
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function VersionPayloadView({
  docType,
  payload,
}: {
  docType: string;
  payload?: Record<string, unknown>;
}) {
  const custom = (payload?.custom ?? {}) as Record<string, unknown>;
  const sources = Object.keys(
    (payload?.sources ?? {}) as Record<string, unknown>,
  );
  const entries = Object.entries(custom);

  // 内容项中文名来自模板清单；未知键用通用说法兜底，不直接显示内部字段名
  const labels = useMemo(() => {
    try {
      return new Map(
        listCustomFields(docType).map((field) => [
          field.name,
          field.spec.description ?? "其他内容",
        ]),
      );
    } catch {
      return new Map<string, string>();
    }
  }, [docType]);

  if (entries.length === 0 && sources.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">这一版没有填写任何内容。</p>
    );
  }
  return (
    <div className="space-y-1">
      {sources.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          上游来源：
          {sources.map((key) => SOURCE_KEY_LABELS[key] ?? "其他来源").join("、")}
        </p>
      )}
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2 text-xs">
          <span className="w-40 shrink-0 text-muted-foreground">
            {labels.get(key) ?? "其他内容"}
          </span>
          {typeof value === "object" && value !== null ? (
            <details className="min-w-0">
              <summary className="cursor-pointer text-muted-foreground">
                多项内容（查看详情）
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1 font-mono text-[11px]">
                {JSON.stringify(value, null, 2)}
              </pre>
            </details>
          ) : (
            <span className="break-all">{previewValue(value)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function DocContentVersions({
  docId,
  docType,
  status,
}: {
  docId: number;
  docType: string;
  status: string;
}) {
  const list = useTradeDocContentVersions(docId);
  const restore = useRestoreTradeDocContentVersion(docId);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const detail = useTradeDocContentVersion(docId, viewing);

  const total = list.data?.total ?? 0;
  const restoreDisabledReason =
    status !== "draft"
      ? "已签发/已作废的单证内容冻结，不能恢复历史版本"
      : docType === "quotation"
        ? "报价单由报价自动同步生成，恢复内容会被下次报价更新覆盖"
        : null;

  const doRestore = (versionNo: number) => {
    if (restoreDisabledReason) return;
    const ok = window.confirm(
      `确定把内容恢复为 v${versionNo} 吗？恢复会生成一个新版本，历史版本不会丢失。`,
    );
    if (!ok) return;
    restore.mutate(
      { versionNo },
      {
        onSuccess: (data) =>
          toast.success(
            `已恢复至 v${data.restored_version_no}（新版本已留档）`,
          ),
        onError: () => toast.error("恢复失败：单据可能已签发，或该版本不存在"),
      },
    );
  };

  return (
    <div className="mb-3 rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <History className="h-4 w-4" />
        内容版本
        <span className="text-xs font-normal text-muted-foreground">
          {list.isLoading
            ? "加载中…"
            : total > 0
              ? `共 ${total} 版`
              : "暂无记录"}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {restoreDisabledReason && (
            <p className="text-[11px] text-muted-foreground">
              {restoreDisabledReason}
            </p>
          )}

          {list.isLoading ? (
            <p className="text-xs text-muted-foreground">正在读取版本…</p>
          ) : list.isError ? (
            <p className="text-xs text-destructive">读取内容版本失败。</p>
          ) : total === 0 ? (
            <p className="text-xs text-muted-foreground">
              还没有内容版本记录 —— 草稿每次保存内容、重新带入上游或 AI
              翻译都会自动留一版。
            </p>
          ) : (
            <div className="overflow-hidden rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-left text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-2 py-1.5">
                      版本
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      变更
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      时间
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      内容项
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.items.map((item) => (
                    <tr key={item.version_no} className="border-t">
                      <td className="px-2 py-1.5 font-mono">
                        v{item.version_no}
                      </td>
                      <td className="px-2 py-1.5">
                        {SOURCE_LABEL[item.change_source] ?? item.change_source}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {formatTime(item.created_at)}
                      </td>
                      <td
                        className="px-2 py-1.5 text-muted-foreground"
                        title={item.custom_keys.join("、")}
                      >
                        {item.custom_keys.length
                          ? `${item.custom_keys.length} 项内容`
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() =>
                              setViewing(
                                viewing === item.version_no
                                  ? null
                                  : item.version_no,
                              )
                            }
                          >
                            {viewing === item.version_no ? "收起" : "查看"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            type="button"
                            disabled={
                              restoreDisabledReason !== null ||
                              restore.isPending
                            }
                            onClick={() => doRestore(item.version_no)}
                          >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            恢复
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {viewing !== null && (
            <div className="rounded border bg-muted/20 p-2">
              <p className="mb-1 text-[11px] font-medium">
                v{viewing} 的填写内容
              </p>
              {detail.isLoading ? (
                <p className="text-xs text-muted-foreground">读取中…</p>
              ) : detail.isError ? (
                <p className="text-xs text-destructive">读取失败</p>
              ) : (
                <VersionPayloadView
                  docType={docType}
                  payload={detail.data?.raw_payload}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
