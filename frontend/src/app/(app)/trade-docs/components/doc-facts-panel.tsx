"use client";

/**
 * 事实确认面板（A7-3 首批必做）
 *
 * 为什么这块是**主路径**而不是可选项：内核把"付款条款解析出的比例/时点"一律判为
 * `unverified`（推断值不得直接进 issued），签发闸门据此返回 422 `FACT_UNVERIFIED`。
 * 没有本面板的确认回写，带付款条款的单证**永远签不出去**。
 *
 * 两条硬约束（照后端实现，界面上也照此设限）：
 * 1. `value` **不给编辑入口** —— 值的唯一真源是单证 payload，PATCH value 后端 422
 *    `FACT_VALUE_IMMUTABLE_STORAGE`；界面上放一个能改的框就是给自己埋雷。
 * 2. 确认后要**刷新一致性**（hook 内已一并失效）—— 未确认项从 blocking 消失，
 *    红/黄差异也可能随之变化。
 */
import { useMemo, useState } from "react";
import { BadgeCheck, FileWarning, Lock, PencilLine, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";

import { LoadingBlock } from "@/components/shared/loading-block";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FACT_TRUST_META,
  type DocFact,
  type FactTrust,
} from "@/lib/trade-doc/hardening";
import { cn } from "@/lib/utils";

import {
  useConfirmFacts,
  useDocFacts,
  usePatchFact,
} from "../hooks/use-doc-hardening";

interface Props {
  docId: number;
  /** 已作废单据的事实处置不可再改（后端 409 DOC_NOT_EDITABLE） */
  status: string | null;
}

interface FactDraft {
  text_zh: string;
  text_en: string;
  evidence_ref: string;
  immutable: boolean;
}

function draftOf(fact: DocFact): FactDraft {
  return {
    text_zh: fact.text_zh ?? "",
    text_en: fact.text_en ?? "",
    evidence_ref: fact.evidence_ref ?? "",
    immutable: fact.immutable,
  };
}

export function DocFactsPanel({ docId, status }: Props) {
  const facts = useDocFacts(docId);
  const confirm = useConfirmFacts(docId);
  const patch = usePatchFact(docId);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<FactDraft | null>(null);

  // 稳定引用：`?? []` 每次渲染都是新数组，会让下面的 useMemo 依赖每轮都变（lint 实测）
  const items = useMemo(() => facts.data?.items ?? [], [facts.data]);
  const summary = facts.data?.summary;
  const readonly = status === "void";

  const pendingKeys = useMemo(
    () => items.filter((f) => f.trust !== "confirmed").map((f) => f.key),
    [items],
  );

  const toggle = (key: string) => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const doConfirm = async (keys: string[]) => {
    try {
      const result = await confirm.mutateAsync(keys);
      toast.success(`已确认 ${result.confirmed.length} 项事实`);
      setSelected([]);
    } catch {
      toast.error("确认失败：请刷新后重试（作废单据不可修改）");
    }
  };

  const startEdit = (fact: DocFact) => {
    setEditing(fact.key);
    setDraft(draftOf(fact));
  };

  const saveEdit = async (factKey: string) => {
    if (!draft) return;
    try {
      await patch.mutateAsync({
        factKey,
        patch: {
          text_zh: draft.text_zh.trim() === "" ? null : draft.text_zh.trim(),
          text_en: draft.text_en.trim() === "" ? null : draft.text_en.trim(),
          evidence_ref:
            draft.evidence_ref.trim() === "" ? null : draft.evidence_ref.trim(),
          immutable: draft.immutable,
        },
      });
      toast.success("已保存事实处置（值仍以单证内容为准）");
      setEditing(null);
      setDraft(null);
    } catch {
      toast.error("保存失败：值不可修改，只能改信任级/双语/证据");
    }
  };

  if (facts.isLoading) return <LoadingBlock rows={5} />;
  if (facts.isError) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-destructive">
        <FileWarning className="h-4 w-4" />
        读取事实清单失败。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="info" dot={false}>
          共 {summary?.total ?? 0} 项
        </StatusBadge>
        <StatusBadge tone="success">
          已确认 {summary?.confirmed ?? 0}
        </StatusBadge>
        <StatusBadge tone="danger">
          待确认 {summary?.unverified ?? 0}
        </StatusBadge>
        <StatusBadge tone="warning">
          推断 {summary?.inferred ?? 0}
        </StatusBadge>
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            disabled={readonly || pendingKeys.length === 0 || confirm.isPending}
            onClick={() => doConfirm([])}
          >
            <BadgeCheck className="mr-1 h-4 w-4" />
            全部确认
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={readonly || selected.length === 0 || confirm.isPending}
            onClick={() => doConfirm(selected)}
          >
            勾选确认（{selected.length}）
          </Button>
        </span>
      </div>

      {readonly && (
        <p className="text-xs text-muted-foreground">
          该单据已作废：事实处置已封存，仅供查看。
        </p>
      )}

      <ul className="divide-y rounded-md border">
        {items.map((fact) => {
          const meta = FACT_TRUST_META[fact.trust as FactTrust] ?? FACT_TRUST_META.inferred;
          const unverified = fact.trust !== "confirmed";
          return (
            <li
              key={fact.key}
              className={cn(
                "px-3 py-2 text-sm",
                unverified && "bg-destructive/5",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`选择事实 ${fact.key}`}
                  checked={selected.includes(fact.key)}
                  disabled={readonly || !unverified}
                  onChange={() => toggle(fact.key)}
                  className="h-4 w-4"
                />
                <span className="font-mono text-xs text-muted-foreground">
                  {fact.key}
                </span>
                <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                {fact.immutable && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    不可改写
                  </span>
                )}
                {fact.currency && (
                  <span className="text-xs text-muted-foreground">
                    {fact.currency}
                  </span>
                )}
                <span
                  className="ml-auto font-medium"
                  title="值由单证内容决定，不可在此修改"
                >
                  {fact.value}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readonly}
                  onClick={() => startEdit(fact)}
                >
                  <PencilLine className="mr-1 h-3.5 w-3.5" />
                  处置
                </Button>
              </div>

              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {fact.text_zh && <span>中：{fact.text_zh}</span>}
                {fact.text_en && <span>EN: {fact.text_en}</span>}
                {fact.source && <span>来源：{fact.source}</span>}
                {fact.evidence_ref && <span>证据：{fact.evidence_ref}</span>}
                {fact.confirmed_at && (
                  <span>
                    确认于 {fact.confirmed_at}
                    {fact.confirmed_by ? `（${fact.confirmed_by}）` : ""}
                  </span>
                )}
                {unverified && (
                  <span className="flex items-center gap-1 text-destructive">
                    <ShieldQuestion className="h-3 w-3" />
                    {meta.hint}
                  </span>
                )}
              </div>

              {editing === fact.key && draft && (
                <div className="mt-2 grid gap-2 rounded-md border bg-muted/30 p-2 sm:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">中文表述</span>
                    <Input
                      aria-label="中文表述"
                      value={draft.text_zh}
                      onChange={(e) =>
                        setDraft({ ...draft, text_zh: e.target.value })
                      }
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">英文表述</span>
                    <Input
                      aria-label="英文表述"
                      value={draft.text_en}
                      onChange={(e) =>
                        setDraft({ ...draft, text_en: e.target.value })
                      }
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">证据引用</span>
                    <Input
                      aria-label="证据引用"
                      value={draft.evidence_ref}
                      onChange={(e) =>
                        setDraft({ ...draft, evidence_ref: e.target.value })
                      }
                    />
                  </label>
                  <label className="flex items-center gap-2 self-end text-xs">
                    <input
                      type="checkbox"
                      checked={draft.immutable}
                      onChange={(e) =>
                        setDraft({ ...draft, immutable: e.target.checked })
                      }
                      className="h-4 w-4"
                    />
                    <span>标记为不可改写（派生单只能原值引用）</span>
                  </label>
                  <div className="flex gap-2 sm:col-span-2">
                    <Button
                      size="sm"
                      disabled={patch.isPending}
                      onClick={() => saveEdit(fact.key)}
                    >
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(null);
                        setDraft(null);
                      }}
                    >
                      取消
                    </Button>
                    <span className="self-center text-xs text-muted-foreground">
                      值（{fact.value}）不可修改：要改值请改单证内容或作废重开
                    </span>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">
            该单证暂无可核对的事实。
          </li>
        )}
      </ul>
    </div>
  );
}
