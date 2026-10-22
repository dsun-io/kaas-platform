"use client";

/**
 * 条款模板（A5-W1）设置卡片 —— 团队级条款库 CRUD。
 *
 * 入口选择理由：放在「设置 → 企业信息」页（`company-profile`）而不是 `/settings` 主页：
 * - `/settings` 主页是**平台运营**页面（`RouteGuard adminOnly` + 租户/账号/系统操作），
 *   条款库是**团队级**业务数据，不属于平台治理；
 * - `company-profile` 已是团队管理员维护「单据默认条款（贸易术语/付款方式）」的地方，
 *   本卡片正好把「默认条款」升级为「可复用条款库」，读写权限口径（`isTeamAdmin`）也一致。
 *
 * 权限：写操作由后端 `team admin` 判定（403 如实透出）；前端只按 `canWrite`
 * （父页面的 `useTeam().isTeamAdmin`）禁用入口并给出只读提示，**不做整页 403**。
 *
 * 排序（2026-10-22 改）：原先是在编辑弹窗里手填「排序（可选）」数字框 ——
 * 用户得先知道别人的 sort_order 才能插进正确位置，等于让他手工维护一个链表。
 * 现在列表左侧是拖拽把手，松手即落库；弹窗里的数字框已删除，
 * 新建模板默认追加到**末尾**（而不是 sort_order=0 排到最前面）。
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { SectionCard } from "@/components/shared/section-card";
import { SortableGrip, SortableList } from "@/components/shared/sortable-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { normalizeApiError } from "@/lib/api/api-error";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import {
  docTypeLabels,
  templateSummary,
  type ClauseTemplate,
  type ClauseTemplateInput,
} from "@/lib/trade-doc/clause-templates";
import {
  clauseTemplateKeys,
  useClauseTemplates,
  useCreateClauseTemplate,
  useDeleteClauseTemplate,
  useReorderClauseTemplates,
  useUpdateClauseTemplate,
} from "@/lib/trade-doc/use-clause-templates";

const EMPTY_FORM: ClauseTemplateInput = {
  name: "",
  doc_types: [],
  text_zh: "",
  text_en: "",
  sort_order: 0,
};

/** 新建模板追加到末尾：沿用种子的 10 步长节奏，避免和既有 sort_order 撞位 */
function nextSortOrder(items: ClauseTemplate[]): number {
  const max = items.reduce((acc, template) => {
    const value =
      typeof template.sort_order === "number" && Number.isFinite(template.sort_order)
        ? template.sort_order
        : 0;
    return Math.max(acc, value);
  }, 0);
  return max + 10;
}

/** 后端 403/422 的 detail/message 如实透出（扁平/嵌套两种外形归一化） */
function formatApiError(error: unknown): string {
  const info = normalizeApiError(error);
  const parts = [info.message, info.detail, info.code].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  const unique = Array.from(new Set(parts));
  return unique.length > 0 ? unique.join(" · ") : "请求失败，请稍后重试";
}

export function ClauseTemplatesCard({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const list = useClauseTemplates();
  const create = useCreateClauseTemplate();
  const update = useUpdateClauseTemplate();
  const remove = useDeleteClauseTemplate();
  const reorder = useReorderClauseTemplates();

  const docTypes = useMemo(() => getAvailableTemplates(), []);
  const labelOf = (docType: string) =>
    docTypes.find((t) => t.doc_type === docType)?.name_zh;

  const [editor, setEditor] = useState<ClauseTemplate | "new" | null>(null);
  const [form, setForm] = useState<ClauseTemplateInput>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClauseTemplate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const items = useMemo(
    () =>
      [...(list.data ?? [])].sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id,
      ),
    [list.data],
  );

  const openNew = () => {
    // 新建追加到末尾（旧实现 sort_order 默认 0 ⇒ 新建的模板总跑到最前面，很反直觉）
    setForm({ ...EMPTY_FORM, sort_order: nextSortOrder(items) });
    setFormError(null);
    setEditor("new");
  };

  const openEdit = (template: ClauseTemplate) => {
    setForm({
      name: template.name,
      doc_types: [...template.doc_types],
      text_zh: template.text_zh,
      text_en: template.text_en,
      sort_order: template.sort_order ?? 0,
    });
    setFormError(null);
    setEditor(template);
  };

  const toggleDocType = (docType: string) =>
    setForm((prev) => ({
      ...prev,
      doc_types: prev.doc_types.includes(docType)
        ? prev.doc_types.filter((d) => d !== docType)
        : [...prev.doc_types, docType],
    }));

  const submit = () => {
    const name = form.name.trim();
    if (!name) {
      setFormError("模板名称必填（例如「T/T 30% 定金条款」）");
      return;
    }
    if (!form.text_zh.trim() && !form.text_en.trim()) {
      setFormError("中文或英文内容至少填一项 —— 空模板回填不出任何东西");
      return;
    }
    if (form.doc_types.length === 0) {
      // 后端 `normalize_doc_types` 要求非空（18 类子集）⇒ 前端先拦，避免白跑一次 422
      setFormError("至少选择一个适用单证类型");
      return;
    }
    const body: ClauseTemplateInput = {
      ...form,
      name,
      text_zh: form.text_zh.trim(),
      text_en: form.text_en.trim(),
      sort_order: Number.isFinite(Number(form.sort_order))
        ? Number(form.sort_order)
        : 0,
    };
    setFormError(null);
    const onError = (error: unknown) => setFormError(formatApiError(error));
    if (editor && editor !== "new") {
      update.mutate(
        { id: editor.id, ...body },
        {
          onSuccess: () => {
            toast.success("条款模板已更新");
            setEditor(null);
          },
          onError,
        },
      );
    } else {
      create.mutate(body, {
        onSuccess: () => {
          toast.success("条款模板已创建");
          setEditor(null);
        },
        onError,
      });
    }
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    remove.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success("条款模板已删除");
        setDeleteTarget(null);
      },
      onError: (error) => setDeleteError(formatApiError(error)),
    });
  };

  const saving = create.isPending || update.isPending;

  /**
   * 拖拽落库：把拖出来的顺序压成 0..n-1，只 PATCH 位次真的变了的那些。
   *
   * 乐观更新写在 `clauseTemplateKeys.list()`（docType 未传 ⇒ "all"）上：
   * 这个卡片就是读这个 key，写完立刻稳住；失败再 invalidate 拉回服务端真相。
   */
  const handleReorder = (next: ClauseTemplate[]) => {
    const patches = next
      .map((t, i) =>
        (t.sort_order ?? 0) === i ? null : { id: t.id, sort_order: i },
      )
      .filter((p): p is { id: number; sort_order: number } => p !== null);
    if (patches.length === 0) return;

    qc.setQueryData<ClauseTemplate[]>(
      clauseTemplateKeys.list(),
      next.map((t, i) => ({ ...t, sort_order: i })),
    );

    reorder.mutate(patches, {
      onSuccess: () => toast.success("条款顺序已更新"),
      onError: (error) => {
        toast.error(formatApiError(error));
        void qc.invalidateQueries({ queryKey: clauseTemplateKeys.all });
      },
    });
  };

  return (
    <SectionCard
      title="条款模板"
      description="团队级条款库：付款方式、检验、索赔、不可抗力、仲裁等常用条款，开单时一键回填（中英双语）。拖动左侧把手可调整开单时的呈现顺序。"
      action={
        canWrite ? (
          <Button size="sm" onClick={openNew}>
            <Plus className="mr-1 size-4" />
            新建模板
          </Button>
        ) : undefined
      }
    >
      {!canWrite && (
        <p className="mb-3 rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
          当前账号只能查看条款模板；新建 / 编辑 / 删除需团队管理员。
        </p>
      )}

      {list.isLoading ? (
        <p className="py-6 text-sm text-muted-foreground">正在读取条款模板…</p>
      ) : list.isError ? (
        <div className="py-4 text-sm">
          <p className="text-destructive">
            条款模板读取失败：{formatApiError(list.error)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            读取失败不影响开单；开单时仍可「自定义」直接填写条款。
          </p>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
          暂无条款模板。系统预置 6 类常用条款（付款方式 / 检验 / 索赔 / 不可抗力 / 仲裁 / 通用），
          可在此编辑或新增；即使不配置，开单时仍可直接「自定义」填写。
        </p>
      ) : (
        <SortableList
          items={items}
          onReorder={handleReorder}
          // 只读账号：把手禁用、不挂 sensor（别让人拖了个寂寞）
          disabled={!canWrite}
          className="divide-y rounded-md border"
          renderItem={(template) => (
            <div className="flex flex-wrap items-start gap-3 px-3 py-3">
              {canWrite && <SortableGrip label={`拖动排序 ${template.name}`} />}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{template.name}</span>
                  <StatusBadge tone="info">
                    {docTypeLabels(template.doc_types, labelOf)}
                  </StatusBadge>
                  {template.is_active === false && (
                    <StatusBadge tone="default">已停用</StatusBadge>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    #{template.id}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {templateSummary(template)}
                </p>
                {(template.text_zh || template.text_en) && (
                  <p className="text-[11px] text-muted-foreground">
                    中：{template.text_zh || "—"} / 英：{template.text_en || "—"}
                  </p>
                )}
              </div>
              {canWrite && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`编辑条款模板 ${template.name}`}
                    onClick={() => openEdit(template)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`删除条款模板 ${template.name}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteTarget(template);
                    }}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              )}
            </div>
          )}
        />
      )}

      {/* 新建 / 编辑 */}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor && editor !== "new" ? "编辑条款模板" : "新建条款模板"}
            </DialogTitle>
            <DialogDescription>
              模板属于当前团队；开单时可在条款字段处选择回填（单段字段按英文单证口径优先回填英文）。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-sm font-medium">名称 *</span>
              <Input
                value={form.name}
                placeholder="例如：T/T 30% 定金条款"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>

            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">适用单证 *</span>
                <span className="text-[11px] text-muted-foreground">
                  至少选一个单证类型
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        doc_types: docTypes.map((t) => t.doc_type),
                      }))
                    }
                  >
                    全选
                  </Button>
                </div>
              </div>
              <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-3">
                {docTypes.map((t) => (
                  <label
                    key={t.doc_type}
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={form.doc_types.includes(t.doc_type)}
                      onChange={() => toggleDocType(t.doc_type)}
                    />
                    {t.name_zh}
                  </label>
                ))}
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-sm font-medium">中文条款</span>
              <textarea
                className="min-h-[88px] w-full rounded-md border border-input bg-background p-2 text-sm"
                value={form.text_zh}
                placeholder="例如：30% 定金，余款凭提单副本支付。"
                onChange={(e) => setForm({ ...form, text_zh: e.target.value })}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">英文条款</span>
              <textarea
                className="min-h-[88px] w-full rounded-md border border-input bg-background p-2 text-sm"
                value={form.text_en}
                placeholder="e.g. 30% deposit, balance against B/L copy."
                onChange={(e) => setForm({ ...form, text_en: e.target.value })}
              />
            </label>

            {/*
              排序不再在这里手填（2026-10-22）：原来的「排序（可选）」数字框
              要求用户先知道别人填了几，才能插进正确位置 —— 这是让用户手工维护链表。
              现在改成列表里拖动，这里只说明一句，避免用户找不到地方。
            */}
            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              排序在列表里拖动左侧把手调整；新建的模板默认排在最后。
            </p>

            {formError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {formError}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              取消
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "保存中…" : editor && editor !== "new" ? "保存修改" : "创建模板"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除条款模板？</DialogTitle>
            <DialogDescription>
              「{deleteTarget?.name}」将从团队条款库移除（软删，不影响已填进单据的内容）。
              此操作不可在界面恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={remove.isPending}
            >
              {remove.isPending ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
