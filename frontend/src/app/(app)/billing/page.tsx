"use client";

import { CreditCard } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/shared";

export default function BillingPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="升级订阅" description="管理您的订阅计划" />

      <SectionCard
        title="当前方案"
        description="订阅升级功能即将开放，请联系管理员。"
      >
        <div className="flex items-start gap-3">
          <CreditCard className="mt-0.5 size-5 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-lg font-semibold">当前方案：免费版</p>
            <p className="text-sm text-muted-foreground">
              升级后可解锁更多报价模板、批量导入、API
              对接等高级功能。如有需要，请先联系系统管理员开通。
            </p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
