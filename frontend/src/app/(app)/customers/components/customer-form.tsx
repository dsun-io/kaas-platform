"use client";

/**
 * 新建/编辑客户表单（从 page.tsx 抽出，FormField 版行为不变）。
 */
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/shared/form-field";
import apiClient from "@/lib/api/client";

import type { Customer } from "./customer-types";
import { errMsg } from "./error-message";

type CustomerFormState = {
  company_name: string;
  abbr: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  country: string;
  address: string;
  default_port: string;
  credit_level: string;
  stage: string;
  notes: string;
};

const EMPTY_CUSTOMER: CustomerFormState = {
  company_name: "",
  abbr: "",
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  country: "",
  address: "",
  default_port: "",
  credit_level: "",
  stage: "active",
  notes: "",
};

/**
 * 客户档案表单 —— 新建 / 编辑共用。
 *
 * 编辑模式（传 `initial`）只改**档案字段**：联系人走「联系人」页签单独维护，
 * 阶段走「更新阶段」。这样不会出现「编辑档案顺手把阶段/联系人写坏」。
 */
function CustomerForm({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (c: Customer) => void;
  initial?: Customer;
}) {
  const qc = useQueryClient();
  const isEdit = !!initial;
  const [form, setForm] = useState<CustomerFormState>(() =>
    initial
      ? {
          company_name: initial.company_name ?? "",
          abbr: initial.abbr ?? "",
          contact_name: "",
          contact_phone: "",
          contact_email: "",
          country: initial.country ?? "",
          address: initial.address ?? "",
          default_port: initial.default_port ?? "",
          credit_level: initial.credit_level ?? "",
          stage: initial.manual_stage ?? "active",
          notes: initial.notes ?? "",
        }
      : EMPTY_CUSTOMER,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  // FormField 收编（P0-C）：字段 id 用 useId 生成，避免「新建卡片 + 编辑弹窗」
  // 同时存在时 id 撞车（标签关联会指错控件）。
  const fieldId = useId();
  const field = (key: string) => `${fieldId}-${key}`;

  // 公司名与联系人**至少填一个**（2026-10-17 用户口径）：只有个人联系人的客户也要能建。
  // 编辑模式不改联系人，因此以公司名或已有联系人为准，这里只校验公司名非空。
  const identityOk = isEdit
    ? form.company_name.trim().length > 0
    : form.company_name.trim().length > 0 ||
      form.contact_name.trim().length > 0;

  const set =
    (k: keyof CustomerFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [k]: e.target.value });

  const handleSubmit = async () => {
    if (!identityOk) {
      setError(isEdit ? "公司名称不能为空" : "公司名称和联系人至少填写一个");
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      let saved: Customer;
      if (isEdit && initial) {
        const { data } = await apiClient.patch<Customer>(
          `/customers/${initial.id}`,
          {
            company_name: form.company_name.trim(),
            abbr: form.abbr.trim() || null,
            country: form.country.trim() || null,
            address: form.address.trim() || null,
            default_port: form.default_port.trim() || null,
            credit_level: form.credit_level.trim() || null,
            notes: form.notes.trim() || null,
          },
        );
        saved = data;
      } else {
        const { data } = await apiClient.post<Customer>("/customers", form);
        saved = data;
      }
      qc.invalidateQueries({ queryKey: ["customers"] });
      onCreated(saved);
      onClose();
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label="公司名称"
          required={isEdit}
          htmlFor={field("company-name")}
        >
          <Input
            placeholder={isEdit ? "如：联佳丝网" : "与联系人至少填一个"}
            value={form.company_name}
            onChange={set("company_name")}
          />
        </FormField>
        {!isEdit && (
          <FormField label="联系人" htmlFor={field("contact-name")}>
            <Input
              placeholder="与公司名称至少填一个"
              value={form.contact_name}
              onChange={set("contact_name")}
            />
          </FormField>
        )}
      </div>
      {!isEdit && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="联系人电话" htmlFor={field("contact-phone")}>
            <Input
              placeholder="如：+86 138…"
              value={form.contact_phone}
              onChange={set("contact_phone")}
            />
          </FormField>
          <FormField label="联系人邮箱" htmlFor={field("contact-email")}>
            <Input
              placeholder="如：buyer@example.com"
              value={form.contact_email}
              onChange={set("contact_email")}
            />
          </FormField>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="国家" htmlFor={field("country")}>
          <Input
            placeholder="如：United States"
            value={form.country}
            onChange={set("country")}
          />
        </FormField>
        <FormField label="客户缩写" htmlFor={field("abbr")}>
          <Input
            placeholder="2-6 位字母/数字（用于询盘编号）"
            value={form.abbr}
            maxLength={6}
            onChange={(e) =>
              setForm({ ...form, abbr: e.target.value.toUpperCase() })
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="默认港口" htmlFor={field("port")}>
          <Input
            placeholder="如：Hamburg"
            value={form.default_port}
            onChange={set("default_port")}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="地址" htmlFor={field("address")}>
          <Input
            placeholder="街道 / 城市"
            value={form.address}
            onChange={set("address")}
          />
        </FormField>
        <FormField label="信用等级" htmlFor={field("credit-level")}>
          <Input
            placeholder="如：A / B"
            value={form.credit_level}
            onChange={set("credit_level")}
          />
        </FormField>
      </div>
      <FormField label="备注" htmlFor={field("notes")}>
        <Input value={form.notes} onChange={set("notes")} />
      </FormField>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={!identityOk || isPending}>
          {isPending
            ? isEdit
              ? "保存中…"
              : "创建中…"
            : isEdit
              ? "保存档案"
              : "创建客户"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}

export { CustomerForm };
