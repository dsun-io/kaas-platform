"use client";

/**
 * 单证清单面板（A7-3）
 *
 * 语义（后端 `put_trade_doc_doc_set`）：`PUT` 是**全量替换**，但实现是
 * "删掉不在新清单里的 + upsert 其余" ⇒ **已登记的回执不会因改清单而丢**。
 * 界面上要如实说明这点，否则业务员会以为"改一下清单就清空回执"而不敢动。
 *
 * `not_by_us`（对方出单）的项才有回执登记：`receive`（已收到，可记对方单证 id）
 * / `waive`（豁免，**必须填原因** —— 否则审计上无法回答"为什么没要"）。
 * 非法状态转移（已收到又豁免）后端 409，这里不预判、如实报错。
 */
import { useState } from "react";
import { FilePlus2, FileX2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { LoadingBlock } from "@/components/shared/loading-block";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DOC_SET_ISSUERS,
  DOC_SET_ISSUER_LABEL,
  DOC_SET_ROLES,
  DOC_SET_ROLE_LABEL,
  DOC_SET_STATUS_META,
  type DocSetItem,
  type DocSetIssuer,
  type DocSetRole,
} from "@/lib/trade-doc/hardening";

import {
  useDocSet,
  useDocSetReceipt,
  useSaveDocSet,
} from "../hooks/use-doc-hardening";

/** 编辑态的一行（doc_type 是天然主键，编辑时不可改）。 */
interface Row {
  doc_type: string;
  role: DocSetRole;
  issuer: DocSetIssuer;
  evidence_required: boolean;
}

function toRows(items: DocSetItem[]): Row[] {
  return items.map((item) => ({
    doc_type: item.doc_type,
    role: item.role,
    issuer: item.issuer,
    evidence_required: item.evidence_required,
  }));
}

export function DocSetPanel({
  docId,
  status,
}: {
  docId: number;
  status: string | null;
}) {
  const docSet = useDocSet(docId);
  const save = useSaveDocSet(docId);
  const receipt = useDocSetReceipt(docId);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [newType, setNewType] = useState("");
  const [waiving, setWaiving] = useState<string | null>(null);
  const [waiveReason, setWaiveReason] = useState("");

  const items = docSet.data?.items ?? [];
  const readonly = status === "void";

  const beginEdit = () => {
    setRows(toRows(items));
    setEditing(true);
  };

  const doSave = async () => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.doc_type.trim()) {
        toast.error("清单里有空的单证类型");
        return;
      }
      if (seen.has(row.doc_type)) {
        toast.error(`同一单证类型重复：${row.doc_type}`);
        return;
      }
      seen.add(row.doc_type);
    }
    try {
      await save.mutateAsync({
        items: rows.map((row) => ({
          doc_type: row.doc_type,
          role: row.role,
          issuer: row.issuer,
          evidence_required: row.evidence_required,
        })),
      });
      toast.success("清单已保存（已登记的回执保留）");
      setEditing(false);
    } catch {
      toast.error("保存失败：单证类型/角色/出单方需为后端枚举值");
    }
  };

  const doReceipt = async (docType: string, action: "receive" | "waive") => {
    if (action === "waive" && !waiveReason.trim()) {
      toast.error("豁免必须填写原因");
      return;
    }
    try {
      await receipt.mutateAsync({
        docType,
        input: {
          action,
          waived_reason: action === "waive" ? waiveReason.trim() : null,
        },
      });
      toast.success(action === "receive" ? "已登记回执" : "已登记豁免");
      setWaiving(null);
      setWaiveReason("");
    } catch {
      toast.error("回执登记失败：已登记过的状态不能覆盖（后端 409）");
    }
  };

  if (docSet.isLoading) return <LoadingBlock rows={3} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="info" dot={false}>
          共 {items.length} 项
        </StatusBadge>
        <span className="text-xs text-muted-foreground">
          全量替换会保留已登记的回执（后端按 doc_type upsert）
        </span>
        <Button
          size="sm"
          variant={editing ? "ghost" : "outline"}
          className="ml-auto"
          disabled={readonly}
          onClick={() => (editing ? setEditing(false) : beginEdit())}
        >
          <Pencil className="mr-1 h-4 w-4" />
          {editing ? "取消编辑" : "编辑清单"}
        </Button>
        {editing && (
          <Button size="sm" disabled={save.isPending} onClick={doSave}>
            <Save className="mr-1 h-4 w-4" />
            保存清单
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2 rounded-md border p-3">
          {rows.map((row, index) => (
            <div
              key={`${row.doc_type}-${index}`}
              className="flex flex-wrap items-end gap-2"
            >
              <label className="space-y-1 text-xs">
                <span className="font-medium">单证类型</span>
                <Input value={row.doc_type} disabled className="w-40" />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">角色</span>
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={row.role}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? { ...item, role: e.target.value as DocSetRole }
                          : item,
                      ),
                    )
                  }
                >
                  {DOC_SET_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {DOC_SET_ROLE_LABEL[role]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">出单方</span>
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={row.issuer}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? { ...item, issuer: e.target.value as DocSetIssuer }
                          : item,
                      ),
                    )
                  }
                >
                  {DOC_SET_ISSUERS.map((issuer) => (
                    <option key={issuer} value={issuer}>
                      {DOC_SET_ISSUER_LABEL[issuer]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 self-center text-xs">
                <input
                  type="checkbox"
                  checked={row.evidence_required}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? { ...item, evidence_required: e.target.checked }
                          : item,
                      ),
                    )
                  }
                  className="h-4 w-4"
                />
                需证据
              </label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setRows((prev) => prev.filter((_, i) => i !== index))
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-2 border-t pt-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium">新增单证类型</span>
              <Input
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                placeholder="如 packing_list"
                className="w-44"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const type = newType.trim();
                if (!type) return;
                setRows((prev) => [
                  ...prev,
                  {
                    doc_type: type,
                    role: "required",
                    issuer: "ours",
                    evidence_required: false,
                  },
                ]);
                setNewType("");
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              加入清单
            </Button>
          </div>
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((item) => {
            const statusMeta =
              DOC_SET_STATUS_META[item.status] ?? DOC_SET_STATUS_META.pending;
            const needsReceipt =
              item.role === "not_by_us" && item.status === "pending";
            return (
              <li key={item.doc_type} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{item.doc_type}</span>
                  <StatusBadge tone={item.role === "not_by_us" ? "warning" : "default"}>
                    {DOC_SET_ROLE_LABEL[item.role] ?? item.role}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    {DOC_SET_ISSUER_LABEL[item.issuer] ?? item.issuer}
                  </span>
                  <StatusBadge tone={statusMeta.tone}>
                    {statusMeta.label}
                  </StatusBadge>
                  {item.evidence_required && (
                    <span className="text-xs text-muted-foreground">需证据</span>
                  )}
                  {needsReceipt && (
                    <span className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={readonly || receipt.isPending}
                        onClick={() => void doReceipt(item.doc_type, "receive")}
                      >
                        <FilePlus2 className="mr-1 h-3.5 w-3.5" />
                        登记回执
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={readonly || receipt.isPending}
                        onClick={() => setWaiving(item.doc_type)}
                      >
                        <FileX2 className="mr-1 h-3.5 w-3.5" />
                        豁免
                      </Button>
                    </span>
                  )}
                </div>
                {item.waived_reason && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    豁免原因：{item.waived_reason}
                  </p>
                )}
                {waiving === item.doc_type && (
                  <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border bg-muted/20 p-2">
                    <label className="space-y-1 text-xs">
                      <span className="font-medium">豁免原因（必填）</span>
                      <Input
                        aria-label="豁免原因"
                        value={waiveReason}
                        onChange={(e) => setWaiveReason(e.target.value)}
                        className="w-64"
                      />
                    </label>
                    <Button
                      size="sm"
                      disabled={receipt.isPending}
                      onClick={() => void doReceipt(item.doc_type, "waive")}
                    >
                      确认豁免
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setWaiving(null);
                        setWaiveReason("");
                      }}
                    >
                      取消
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              还没有单证清单，点「编辑清单」补上这次交易该出哪些单据。
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
