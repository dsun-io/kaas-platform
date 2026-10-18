"use client";

import { useState } from "react";
import Link from "next/link";
import { usePageView } from "@/lib/events/use-page-view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  PageHeader,
  StatusBadge,
  SectionCard,
  EmptyState,
} from "@/components/shared";
import { Plus, Search, UserPlus } from "lucide-react";
import { CustomerRecordsTree } from "./components/customer-records-tree";
import { NumberEditDialog } from "@/components/shared/number-edit-dialog";

// 客户阶段（2026-10-18 用户口径）：只有三种。
// active / inactive 是手动状态；ordered 由「开启中的订单」自动推导，不可手选。
const STAGE_LABELS: Record<string, string> = {
  active: "活跃",
  inactive: "沉寂",
  ordered: "已下单",
};

// 历史阶段日志里可能还有旧值（lead/inquiry/quoted/won/lost）——只用于「历史」页签展示。
const LEGACY_STAGE_LABELS: Record<string, string> = {
  lead: "线索",
  inquiry: "询盘",
  quoted: "已报价",
  won: "成交",
  lost: "流失",
};

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "-";
  return STAGE_LABELS[stage] ?? LEGACY_STAGE_LABELS[stage] ?? stage;
}

const INQUIRY_STATUS_LABELS: Record<string, string> = {
  open: "进行中",
  quoted: "已报价",
  won: "成交",
  lost: "流失",
};

const STAGE_TONES: Record<string, import("@/components/shared").StatusTone> = {
  active: "info",
  inactive: "default",
  ordered: "success",
};

interface Customer {
  id: number;
  company_name: string;
  /** 客户缩写（2-6 位字母/数字，用于询盘编号自动生成） */
  abbr?: string | null;
  country: string | null;
  address: string | null;
  default_port: string | null;
  credit_level: string | null;
  /** 展示阶段：active / inactive / ordered（ordered 由开启中的订单推导） */
  stage: string;
  /** 手动状态：active / inactive（「更新阶段」用它回填） */
  manual_stage?: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Contact {
  id: number;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  whatsapp: string | null;
  is_primary: boolean;
}

interface Inquiry {
  id: number;
  customer_id: number;
  /** 自动生成的询盘编号（国家-客户缩写-时间戳）；历史询盘可能为空 */
  inquiry_no?: string | null;
  /** 编号是否可改：生成报价单之后锁定 */
  inquiry_no_editable?: boolean;
  channel: string | null;
  product_name_raw: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
  status: string;
  created_at: string;
}

interface StageLog {
  id: number;
  from_stage: string | null;
  to_stage: string;
  reason: string | null;
  created_at: string;
}

interface CustomerDetail extends Customer {
  contacts: Contact[];
  inquiries: Inquiry[];
  stage_log: StageLog[];
}

function useCustomerList(q?: string) {
  return useQuery({
    queryKey: ["customers", "list", q],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const { data } = await apiClient.get<{
        items: Customer[];
        total: number;
      }>(`/customers?${params}`);
      return data;
    },
  });
}

function useCustomerDetail(id: number | null) {
  return useQuery({
    queryKey: ["customers", "detail", id],
    queryFn: async () => {
      if (!id) return null;
      const { data } = await apiClient.get<CustomerDetail>(`/customers/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

function errMsg(e: unknown): string {
  const err = e as {
    response?: { data?: { detail?: unknown; message?: string; code?: string } };
    message?: string;
  };
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (detail && typeof detail === "object") {
    // 后端部分错误把可读说明放在对象型 detail 里（如 {code, detail, open_orders}）
    const obj = detail as { detail?: string; message?: string; code?: string };
    return obj.detail || obj.message || obj.code || "请求失败";
  }
  return err?.response?.data?.message ?? err?.message ?? "请求失败";
}

/** 删除客户 409（有开启中的订单）时，把订单清单也带出来给用户看。 */
function deleteConflictMessage(e: unknown): string | null {
  const detail = (
    e as { response?: { data?: { detail?: unknown } } }
  )?.response?.data?.detail;
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
      setError(
        isEdit ? "公司名称不能为空" : "公司名称和联系人至少填写一个",
      );
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder={
            isEdit ? "公司名称 *" : "公司名称（与联系人至少填一个）"
          }
          value={form.company_name}
          onChange={set("company_name")}
        />
        {!isEdit && (
          <Input
            placeholder="联系人（与公司名称至少填一个）"
            value={form.contact_name}
            onChange={set("contact_name")}
          />
        )}
      </div>
      {!isEdit && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            placeholder="联系人电话"
            value={form.contact_phone}
            onChange={set("contact_phone")}
          />
          <Input
            placeholder="联系人邮箱"
            value={form.contact_email}
            onChange={set("contact_email")}
          />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="国家"
          value={form.country}
          onChange={set("country")}
        />
        <Input
          placeholder="客户缩写（2-6 位字母/数字，用于询盘编号）"
          value={form.abbr}
          maxLength={6}
          onChange={(e) =>
            setForm({ ...form, abbr: e.target.value.toUpperCase() })
          }
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="默认港口"
          value={form.default_port}
          onChange={set("default_port")}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="地址"
          value={form.address}
          onChange={set("address")}
        />
        <Input
          placeholder="信用等级"
          value={form.credit_level}
          onChange={set("credit_level")}
        />
      </div>
      <Input placeholder="备注" value={form.notes} onChange={set("notes")} />
      {error && <p className="text-sm text-red-500">{error}</p>}
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

type InquiryFormState = {
  channel: string;
  product_name_raw: string;
  quantity: string;
  quantity_unit: string;
  application: string;
  notes: string;
};

const EMPTY_INQUIRY: InquiryFormState = {
  channel: "",
  product_name_raw: "",
  quantity: "",
  quantity_unit: "",
  application: "",
  notes: "",
};

function InquiryForm({
  customerId,
  onClose,
}: {
  customerId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<InquiryFormState>(EMPTY_INQUIRY);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const set =
    (k: keyof InquiryFormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });

  const handleSubmit = async () => {
    setIsPending(true);
    setError(null);
    try {
      await apiClient.post<Inquiry>(`/customers/${customerId}/inquiries`, {
        customer_id: customerId,
        channel: form.channel || undefined,
        product_name_raw: form.product_name_raw || undefined,
        quantity: form.quantity ? Number(form.quantity) : undefined,
        quantity_unit: form.quantity_unit || undefined,
        application: form.application || undefined,
        notes: form.notes || undefined,
      });
      qc.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
      onClose();
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="渠道（Alibaba / Expo / Web）"
          value={form.channel}
          onChange={set("channel")}
        />
        <Input
          placeholder="产品名称（原始）"
          value={form.product_name_raw}
          onChange={set("product_name_raw")}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="数量"
          type="number"
          value={form.quantity}
          onChange={set("quantity")}
        />
        <Input
          placeholder="单位（平方米 / 卷 / 吨）"
          value={form.quantity_unit}
          onChange={set("quantity_unit")}
        />
      </div>
      <Input
        placeholder="用途"
        value={form.application}
        onChange={set("application")}
      />
      <Input placeholder="备注" value={form.notes} onChange={set("notes")} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "提交中…" : "添加询盘"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}

type ContactFormState = {
  name: string;
  position: string;
  phone: string;
  email: string;
  whatsapp: string;
  is_primary: boolean;
};

const EMPTY_CONTACT: ContactFormState = {
  name: "",
  position: "",
  phone: "",
  email: "",
  whatsapp: "",
  is_primary: false,
};

function ContactForm({
  customerId,
  onClose,
  initial,
}: {
  customerId: number;
  onClose: () => void;
  initial?: Contact;
}) {
  const qc = useQueryClient();
  const isEdit = !!initial;
  const [form, setForm] = useState<ContactFormState>(() =>
    initial
      ? {
          name: initial.name ?? "",
          position: initial.position ?? "",
          phone: initial.phone ?? "",
          email: initial.email ?? "",
          whatsapp: initial.whatsapp ?? "",
          is_primary: initial.is_primary,
        }
      : EMPTY_CONTACT,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async () => {
    setIsPending(true);
    setError(null);
    try {
      if (isEdit && initial) {
        await apiClient.patch<Contact>(
          `/customers/${customerId}/contacts/${initial.id}`,
          {
            name: form.name,
            position: form.position || null,
            phone: form.phone || null,
            email: form.email || null,
            whatsapp: form.whatsapp || null,
            is_primary: form.is_primary,
          },
        );
      } else {
        await apiClient.post<Contact>(`/customers/${customerId}/contacts`, {
          customer_id: customerId,
          name: form.name,
          position: form.position || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          whatsapp: form.whatsapp || undefined,
          is_primary: form.is_primary,
        });
      }
      qc.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
      onClose();
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="姓名 *"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Input
          placeholder="职位"
          value={form.position}
          onChange={(e) => setForm({ ...form, position: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          placeholder="电话"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <Input
          placeholder="邮箱"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </div>
      <Input
        placeholder="WhatsApp"
        value={form.whatsapp}
        onChange={(e) => setForm({ ...form, whatsapp: e.target.value })}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.is_primary}
          onChange={(e) => setForm({ ...form, is_primary: e.target.checked })}
          className="rounded border"
        />
        主要联系人
      </label>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={!form.name || isPending}>
          {isPending ? "提交中…" : isEdit ? "保存联系人" : "添加联系人"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
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
      <select
        value={stage}
        onChange={(e) => setStage(e.target.value)}
        className="w-full border rounded-md px-3 py-2 text-sm bg-background"
      >
        <option value="active">活跃</option>
        <option value="inactive">沉寂</option>
      </select>
      <p className="text-xs text-muted-foreground">
        「已下单」由开启中的订单自动推导，无需手动设置；「流失」属于订单阶段，
        不在客户阶段里。
      </p>
      <Input
        placeholder="原因（可选）"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
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
        确认删除客户「{customer.company_name}」？列表里将不再显示，历史报价/订单/单证
        仍保留引用。
      </p>
      {error && <p className="text-sm text-red-500">{error}</p>}
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

type DetailTab = "info" | "contacts" | "inquiries" | "history";

function CustomerDetailPanel({
  customer,
  onClose,
  onUpdated,
}: {
  customer: Customer;
  onClose: () => void;
  onUpdated: (c: Customer) => void;
}) {
  const { data: detail, isLoading } = useCustomerDetail(customer.id);
  const [activeTab, setActiveTab] = useState<DetailTab>("info");
  const [showInquiryForm, setShowInquiryForm] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [confirmDeleteContactId, setConfirmDeleteContactId] = useState<
    number | null
  >(null);
  const [showStageUpdate, setShowStageUpdate] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [inquiryNoEdit, setInquiryNoEdit] = useState<Inquiry | null>(null);
  const [inquiryNoPending, setInquiryNoPending] = useState(false);
  const [inquiryNoError, setInquiryNoError] = useState<string | null>(null);
  const qc = useQueryClient();

  const handleInquiryNoSave = async (value: string) => {
    if (!inquiryNoEdit) return;
    setInquiryNoPending(true);
    setInquiryNoError(null);
    try {
      await apiClient.patch(`/inquiries/${inquiryNoEdit.id}`, {
        inquiry_no: value,
      });
      await qc.invalidateQueries({
        queryKey: ["customers", "detail", customer.id],
      });
      setInquiryNoEdit(null);
    } catch (e) {
      setInquiryNoError(errMsg(e));
    } finally {
      setInquiryNoPending(false);
    }
  };

  const handleDeleteContact = async (contactId: number) => {
    try {
      await apiClient.delete(
        `/customers/${customer.id}/contacts/${contactId}`,
      );
      setConfirmDeleteContactId(null);
      qc.invalidateQueries({
        queryKey: ["customers", "detail", customer.id],
      });
    } catch {
      setConfirmDeleteContactId(null);
    }
  };

  const tabs: { key: DetailTab; label: string }[] = [
    { key: "info", label: "信息" },
    { key: "contacts", label: `联系人 (${detail?.contacts?.length ?? 0})` },
    { key: "inquiries", label: `询盘 (${detail?.inquiries?.length ?? 0})` },
    { key: "history", label: "历史" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>{customer.company_name}</CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
        {detail && (
          <div>
            <div className="flex gap-2 border-b mb-4">
              {tabs.map((tab) => (
                <Button
                  key={tab.key}
                  variant="ghost"
                  className={`rounded-none border-b-2 border-transparent px-4 pb-2 ${activeTab === tab.key ? "border-primary font-medium" : ""}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>

            {activeTab === "info" && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">国家：</span>
                    <span className="ml-1">{detail.country ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">信用等级：</span>
                    <span className="ml-1">{detail.credit_level ?? "-"}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">地址：</span>
                    <span className="ml-1">{detail.address ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">默认港口：</span>
                    <span className="ml-1">{detail.default_port ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">阶段：</span>
                    <StatusBadge
                      tone={STAGE_TONES[detail.stage] ?? "default"}
                      className="ml-1"
                    >
                      {stageLabel(detail.stage)}
                    </StatusBadge>
                    {detail.stage === "ordered" && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        由开启中的订单自动推导
                      </span>
                    )}
                  </div>
                  {detail.notes && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">备注：</span>
                      <span className="ml-1">{detail.notes}</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowEditForm(true)}
                  >
                    编辑档案
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowStageUpdate(true)}
                  >
                    更新阶段
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setShowDelete(true)}
                  >
                    删除客户
                  </Button>
                </div>
                {showEditForm && (
                  <CustomerForm
                    initial={customer}
                    onCreated={(raw) => {
                      setShowEditForm(false);
                      onUpdated(raw);
                    }}
                    onClose={() => setShowEditForm(false)}
                  />
                )}
                {showStageUpdate && (
                  <StageUpdate
                    customer={customer}
                    onClose={() => setShowStageUpdate(false)}
                  />
                )}
                {showDelete && (
                  <DeleteCustomer
                    customer={customer}
                    onClose={() => setShowDelete(false)}
                    onDeleted={onClose}
                  />
                )}
              </div>
            )}

            {activeTab === "contacts" && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">
                    {detail?.contacts?.length ?? 0} 位联系人
                  </span>
                  <Button size="sm" onClick={() => setShowContactForm(true)}>
                    <Plus className="size-4 mr-1" />
                    添加联系人
                  </Button>
                </div>
                {showContactForm && (
                  <ContactForm
                    customerId={customer.id}
                    onClose={() => setShowContactForm(false)}
                  />
                )}
                {editingContact && (
                  <ContactForm
                    customerId={customer.id}
                    initial={editingContact}
                    onClose={() => setEditingContact(null)}
                  />
                )}
                <div className="space-y-2">
                  {detail?.contacts?.length === 0 && (
                    <p className="text-sm text-muted-foreground">暂无联系人</p>
                  )}
                  {detail?.contacts?.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-lg border bg-card p-4 shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-sm">
                            {c.name}
                            {c.is_primary && (
                              <Badge variant="default" className="ml-2">
                                主要
                              </Badge>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {c.position && `${c.position} · `}
                            {c.phone && `${c.phone} · `}
                            {c.email && `${c.email} · `}
                            {c.whatsapp && `WA: ${c.whatsapp}`}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingContact(c)}
                          >
                            编辑
                          </Button>
                          {confirmDeleteContactId === c.id ? (
                            <>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => handleDeleteContact(c.id)}
                              >
                                确认删除
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmDeleteContactId(null)}
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setConfirmDeleteContactId(c.id)}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "inquiries" && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">
                    {detail?.inquiries?.length ?? 0} 条询盘
                  </span>
                  <Button size="sm" onClick={() => setShowInquiryForm(true)}>
                    <Plus className="size-4 mr-1" />
                    添加询盘
                  </Button>
                </div>
                {showInquiryForm && (
                  <InquiryForm
                    customerId={customer.id}
                    onClose={() => setShowInquiryForm(false)}
                  />
                )}
                <div className="space-y-2">
                  {detail?.inquiries?.length === 0 && (
                    <p className="text-sm text-muted-foreground">暂无询盘</p>
                  )}
                  {detail?.inquiries?.map((inq) => (
                    <div
                      key={inq.id}
                      className="rounded-lg border bg-card p-4 shadow-[var(--shadow-xs)]"
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">
                          {inq.inquiry_no && (
                            <span className="mr-2 font-mono text-xs text-muted-foreground">
                              {inq.inquiry_no}
                            </span>
                          )}
                          {inq.product_name_raw ?? `询盘 #${inq.id}`}
                        </p>
                        <div className="flex items-center gap-2">
                          {inq.inquiry_no_editable && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                setInquiryNoError(null);
                                setInquiryNoEdit(inq);
                              }}
                            >
                              改编号
                            </Button>
                          )}
                          <Link
                            href={`/quotes?tab=product&customer_id=${customer.id}&inquiry_id=${inq.id}`}
                            className="text-xs text-primary hover:underline"
                          >
                            为此询盘报价 →
                          </Link>
                          <StatusBadge
                            tone={
                              inq.status === "won"
                                ? "success"
                                : inq.status === "lost"
                                  ? "danger"
                                  : "default"
                            }
                          >
                            {INQUIRY_STATUS_LABELS[inq.status] ?? inq.status}
                          </StatusBadge>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {inq.channel && `${inq.channel} · `}
                        {inq.quantity != null &&
                          `${inq.quantity} ${inq.quantity_unit ?? ""} · `}
                        {inq.application && `${inq.application} · `}
                        {new Date(inq.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  ))}
                  <NumberEditDialog
                    open={inquiryNoEdit !== null}
                    onOpenChange={(open) => {
                      if (!open) setInquiryNoEdit(null);
                    }}
                    title="修改询盘编号"
                    label="询盘编号"
                    currentValue={inquiryNoEdit?.inquiry_no ?? ""}
                    description="询盘编号默认自动生成；生成报价单之前可以修改。"
                    warning="确认后编号会立即生效。一旦用该询盘生成报价单，编号将自动锁定，不能再改。"
                    pending={inquiryNoPending}
                    error={inquiryNoError}
                    onConfirm={handleInquiryNoSave}
                  />
                </div>
              </div>
            )}

            {activeTab === "history" && (
              <div className="space-y-2">
                {detail?.stage_log?.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无历史记录</p>
                ) : (
                  detail?.stage_log?.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-lg border bg-card p-4 text-sm shadow-[var(--shadow-xs)]"
                    >
                      <div className="flex items-center justify-between">
                        <span>
                          {log.from_stage ? stageLabel(log.from_stage) : "创建"}
                          {" -> "}
                          {stageLabel(log.to_stage)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(log.created_at).toLocaleString()}
                        </span>
                      </div>
                      {log.reason && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {log.reason}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/*
              往来记录：与该客户的「信息 / 联系人 / 询盘 / 历史」并列的一块，
              刻意**不塞进 tab** —— 它是"这个客户发生过什么"的主视图，
              藏在 tab 里会让"客户名下有哪些报价/订单/单证"变得不容易发现。
              自成一块的好处是：接口还没上线时，只有这一块降级，
              上面的 tab 内容照常可用（设计文档 §1.6 / §4）。
            */}
            <div className="mt-6 border-t pt-4">
              <CustomerRecordsTree
                customerId={customer.id}
                customerName={customer.company_name}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CustomersPage() {
  usePageView({ resource_id: "/customers" });
  const [searchQ, setSearchQ] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null,
  );

  const { data: listData, isLoading } = useCustomerList(searchQ || undefined);

  // 权限口径（UNCERTAIN #21）：所有登录用户可用业务客户管理，
  // 团队隔离由后端 _scope_filter 保证；登录态由布局层 AuthGate 统一管。
  return (
    <div className="space-y-6">
      <PageHeader
        title="客户管理"
        description="跟进询盘、阶段与联系人"
        actions={
          <Button onClick={() => setShowCreateForm(true)}>
            <UserPlus className="size-4 mr-1" />
            新建客户
          </Button>
        }
      />

      {showCreateForm && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>新建客户</CardTitle>
          </CardHeader>
          <CardContent>
            <CustomerForm
              onClose={() => setShowCreateForm(false)}
              onCreated={setSelectedCustomer}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              placeholder="搜索客户…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              className="max-w-sm"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <p className="text-sm text-muted-foreground">加载中…</p>
          )}
          {!isLoading && listData?.items?.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无客户</p>
          )}
          <div className="space-y-2">
            {listData?.items?.map((c) => (
              <div
                key={c.id}
                data-testid="customer-card"
                className="rounded-lg border bg-card p-4 cursor-pointer transition-all hover:shadow-[var(--shadow-md)] hover:border-primary/20"
                onClick={() => setSelectedCustomer(c)}
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm">{c.company_name}</p>
                  <StatusBadge tone={STAGE_TONES[c.stage] ?? "default"}>
                    {stageLabel(c.stage)}
                  </StatusBadge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {c.country && `${c.country} · `}
                  {c.default_port && `${c.default_port} · `}
                  更新于 {new Date(c.updated_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {selectedCustomer && (
        <CustomerDetailPanel
          customer={selectedCustomer}
          onClose={() => setSelectedCustomer(null)}
          onUpdated={setSelectedCustomer}
        />
      )}
    </div>
  );
}
