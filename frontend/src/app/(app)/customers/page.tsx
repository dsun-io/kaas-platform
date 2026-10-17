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

const STAGE_LABELS: Record<string, string> = {
  lead: "线索",
  inquiry: "询盘",
  quoted: "已报价",
  negotiating: "洽谈中",
  won: "成交",
  lost: "流失",
  inactive: "沉寂",
};

const INQUIRY_STATUS_LABELS: Record<string, string> = {
  open: "进行中",
  quoted: "已报价",
  won: "成交",
  lost: "流失",
};

const STAGE_TONES: Record<string, import("@/components/shared").StatusTone> = {
  lead: "default",
  inquiry: "info",
  quoted: "purple",
  negotiating: "warning",
  won: "success",
  lost: "danger",
  inactive: "default",
};

interface Customer {
  id: number;
  company_name: string;
  country: string | null;
  address: string | null;
  default_port: string | null;
  credit_level: string | null;
  stage: string;
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
    response?: { data?: { detail?: string } };
    message?: string;
  };
  return err?.response?.data?.detail ?? err?.message ?? "请求失败";
}

type CustomerFormState = {
  company_name: string;
  country: string;
  address: string;
  default_port: string;
  credit_level: string;
  stage: string;
  notes: string;
};

const EMPTY_CUSTOMER: CustomerFormState = {
  company_name: "",
  country: "",
  address: "",
  default_port: "",
  credit_level: "",
  stage: "lead",
  notes: "",
};

function CustomerForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: Customer) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CustomerFormState>(EMPTY_CUSTOMER);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const set =
    (k: keyof CustomerFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [k]: e.target.value });

  const handleSubmit = async () => {
    setIsPending(true);
    setError(null);
    try {
      const { data } = await apiClient.post<Customer>("/customers", form);
      qc.invalidateQueries({ queryKey: ["customers"] });
      onCreated(data);
      onClose();
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input
          placeholder="公司名称 *"
          value={form.company_name}
          onChange={set("company_name")}
        />
        <Input
          placeholder="国家"
          value={form.country}
          onChange={set("country")}
        />
      </div>
      <Input
        placeholder="地址"
        value={form.address}
        onChange={set("address")}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          placeholder="默认港口"
          value={form.default_port}
          onChange={set("default_port")}
        />
        <Input
          placeholder="信用等级"
          value={form.credit_level}
          onChange={set("credit_level")}
        />
      </div>
      <select
        value={form.stage}
        onChange={set("stage")}
        className="w-full border rounded-md px-3 py-2 text-sm bg-background"
      >
        {Object.entries(STAGE_LABELS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <Input placeholder="备注" value={form.notes} onChange={set("notes")} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button
          onClick={handleSubmit}
          disabled={!form.company_name || isPending}
        >
          {isPending ? "创建中…" : "创建客户"}
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
      <div className="grid grid-cols-2 gap-3">
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
      <div className="grid grid-cols-2 gap-3">
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
}: {
  customerId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ContactFormState>(EMPTY_CONTACT);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async () => {
    setIsPending(true);
    setError(null);
    try {
      await apiClient.post<Contact>(`/customers/${customerId}/contacts`, {
        customer_id: customerId,
        name: form.name,
        position: form.position || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        whatsapp: form.whatsapp || undefined,
        is_primary: form.is_primary,
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
      <div className="grid grid-cols-2 gap-3">
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
      <div className="grid grid-cols-2 gap-3">
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
          {isPending ? "提交中…" : "添加联系人"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}

function StageUpdate({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [stage, setStage] = useState(customer.stage);
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
        {Object.entries(STAGE_LABELS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <Input
        placeholder="原因（可选）"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleUpdate} disabled={isPending}>
          {isPending ? "更新中…" : "更新阶段"}
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
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = useCustomerDetail(customer.id);
  const [activeTab, setActiveTab] = useState<DetailTab>("info");
  const [showInquiryForm, setShowInquiryForm] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);
  const [showStageUpdate, setShowStageUpdate] = useState(false);

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
                <div className="grid grid-cols-2 gap-3 text-sm">
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
                      {STAGE_LABELS[detail.stage] ?? detail.stage}
                    </StatusBadge>
                  </div>
                  {detail.notes && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">备注：</span>
                      <span className="ml-1">{detail.notes}</span>
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowStageUpdate(true)}
                >
                  更新阶段
                </Button>
                {showStageUpdate && (
                  <StageUpdate
                    customer={customer}
                    onClose={() => setShowStageUpdate(false)}
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
                <div className="space-y-2">
                  {detail?.contacts?.length === 0 && (
                    <p className="text-sm text-muted-foreground">暂无联系人</p>
                  )}
                  {detail?.contacts?.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-lg border bg-card p-4 shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]"
                    >
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
                          {inq.product_name_raw ?? `询盘 #${inq.id}`}
                        </p>
                        <div className="flex items-center gap-2">
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
                          {log.from_stage
                            ? (STAGE_LABELS[log.from_stage] ?? log.from_stage)
                            : "创建"}
                          {" -> "}
                          {STAGE_LABELS[log.to_stage] ?? log.to_stage}
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
                className="rounded-lg border bg-card p-4 cursor-pointer transition-all hover:shadow-[var(--shadow-md)] hover:border-primary/20"
                onClick={() => setSelectedCustomer(c)}
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm">{c.company_name}</p>
                  <StatusBadge tone={STAGE_TONES[c.stage] ?? "default"}>
                    {STAGE_LABELS[c.stage] ?? c.stage}
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
        />
      )}
    </div>
  );
}
