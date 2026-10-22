"use client";

import { usePageView } from "@/lib/events/use-page-view";
import { BookOpen } from "lucide-react";
import { RouteGuard } from "@/components/route-guard";
import {
  PageHeader,
  StatusBadge,
  SectionCard,
  EmptyState,
} from "@/components/shared";

/**
 * 知识库管理（建设中）。
 *
 * K1（审计 §4）：这里原来有一组**硬编码假统计**
 * （知识条目 48 / 产品品类 6 / 最近更新 2 小时前 / 数据源 工位能力网）——
 * 没有任何接口支撑，页面一开就"看起来有数据"，比空白更误导。
 * 现在改为**明确「未接入」**：不显示任何估算数字，等真实数据接口落地后再补统计。
 */
export default function KbPage() {
  usePageView({ resource_id: "/kb" });

  return (
    <RouteGuard internalOnly>
      <div className="space-y-6">
        <PageHeader
          title="知识库管理"
          description="产品知识与工位能力资料"
          actions={<StatusBadge tone="warning">建设中</StatusBadge>}
        />

        <SectionCard title="概览">
          <EmptyState
            icon={BookOpen}
            title="知识库统计尚未接入"
            description="知识库还没有数据接口：条目数 / 品类数 / 最近更新时间都无从统计，所以这里不显示估算数字。接口落地后本区展示真实统计。"
          />
        </SectionCard>

        <SectionCard title="知识库内容">
          <EmptyState
            icon={BookOpen}
            title="知识库管理功能即将上线"
            description="支持按工位与产品分类整理知识条目，方便一线同事随时查阅。"
          />
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
