"use client";

/**
 * 联系人表单 + 联系人信息弹窗（从 page.tsx 抽出，行为不变）。
 */
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { FormField } from "@/components/shared/form-field";
import apiClient from "@/lib/api/client";

import type { Contact } from "./customer-types";
import { errMsg } from "./error-message";

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
  // 同一详情里可能同时挂「新增联系人」和「编辑联系人」两个表单 ⇒ id 必须唯一
  const fieldId = useId();
  const field = (key: string) => `${fieldId}-${key}`;

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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="姓名" required htmlFor={field("name")}>
          <Input
            placeholder="联系人姓名"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </FormField>
        <FormField label="职位" htmlFor={field("position")}>
          <Input
            placeholder="如：采购经理"
            value={form.position}
            onChange={(e) => setForm({ ...form, position: e.target.value })}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="电话" htmlFor={field("phone")}>
          <Input
            placeholder="如：+86 138…"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </FormField>
        <FormField label="邮箱" htmlFor={field("email")}>
          <Input
            placeholder="如：buyer@example.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </FormField>
      </div>
      <FormField label="WhatsApp" htmlFor={field("whatsapp")}>
        <Input
          placeholder="如：+86 138…"
          value={form.whatsapp}
          onChange={(e) => setForm({ ...form, whatsapp: e.target.value })}
        />
      </FormField>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.is_primary}
          onChange={(e) => setForm({ ...form, is_primary: e.target.checked })}
          className="rounded border"
        />
        主要联系人
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
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

/** 联系人信息弹窗（询盘详情里点联系人名字打开，不跳页）。 */
function ContactInfoDialog({
  contact,
  onClose,
}: {
  contact: Contact | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={contact !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-sm rounded-2xl border border-white/60 bg-white/90 p-0 backdrop-blur-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/70 px-5 py-4">
          <div>
            <DialogTitle className="text-base">
              {contact?.name ?? "联系人"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              联系人信息
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭联系人信息"
          >
            <X className="size-4" />
          </Button>
        </div>
        <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 px-5 py-4 text-sm">
          {contact?.position && (
            <>
              <dt className="text-muted-foreground">职位</dt>
              <dd>{contact.position}</dd>
            </>
          )}
          {contact?.phone && (
            <>
              <dt className="text-muted-foreground">电话</dt>
              <dd className="tabular-nums">{contact.phone}</dd>
            </>
          )}
          {contact?.email && (
            <>
              <dt className="text-muted-foreground">邮箱</dt>
              <dd className="break-all">{contact.email}</dd>
            </>
          )}
          {contact?.whatsapp && (
            <>
              <dt className="text-muted-foreground">WhatsApp</dt>
              <dd className="tabular-nums">{contact.whatsapp}</dd>
            </>
          )}
          {!contact?.position &&
            !contact?.phone &&
            !contact?.email &&
            !contact?.whatsapp && (
              <dd className="col-span-2">
                <EmptyState title="暂无更多联系方式" className="py-2" />
              </dd>
            )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

export { ContactForm, ContactInfoDialog };
