"use client";

/**
 * 客户详情里的小弹层：更新阶段 / 删除客户（从 page.tsx 抽出，行为不变）。
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import apiClient from "@/lib/api/client";

import type { Customer } from "./customer-types";
import { errMsg } from "./error-message";

/** 删除客户 409（有开启中的订单）时，把订单清单也带出来给用户看。 */
function deleteConflictMessage(e: unknown): string | null {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (!detail || typeof detail !== "object") return null;
  const obj = detail as {
    code?: string;
    detail?: string;
    open_orders?: { order_no?: string; status?: string }[];
  };
  if (obj.code !== "OPEN_ORDERS_EXIST") return null;
  const orders = (obj.open_orders ?? [])
    .map((o) => `${o.order_no ?? ""}(${o.status ?? ""})`)
    .filter(Boolean)
    .join("、");
  return `${obj.detail ?? "客户名下有开启中的订单，不能删除"}${orders ? `：${orders}` : ""}`;
}

/**
 * 手动切换客户阶段：只有「活跃 / 沉寂」。
 *
 * 「已下单」由开启中的订单自动推导，不在这里出现 —— 客户阶段与订单阶段是两层
 * （2026-10-18 用户口径）；「流失」属于订单阶段，客户阶段已删除该值。
 */

function StageUpdate({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [stage, setStage] = useState(customer.manual_stage ?? "active");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleUpdate = async () => {
    setIsPending(true);
    setError(null);
    try {
      await apiClient.patch<Customer>(`/customers/${customer.id}/stage`, {
        stage,
        reason: reason || undefined,
      });
      qc.invalidateQueries({ queryKey: ["customers"] });
      onClose();
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <Select
        value={stage}
        onValueChange={(value) => setStage(value as "active" | "inactive")}
      >
        <SelectTrigger
          className="h-10 w-full rounded-xl border-white/70 bg-white/80"
          aria-label="客户阶段"
        >
          <SelectValue placeholder="选择客户阶段" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">活跃</SelectItem>
          <SelectItem value="inactive">沉寂</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        「已下单」由开启中的订单自动推导，无需手动设置；「流失」属于订单阶段，
        不在客户阶段里。
      </p>
      <Input
        placeholder="原因（可选）"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleUpdate} disabled={isPending}>
          {isPending ? "更新中…" : "保存阶段"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}

/** 删除客户：二次确认 + 展示后端 409（有开启中的订单）原因。 */
function DeleteCustomer({
  customer,
  onClose,
  onDeleted,
}: {
  customer: Customer;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setIsPending(true);
    setError(null);
    try {
      await apiClient.delete(`/customers/${customer.id}`);
      // 先摘掉详情缓存再刷新列表：否则 invalidate 会重取已被删除客户的详情 → 404 toast
      qc.removeQueries({ queryKey: ["customers", "detail", customer.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      onDeleted();
      onClose();
    } catch (e: unknown) {
      setError(deleteConflictMessage(e) ?? errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="text-sm">
        确认删除客户「{customer.company_name}
        」？列表里将不再显示，历史报价/订单/单证 仍保留引用。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={isPending}
        >
          {isPending ? "删除中…" : "确认删除"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}

export { StageUpdate, DeleteCustomer };
