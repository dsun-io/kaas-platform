"use client";

/**
 * 企业主体信息（设置 → 企业信息）—— 所有对外单据的卖方抬头。
 *
 * 为什么必须配：单证的第一行是卖方信头（公司英文名 + 英文地址 + 联系方式），
 * PI/合同/汇票还要收款银行与 SWIFT。没配的话每张单据的抬头都是空白 ——
 * 单据没有卖方抬头等同废纸，而且每次都要手工重填。
 *
 * 这里保存一次，所有单据自动带入；下方的「单据默认条款」用于新开单时预填，
 * 省去每张重填贸易术语与付款方式。
 */
import { useEffect, useState } from "react";
import { Building2, Save } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePageView } from "@/lib/events/use-page-view";

import {
  useCompanyProfile,
  useSaveCompanyProfile,
  type CompanyProfile,
} from "../../trade-docs/hooks/use-trade-docs";

import { CompanySealCard } from "./components/company-seal-card";

type FieldKey = keyof CompanyProfile;

const GROUPS: {
  title: string;
  note?: string;
  fields: { key: FieldKey; label: string; hint?: string }[];
}[] = [
  {
    title: "公司主体（对外签约名，英文必填）",
    note: "英文名与英文地址会直接印在发票、装箱单、合同上，请与营业执照/报关主体一致。",
    fields: [
      {
        key: "name_en",
        label: "公司英文名（必填）",
        hint: "ANPING HENGTAI WIRE MESH PRODUCTS CO., LTD.",
      },
      {
        key: "name_zh",
        label: "公司中文名",
        hint: "仅内部识别用，不印在英文单据上",
      },
      {
        key: "address_en",
        label: "英文地址",
        hint: "Wire Mesh Industrial Park, Anping County, Hengshui, Hebei, China",
      },
      { key: "address_zh", label: "中文地址" },
      { key: "phone", label: "电话", hint: "+86-318-765-4321" },
      { key: "email", label: "邮箱", hint: "export@example.com" },
      { key: "website", label: "网站" },
    ],
  },
  {
    title: "收款银行（PI / 合同 / 汇票使用）",
    note: "客户付汇与信用证议付要用，填错会直接导致收不到钱。",
    fields: [
      {
        key: "bank_name",
        label: "开户行",
        hint: "Bank of China, Anping Sub-branch",
      },
      { key: "bank_account", label: "账号" },
      { key: "swift_code", label: "SWIFT Code", hint: "BKCHCNBJ220" },
    ],
  },
  {
    title: "单据默认条款（新开单时预填）",
    note: "省去每张单据重填贸易术语与付款方式；单据上仍可单独修改。",
    fields: [
      { key: "default_incoterm", label: "默认贸易术语", hint: "FOB Tianjin" },
      {
        key: "default_payment_terms",
        label: "默认付款方式",
        hint: "T/T 30% deposit, balance against B/L copy",
      },
      { key: "default_country_of_origin", label: "默认原产国", hint: "China" },
    ],
  },
];

export default function CompanyProfilePage() {
  usePageView({ resource_id: "/settings/company-profile" });
  const profile = useCompanyProfile();
  const save = useSaveCompanyProfile();
  const [draft, setDraft] = useState<Record<string, string>>({});

  // 服务器数据到了之后灌入表单
  useEffect(() => {
    if (!profile.data) return;
    setDraft(
      Object.fromEntries(
        Object.entries(profile.data).map(([k, v]) => [
          k,
          typeof v === "string" ? v : "",
        ]),
      ),
    );
  }, [profile.data]);

  const set = (key: string, value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    const nameEn = (draft.name_en ?? "").trim();
    if (!nameEn) {
      toast.error("公司英文名必填 —— 它是单据上的卖方主体名");
      return;
    }
    const swift = (draft.swift_code ?? "").trim().toUpperCase();
    if (swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift)) {
      toast.error("SWIFT Code 必须是 8 位或 11 位字母/数字（如 BKCHCNBJ220）");
      return;
    }
    save.mutate(
      {
        ...(draft as Partial<CompanyProfile>),
        name_en: nameEn,
        swift_code: swift || null,
      },
      {
        onSuccess: () =>
          toast.success("已保存。新开与预览的单据都会带上这个抬头。"),
      },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="企业信息"
        description="对外单据的卖方抬头与收款银行。保存一次，所有单证自动带入。"
        actions={
          <Button onClick={submit} disabled={save.isPending}>
            <Save className="mr-1 h-4 w-4" />
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        }
      />

      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        本页<strong>仅团队管理员可保存</strong>（成员可查看）。企业抬头、收款银行与公章都会直接印在
        对外单证上，修改前请与营业执照/银行账户核对。
      </div>

      {profile.isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          加载中…
        </p>
      ) : profile.isError ? (
        <SectionCard title="无法读取企业信息">
          <p className="text-sm text-destructive">
            读取失败。若数据库尚未执行本次新增的表结构迁移，请先在开发库执行迁移。
          </p>
        </SectionCard>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            {profile.data?.configured ? (
              <StatusBadge tone="success" dot>
                已配置 —— 单据抬头会正常显示
              </StatusBadge>
            ) : (
              <StatusBadge tone="danger" dot>
                未配置 —— 当前所有单据的卖方抬头为空
              </StatusBadge>
            )}
          </div>

          {GROUPS.map((group) => (
            <SectionCard
              key={group.title}
              title={group.title}
              description={group.note}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <label key={field.key as string} className="space-y-1">
                    <span className="text-sm font-medium">{field.label}</span>
                    <Input
                      value={draft[field.key as string] ?? ""}
                      placeholder={field.hint}
                      onChange={(e) => set(field.key as string, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </SectionCard>
          ))}

          <div className="flex justify-end">
            <Button onClick={submit} disabled={save.isPending}>
              <Save className="mr-1 h-4 w-4" />
              {save.isPending ? "保存中…" : "保存企业信息"}
            </Button>
          </div>
        </>
      )}

      {/* 公章是独立资产（tenant_company_seals），不依赖企业信息是否读取成功 */}
      <CompanySealCard />
    </div>
  );
}
