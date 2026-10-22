"use client";

/**
 * 出货工位 —— 订舱、装箱、船期与提单信息；出运状态推进。
 *
 * 业务位置：订单确认 → 订舱出货 → 拿到提单号 → 开提单/产地证等单证。
 * 这里的船名/航次/提单号/ETD/ETA 正是提单、装运通知、报关资料要印的内容，
 * 所以要在出运环节录全，单证才不用再问货代。
 */
import { useRef, useState } from "react";
import { AlertCircle, Ship } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AsyncButton } from "@/components/shared";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { useAsyncAction } from "@/lib/hooks/use-async-action";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import apiClient from "@/lib/api/client";
import { usePageView } from "@/lib/events/use-page-view";
import { useOrderOptions } from "@/lib/workstation/use-upstream";

interface ShipmentRow {
  id: number;
  shipment_no: string;
  order_id: number | null;
  customer_name: string | null;
  consignee: string | null;
  cargo_desc: string | null;
  bl_no: string | null;
  bl_type: string | null;
  pol_name: string | null;
  pod_name: string | null;
  vessel: string | null;
  voyage: string | null;
  container_no: string | null;
  etd: string | null;
  eta: string | null;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  booking: "已订舱",
  in_transit: "在途",
  arrived: "已到港",
  customs: "清关中",
  delivered: "已交付",
};

const STATUS_TONE: Record<
  string,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  booking: "warning",
  in_transit: "info",
  arrived: "info",
  customs: "warning",
  delivered: "success",
};

const NEXT_STATUS: Record<string, string> = {
  booking: "in_transit",
  in_transit: "arrived",
  arrived: "customs",
  customs: "delivered",
};

/** 出货列表分页大小（后端 page_size 默认 20；原来硬编码 100 且无分页）。 */
const SHIPMENTS_PAGE_SIZE = 20;

const EDIT_FIELDS: { key: keyof ShipmentRow; label: string; hint?: string }[] =
  [
    { key: "bl_no", label: "提单号", hint: "货代给的 B/L No." },
    { key: "vessel", label: "船名", hint: "如 COSCO SHIPPING UNIVERSE" },
    { key: "voyage", label: "航次", hint: "如 088E" },
    { key: "container_no", label: "集装箱号" },
    { key: "etd", label: "ETD 预计开船日", hint: "YYYY-MM-DD" },
    { key: "eta", label: "ETA 预计到港日", hint: "YYYY-MM-DD" },
    { key: "pol_name", label: "装运港" },
    { key: "pod_name", label: "目的港" },
    { key: "consignee", label: "收货人" },
    { key: "cargo_desc", label: "货物描述", hint: "单据上印的英文品名" },
  ];

export default function ShipmentsPage() {
  usePageView({ resource_id: "/shipments" });
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  // R50（shipments）：接 PaginationBar，不再 page_size=100 硬编码无翻页
  const [page, setPage] = useState(1);
  /**
   * U-P0B6/X5：编辑对象改为**打开时的行快照**（editor 独立于当前筛选结果）。
   * 旧实现 `selected = rows.find(...)`：一改筛选/状态，选中行从 rows 消失 ⇒
   * 编辑面板连同未保存的输入一起消失（数据丢失）。现在筛选只影响列表，不影响编辑现场。
   */
  const [editing, setEditing] = useState<ShipmentRow | null>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const [orderId, setOrderId] = useState("");
  const orders = useOrderOptions();

  const list = useQuery({
    queryKey: ["shipments", "list", statusFilter, page],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: ShipmentRow[];
        total: number;
        page: number;
        page_size: number;
      }>("/shipments", {
        params: {
          status: statusFilter || undefined,
          page,
          page_size: SHIPMENTS_PAGE_SIZE,
        },
      });
      return data;
    },
  });

  /**
   * P0-B2/S2：建单 / 保存 / 推进三个写操作原本全无 onError（失败零反馈），
   * 统一走 `useAsyncAction`（pending + 归一化错误文案）并明确三件事：
   * 1. 错误出口 —— 页内 `role="alert"`（拦截器已 toast，这里不重复 toast）；
   * 2. pending 防重 —— `AsyncButton` 自动 disabled；
   * 3. 成功 toast 区分「建单 / 保存 / 推进」，不再一律「已保存」。
   */
  const create = useAsyncAction(
    async () => {
      const { data } = await apiClient.post<ShipmentRow>("/shipments", {
        order_id: Number(orderId),
      });
      return data;
    },
    {
      onSuccess: (s) => {
        toast.success(`已建出货单 ${s.shipment_no}（客户与货物已从订单带入）`);
        setOrderId("");
        // 建单成功直接打开编辑弹窗（快照 = 刚创建的行）
        setEditing(s);
        qc.invalidateQueries({ queryKey: ["shipments"] });
      },
    },
  );

  const save = useAsyncAction(
    async (body: Partial<ShipmentRow> & { id: number }) => {
      const { id, ...rest } = body;
      const { data } = await apiClient.patch<ShipmentRow>(
        `/shipments/${id}`,
        rest,
      );
      return data;
    },
    {
      onSuccess: () => {
        toast.success("已保存");
        qc.invalidateQueries({ queryKey: ["shipments"] });
        // 保存成功关闭编辑弹窗（失败时由 error 留在弹窗内，见 onError/渲染）
        closeEditor();
      },
    },
  );

  const advance = useAsyncAction(
    async ({ id, status }: { id: number; status: string }) => {
      const { data } = await apiClient.patch<ShipmentRow>(`/shipments/${id}`, {
        status,
      });
      return data;
    },
    {
      onSuccess: (_data, args) => {
        toast.success(
          `已推进到「${STATUS_LABEL[args.status] ?? args.status}」`,
        );
        qc.invalidateQueries({ queryKey: ["shipments"] });
      },
    },
  );

  const rows = list.data?.items ?? [];

  /** 打开编辑弹窗（行快照 + 记下触发按钮，关闭归还焦点）。 */
  const openEditor = (row: ShipmentRow, opener?: HTMLElement | null) => {
    editorOpenerRef.current = opener ?? null;
    setEditing(row);
  };

  const closeEditor = () => {
    setEditing(null);
    const opener = editorOpenerRef.current;
    window.setTimeout(() => opener?.focus(), 0);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="出货"
        description="订舱、船期、提单号与集装箱信息。这些内容会直接印到提单、装运通知与报关资料上。"
      />

      <SectionCard
        title="新建出货单"
        description="从订单建立，自动带入客户与货物信息。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 min-w-[320px] rounded-md border border-input bg-background px-2 text-sm"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
          >
            <option value="">— 选择订单 —</option>
            {(orders.data ?? []).map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.order_no} · {o.customer_name ?? "未填客户"} · {o.currency}{" "}
                {o.total_amount ?? "-"}
              </option>
            ))}
          </select>
          <AsyncButton
            disabled={!orderId}
            pending={create.pending}
            pendingLabel="建单中…"
            onClick={() => void create.run()}
          >
            <Ship className="mr-1 h-4 w-4" />
            建出货单
          </AsyncButton>
          {orders.data?.length === 0 && (
            <span className="text-xs text-warning">
              还没有订单 —— 请先在「订单」工位建单。
            </span>
          )}
        </div>
        {create.error ? (
          <p
            role="alert"
            className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            建单失败：{create.error}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title={`出货列表（共 ${list.data?.total ?? 0} 条）`}
        action={
          <select
            aria-label="状态筛选"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1); // 筛选变化回第 1 页
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        }
      >
        {list.isLoading ? (
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="出货列表加载中"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="flex items-center gap-2 py-8 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            读取出货列表失败。请确认后端服务已启动。
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Ship}
            title="还没有出货单"
            description="从上面的订单建一张出货单。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="p-2">
                    出货单号
                  </th>
                  <th scope="col" className="p-2">
                    客户
                  </th>
                  <th scope="col" className="p-2">
                    状态
                  </th>
                  <th scope="col" className="p-2">
                    船名/航次
                  </th>
                  <th scope="col" className="p-2">
                    提单号
                  </th>
                  <th scope="col" className="p-2">
                    ETD
                  </th>
                  <th scope="col" className="p-2">
                    ETA
                  </th>
                  <th scope="col" className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b last:border-0 hover:bg-muted/40"
                  >
                    <td className="p-2 font-medium">{s.shipment_no}</td>
                    <td className="p-2">{s.customer_name ?? "—"}</td>
                    <td className="p-2">
                      <StatusBadge tone={STATUS_TONE[s.status] ?? "default"}>
                        {STATUS_LABEL[s.status] ?? s.status}
                      </StatusBadge>
                    </td>
                    <td className="p-2">
                      {[s.vessel, s.voyage].filter(Boolean).join(" / ") || "—"}
                    </td>
                    <td className="p-2">{s.bl_no ?? "—"}</td>
                    <td className="p-2">{s.etd ?? "—"}</td>
                    <td className="p-2">{s.eta ?? "—"}</td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => openEditor(s, e.currentTarget)}
                        >
                          编辑
                        </Button>
                        {NEXT_STATUS[s.status] && (
                          <AsyncButton
                            size="sm"
                            variant="ghost"
                            pending={advance.pending}
                            pendingLabel="推进中…"
                            onClick={() =>
                              void advance.run({
                                id: s.id,
                                status: NEXT_STATUS[s.status] as string,
                              })
                            }
                          >
                            推进到「
                            {STATUS_LABEL[NEXT_STATUS[s.status] as string]}」
                          </AsyncButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar
          page={page}
          pageSize={SHIPMENTS_PAGE_SIZE}
          total={list.data?.total ?? 0}
          currentCount={rows.length}
          loading={list.isFetching}
          onPageChange={setPage}
          ariaLabel="出货列表分页"
        />
        {advance.error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            状态推进失败：{advance.error}
          </p>
        ) : null}
      </SectionCard>

      {/*
        U-P0B6/X5：编辑面板迁入 Dialog，对象是**打开时的行快照**。
        改筛选/推进状态只会重取列表，弹窗与未保存的输入都还在（旧实现会直接消失）。
      */}
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !save.pending) closeEditor();
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{"出货信息 · " + editing.shipment_no}</DialogTitle>
              <DialogDescription>
                录全船名/航次/提单号/ETD/ETA，开提单与装运通知时就不用再问货代。
              </DialogDescription>
            </DialogHeader>
            <ShipmentForm
              key={editing.id}
              shipment={editing}
              saving={save.pending}
              error={save.error}
              onSave={(body) => void save.run({ id: editing.id, ...body })}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeEditor}
                disabled={save.pending}
              >
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ShipmentForm({
  shipment,
  saving,
  error,
  onSave,
}: {
  shipment: ShipmentRow;
  saving: boolean;
  /** 保存失败原因（拦截器已 toast，这里页内常驻，便于对照着改） */
  error?: string | null;
  onSave: (body: Partial<ShipmentRow>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      EDIT_FIELDS.map((f) => [
        f.key as string,
        (shipment[f.key] as string) ?? "",
      ]),
    ),
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {EDIT_FIELDS.map((field) => (
          <label key={field.key as string} className="space-y-1">
            <span className="text-sm font-medium">{field.label}</span>
            <Input
              value={draft[field.key as string] ?? ""}
              placeholder={field.hint}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
            />
          </label>
        ))}
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          保存失败：{error}
        </p>
      ) : null}
      <AsyncButton
        pending={saving}
        pendingLabel="保存中…"
        onClick={() => onSave(draft as Partial<ShipmentRow>)}
      >
        保存
      </AsyncButton>
    </div>
  );
}
