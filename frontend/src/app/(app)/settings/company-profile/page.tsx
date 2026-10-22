"use client";

import { LoadingBlock } from "@/components/shared/loading-block";

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
import { useTeam } from "@/lib/team/team-context";

import {
  useCompanyProfile,
  useSaveCompanyProfile,
  type CompanyProfile,
} from "../../trade-docs/hooks/use-trade-docs";

import {
  buildCompanyProfileSavePayload,
  canManageCompanySeals,
} from "./company-profile-rules";

import { CompanySealCard } from "./components/company-seal-card";
import { ClauseTemplatesCard } from "./components/clause-templates-card";

type FieldKey = keyof CompanyProfile;

interface FieldDef {
  key: FieldKey;
  label: string;
  /** 输入框 placeholder（示例值） */
  hint?: string;
  /** 输入框下方的补充说明 */
  help?: string;
}

type GroupDef =
  | { title: string; note?: string; fields: FieldDef[]; columns?: never }
  | {
      title: string;
      note?: string;
      /** 分组内再分栏（银行中英双栏）；与 fields 二选一 */
      columns: { title: string; note?: string; fields: FieldDef[] }[];
      fields?: never;
    };

const GROUPS: GroupDef[] = [
  {
    title: "公司主体（对外签约名，英文必填）",
    note: "英文名、英文地址与税号会直接印在发票、装箱单、合同上，请与营业执照/报关主体一致。",
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
      {
        key: "tax_id",
        label: "公司税号",
        hint: "91131125MA0GA4242U",
        help: "统一社会信用代码/纳税人识别号：单据上作为 Tax ID / Beneficiary Tax ID 打印。",
      },
    ],
  },
  {
    title: "收款银行（PI / 合同 / 汇票使用）",
    note: "客户付汇与信用证议付要用，填错会直接导致收不到钱。受益人 = 公司英文名 / 英文地址 / 税号，自动带入单据（英文手填，不做 AI 翻译）。",
    columns: [
      {
        title: "英文栏（印在英文单据上）",
        note: "用于 PI / 合同 / 汇票的 Remittance Information / Beneficiary Bank。",
        fields: [
          {
            key: "bank_name",
            label: "英文开户行",
            hint: "Bank of China, Anping Sub-branch",
          },
          {
            key: "bank_address_en",
            label: "英文银行地址",
            hint: "Anping County, Hengshui, Hebei, China",
          },
          { key: "bank_account", label: "账号" },
          { key: "swift_code", label: "SWIFT Code", hint: "BKCHCNBJ220" },
        ],
      },
      {
        title: "中文栏（仅内部参考，不印单据）",
        note: "给自己人核对用；不会出现在任何英文单据上。",
        fields: [
          {
            key: "bank_name_zh",
            label: "中文开户行（仅内部参考）",
            hint: "中国银行安平支行",
          },
          {
            key: "bank_address_zh",
            label: "中文银行地址（仅内部参考）",
            hint: "河北省衡水市安平县",
          },
        ],
      },
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

  // 写入权限口径（2026-10-22 修订）：
  //   · 企业抬头/收款信息：后端 `_require_team_admin` = 团队管理员或平台管理员
  //     ⇒ 前端用 `/teams/me` 的 `is_admin`（useTeam().isTeamAdmin，与后端 is_team_admin 同判据）；
  //   · 公章资产：**与写闸门同口径 = canEdit**。
  //     历史 bug：这里曾用 `user.account_type === 'internal'` 判定 ⇒ 团队管理员
  //     （客户账号）永远看不到上传/设默认/删除入口，成员反而能操作。已修。
  // 非管理员**不做整页 403**（页面本身只读展示同样有价值，仓库口径也不给 route 级 403），
  // 改为禁用写入入口 + 保留只读展示。
  const { isTeamAdmin } = useTeam();
  const canEdit = isTeamAdmin;
  // 口径收敛在纯函数里（company-profile-rules.ts），便于单测钉住「管理员可写/成员只读」
  const canManageSeals = canManageCompanySeals(canEdit);

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
    if (!canEdit) {
      toast.error("仅团队管理员可保存企业信息");
      return;
    }
    // 校验 + 归一化（税号 trim/大写、SWIFT、必填）全在纯函数里，便于单测
    const result = buildCompanyProfileSavePayload(draft);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    save.mutate(result.payload, {
      onSuccess: () =>
        toast.success("已保存。新开与预览的单据都会带上这个抬头。"),
    });
  };

  /** 单个字段输入框（普通分组与银行中英双栏共用） */
  const renderField = (field: FieldDef) => (
    <label key={field.key as string} className="space-y-1">
      <span className="text-sm font-medium">{field.label}</span>
      <Input
        value={draft[field.key as string] ?? ""}
        placeholder={field.hint}
        readOnly={!canEdit}
        onChange={(e) => set(field.key as string, e.target.value)}
      />
      {field.help && (
        <span className="block text-xs text-muted-foreground">
          {field.help}
        </span>
      )}
    </label>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="企业信息"
        description="对外单据的卖方抬头与收款银行。保存一次，所有单证自动带入。"
        actions={
          <Button onClick={submit} disabled={save.isPending || !canEdit}>
            <Save className="mr-1 h-4 w-4" />
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        }
      />

      <div className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
        {canEdit ? (
          <>
            本页<strong>仅团队管理员可保存</strong>
            （成员可查看）。企业抬头、收款银行与公章都会直接印在
            对外单证上，修改前请与营业执照/银行账户核对。
          </>
        ) : (
          <>
            当前账号<strong>只能查看</strong>企业信息（保存需团队管理员）。
            如需修改抬头、收款银行或公章，请联系团队管理员。
          </>
        )}
      </div>

      {profile.isLoading ? (
        <LoadingBlock rows={5} className="py-8" />
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
              {group.columns ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  {group.columns.map((column) => (
                    <div key={column.title} className="space-y-3">
                      <div>
                        <p className="text-sm font-semibold">{column.title}</p>
                        {column.note && (
                          <p className="text-xs text-muted-foreground">
                            {column.note}
                          </p>
                        )}
                      </div>
                      <div className="space-y-3">
                        {column.fields.map(renderField)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {group.fields.map(renderField)}
                </div>
              )}
            </SectionCard>
          ))}

          <div className="flex justify-end">
            <Button onClick={submit} disabled={save.isPending || !canEdit}>
              <Save className="mr-1 h-4 w-4" />
              {save.isPending ? "保存中…" : "保存企业信息"}
            </Button>
          </div>
        </>
      )}

      {/* 公章是独立资产（tenant_company_seals），不依赖企业信息是否读取成功 */}
      <CompanySealCard canWrite={canManageSeals} />

      {/* 条款模板（A5-W1）：团队级条款库；写入权限 = 后端 team admin（此处沿用同一 canEdit 口径） */}
      <ClauseTemplatesCard canWrite={canEdit} />
    </div>
  );
}
