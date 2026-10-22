"use client";

/**
 * 团队与工位 → 企业信息（只读摘要 + 维护入口）。
 *
 * 为什么放在这里：企业抬头 / 银行 / 公章原来只挂在「设置 → 企业信息」
 * （内部账号的 /settings 系）里，团队管理员在团队页看不到自己团队的对外主体是否配好；
 * 2026-10-22 用户要求在团队与工位页加企业信息区块 + 维护入口。
 *
 * 权限口径：**只判断团队管理员**（`useTeam().isTeamAdmin`，与后端
 * `_require_team_admin` 同判据）—— 成员看到只读提示，不给写入口。
 * 这里**不读公章列表**：`GET /tenant/company-seals` 对成员是 403，
 * 在团队页顺手拉一次会让成员页出现无谓的报错块；公章状态在维护页看。
 */
import Link from "next/link";
import { Building2, Pencil } from "lucide-react";

import { SectionCard } from "@/components/shared/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/shared/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { useTeam } from "@/lib/team/team-context";

import { useCompanyProfile } from "../../trade-docs/hooks/use-trade-docs";

const MANAGE_ROUTE = "/settings/company-profile";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{value || "—"}</dd>
    </div>
  );
}

export function TeamCompanyProfileCard() {
  const profile = useCompanyProfile();
  const { isTeamAdmin } = useTeam();
  const data = profile.data;

  return (
    <SectionCard
      title="企业信息"
      description="对外单据的卖方抬头、收款银行与公章。企业信息不是计费工位，所有成员都可查看。"
      action={
        isTeamAdmin ? (
          <Link
            href={MANAGE_ROUTE}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Pencil className="mr-1 size-4" />
            维护企业信息
          </Link>
        ) : undefined
      }
    >
      {profile.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : profile.isError ? (
        <p className="text-sm text-muted-foreground">
          企业信息暂时读取失败。不影响开单；可稍后刷新重试，或到
          <Link
            className="mx-1 text-primary underline-offset-4 hover:underline"
            href={MANAGE_ROUTE}
          >
            企业信息页
          </Link>
          查看。
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Building2 className="size-4 text-muted-foreground" />
            {data?.configured ? (
              <StatusBadge tone="success" dot>
                已配置 —— 单据抬头会正常显示
              </StatusBadge>
            ) : (
              <StatusBadge tone="danger" dot>
                未配置 —— 当前单据的卖方抬头为空
              </StatusBadge>
            )}
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <Field label="公司英文名" value={data?.name_en ?? null} />
            <Field label="公司税号" value={data?.tax_id ?? null} />
            <Field label="英文开户行" value={data?.bank_name ?? null} />
          </dl>

          {isTeamAdmin ? (
            <p className="text-xs text-muted-foreground">
              公司英文名 / 税号 / 银行信息会印在对外单据上；公章（默认章）与
              单据默认条款也在「维护企业信息」里管理。修改前请与营业执照 /
              银行账户核对。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              你只能查看企业信息。如需修改抬头、收款银行或公章，请联系团队管理员
              （公章也由团队管理员在「企业信息」维护页管理）。
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
