"use client";

import { useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, StatusBadge, SectionCard, EmptyState } from "@/components/shared";
import { Plus, Search, UserPlus } from "lucide-react";

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  inquiry: "Inquiry",
  quoted: "Quoted",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
  inactive: "Inactive",
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
      const { data } = await apiClient.get<{ items: Customer[]; total: number }>(`/customers?${params}`);
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
  const err = e as { response?: { data?: { detail?: string } }; message?: string };
  return err?.response?.data?.detail ?? err?.message ?? "Request failed";
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

function CustomerForm({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Customer) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CustomerFormState>(EMPTY_CUSTOMER);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const set = (k: keyof CustomerFormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
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
        <Input placeholder="Company name *" value={form.company_name} onChange={set("company_name")} />
        <Input placeholder="Country" value={form.country} onChange={set("country")} />
      </div>
      <Input placeholder="Address" value={form.address} onChange={set("address")} />
      <div className="grid grid-cols-2 gap-3">
        <Input placeholder="Default port" value={form.default_port} onChange={set("default_port")} />
        <Input placeholder="Credit level" value={form.credit_level} onChange={set("credit_level")} />
      </div>
      <select
        value={form.stage}
        onChange={set("stage")}
        className="w-full border rounded-md px-3 py-2 text-sm bg-background"
      >
        {Object.entries(STAGE_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
      <Input placeholder="Notes" value={form.notes} onChange={set("notes")} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={!form.company_name || isPending}>
          {isPending ? "Creating..." : "Create customer"}
        </Button>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
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

function InquiryForm({ customerId, onClose }: { customerId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<InquiryFormState>(EMPTY_INQUIRY);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const set = (k: keyof InquiryFormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
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
        <Input placeholder="Channel (Alibaba / Expo / Web)" value={form.channel} onChange={set("channel")} />
        <Input placeholder="Product name (raw)" value={form.product_name_raw} onChange={set("product_name_raw")} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input placeholder="Quantity" type="number" value={form.quantity} onChange={set("quantity")} />
        <Input placeholder="Unit (sqm / roll / ton)" value={form.quantity_unit} onChange={set("quantity_unit")} />
      </div>
      <Input placeholder="Application" value={form.application} onChange={set("application")} />
      <Input placeholder="Notes" value={form.notes} onChange={set("notes")} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Submitting..." : "Add inquiry"}
        </Button>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
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

function ContactForm({ customerId, onClose }: { customerId: number; onClose: () => void }) {
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
        <Input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input placeholder="Position" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <Input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <Input placeholder="WhatsApp" value={form.whatsapp} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.is_primary}
          onChange={(e) => setForm({ ...form, is_primary: e.target.checked })}
          className="rounded border"
        />
        Primary contact
      </label>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={!form.name || isPending}>
          {isPending ? "Submitting..." : "Add contact"}
        </Button>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

function StageUpdate({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState(customer.stage);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleUpdate = async () => {
    setIsPending(true);
    setError(null);
    try {
      await apiClient.patch<Customer>(`/customers/${customer.id}/stage`, { stage, reason: reason || undefined });
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
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
      <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleUpdate} disabled={isPending}>
          {isPending ? "Updating..." : "Update stage"}
        </Button>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

type DetailTab = "info" | "contacts" | "inquiries" | "history";

function CustomerDetailPanel({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { data: detail, isLoading } = useCustomerDetail(customer.id);
  const [activeTab, setActiveTab] = useState<DetailTab>("info");
  const [showInquiryForm, setShowInquiryForm] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);
  const [showStageUpdate, setShowStageUpdate] = useState(false);

  const tabs: { key: DetailTab; label: string }[] = [
    { key: "info", label: "Info" },
    { key: "contacts", label: `Contacts (${detail?.contacts.length ?? 0})` },
    { key: "inquiries", label: `Inquiries (${detail?.inquiries.length ?? 0})` },
    { key: "history", label: "History" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>{customer.company_name}</CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
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
                    <span className="text-muted-foreground">Country:</span>
                    <span className="ml-1">{detail.country ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Credit:</span>
                    <span className="ml-1">{detail.credit_level ?? "-"}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Address:</span>
                    <span className="ml-1">{detail.address ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Port:</span>
                    <span className="ml-1">{detail.default_port ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Stage:</span>
                    <StatusBadge tone={STAGE_TONES[detail.stage] ?? "default"} className="ml-1">
                      {STAGE_LABELS[detail.stage] ?? detail.stage}
                    </StatusBadge>
                  </div>
                  {detail.notes && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Notes:</span>
                      <span className="ml-1">{detail.notes}</span>
                    </div>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowStageUpdate(true)}>
                  Update stage
                </Button>
                {showStageUpdate && <StageUpdate customer={customer} onClose={() => setShowStageUpdate(false)} />}
              </div>
            )}

            {activeTab === "contacts" && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">{detail.contacts.length} contacts</span>
                  <Button size="sm" onClick={() => setShowContactForm(true)}>
                    <Plus className="size-4 mr-1" />Add contact
                  </Button>
                </div>
                {showContactForm && <ContactForm customerId={customer.id} onClose={() => setShowContactForm(false)} />}
                <div className="space-y-2">
                  {detail.contacts.length === 0 && (
                    <p className="text-sm text-muted-foreground">No contacts yet</p>
                  )}
                  {detail.contacts.map((c) => (
                    <div key={c.id} className="rounded-lg border bg-card p-4 shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]">
                      <p className="font-medium text-sm">
                        {c.name}
                        {c.is_primary && <Badge variant="default" className="ml-2">Primary</Badge>}
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
                  <span className="text-sm text-muted-foreground">{detail.inquiries.length} inquiries</span>
                  <Button size="sm" onClick={() => setShowInquiryForm(true)}>
                    <Plus className="size-4 mr-1" />Add inquiry
                  </Button>
                </div>
                {showInquiryForm && <InquiryForm customerId={customer.id} onClose={() => setShowInquiryForm(false)} />}
                <div className="space-y-2">
                  {detail.inquiries.length === 0 && (
                    <p className="text-sm text-muted-foreground">No inquiries yet</p>
                  )}
                  {detail.inquiries.map((inq) => (
                    <div key={inq.id} className="rounded-lg border bg-card p-4 shadow-[var(--shadow-xs)]">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">
                          {inq.product_name_raw ?? `Inquiry #${inq.id}`}
                        </p>
                        <StatusBadge tone={inq.status === "won" ? "success" : inq.status === "lost" ? "danger" : "default"}>
                          {inq.status}
                        </StatusBadge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {inq.channel && `${inq.channel} · `}
                        {inq.quantity != null && `${inq.quantity} ${inq.quantity_unit ?? ""} · `}
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
                {detail.stage_log.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No history</p>
                ) : (
                  detail.stage_log.map((log) => (
                    <div key={log.id} className="rounded-lg border bg-card p-4 text-sm shadow-[var(--shadow-xs)]">
                      <div className="flex items-center justify-between">
                        <span>
                          {log.from_stage ? (STAGE_LABELS[log.from_stage] ?? log.from_stage) : "Created"}
                          {" -> "}
                          {STAGE_LABELS[log.to_stage] ?? log.to_stage}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(log.created_at).toLocaleString()}
                        </span>
                      </div>
                      {log.reason && <p className="text-xs text-muted-foreground mt-1">{log.reason}</p>}
                    </div>
                  ))
                )}
              </div>
            )}
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
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  const { data: listData, isLoading } = useCustomerList(searchQ || undefined);

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <PageHeader
          title="Customer Management"
          description="Track inquiries, stages, and contacts"
          actions={
            <Button onClick={() => setShowCreateForm(true)}>
              <UserPlus className="size-4 mr-1" />New customer
            </Button>
          }
        />

        {showCreateForm && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>New customer</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerForm onClose={() => setShowCreateForm(false)} onCreated={setSelectedCustomer} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Search className="size-4 text-muted-foreground" />
              <Input
                placeholder="Search customers..."
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                className="max-w-sm"
              />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!isLoading && listData?.items.length === 0 && (
              <p className="text-sm text-muted-foreground">No customers yet</p>
            )}
            <div className="space-y-2">
              {listData?.items.map((c) => (
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
                    Updated {new Date(c.updated_at).toLocaleDateString()}
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
    </RouteGuard>
  );
}
