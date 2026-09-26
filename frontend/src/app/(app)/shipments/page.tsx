"use client";

/**
 * 出货工位 —— 订舱、装箱、船期与提单信息；出运状态推进。
 *
 * 业务位置：订单确认 → 订舱出货 → 拿到提单号 → 开提单/产地证等单证。
 * 这里的船名/航次/提单号/ETD/ETA 正是提单、装运通知、报关资料要印的内容，
 * 所以要在出运环节录全，单证才不用再问货代。
 */
import { useState } from "react";
import { AlertCircle, Ship } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [orderId, setOrderId] = useState("");
  const orders = useOrderOptions();

  const list = useQuery({
    queryKey: ["shipments", "list", statusFilter],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: ShipmentRow[];
        total: number;
      }>("/shipments", {
        params: { status: statusFilter || undefined, page_size: 100 },
      });
      return data;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<ShipmentRow>("/shipments", {
        order_id: Number(orderId),
      });
      return data;
    },
    onSuccess: (s) => {
      toast.success(`已建出货单 ${s.shipment_no}（客户与货物已从订单带入）`);
      setOrderId("");
      setSelectedId(s.id);
      qc.invalidateQueries({ queryKey: ["shipments"] });
    },
  });

  const patch = useMutation({
    mutationFn: async (body: Partial<ShipmentRow> & { id: number }) => {
      const { id, ...rest } = body;
      const { data } = await apiClient.patch<ShipmentRow>(
        `/shipments/${id}`,
        rest,
      );
      return data;
    },
    onSuccess: () => {
      toast.success("已保存");
      qc.invalidateQueries({ queryKey: ["shipments"] });
    },
  });

  const rows = list.data?.items ?? [];
  const selected = rows.find((s) => s.id === selectedId) ?? null;

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
          <Button
            disabled={!orderId || create.isPending}
            onClick={() => create.mutate()}
          >
            <Ship className="mr-1 h-4 w-4" />
            建出货单
          </Button>
          {orders.data?.length === 0 && (
            <span className="text-xs text-amber-700">
              还没有订单 —— 请先在「订单」工位建单。
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="出货列表"
        action={
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
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
          <p className="py-8 text-center text-sm text-muted-foreground">
            加载中…
          </p>
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
                  <th className="p-2">出货单号</th>
                  <th className="p-2">客户</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">船名/航次</th>
                  <th className="p-2">提单号</th>
                  <th className="p-2">ETD</th>
                  <th className="p-2">ETA</th>
                  <th className="p-2" />
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
                          onClick={() => setSelectedId(s.id)}
                        >
                          编辑
                        </Button>
                        {NEXT_STATUS[s.status] && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={patch.isPending}
                            onClick={() =>
                              patch.mutate({
                                id: s.id,
                                status: NEXT_STATUS[s.status] as string,
                              })
                            }
                          >
                            推进到「
                            {STATUS_LABEL[NEXT_STATUS[s.status] as string]}」
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {selected && (
        <SectionCard
          title={`出货信息 · ${selected.shipment_no}`}
          description="录全船名/航次/提单号/ETD/ETA，开提单与装运通知时就不用再问货代。"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedId(null)}
            >
              关闭
            </Button>
          }
        >
          <ShipmentForm
            key={selected.id}
            shipment={selected}
            saving={patch.isPending}
            onSave={(body) => patch.mutate({ id: selected.id, ...body })}
          />
        </SectionCard>
      )}
    </div>
  );
}

function ShipmentForm({
  shipment,
  saving,
  onSave,
}: {
  shipment: ShipmentRow;
  saving: boolean;
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
      <Button
        disabled={saving}
        onClick={() => onSave(draft as Partial<ShipmentRow>)}
      >
        {saving ? "保存中…" : "保存"}
      </Button>
    </div>
  );
}
