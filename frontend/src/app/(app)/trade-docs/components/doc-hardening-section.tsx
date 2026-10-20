"use client";

/**
 * A7 单证加固区块（单证详情页的五个面板）
 *
 * 组合顺序按业务动线：**先确认事实 → 再看一致性 → 登记收款 → 核对清单 → 导出自检**。
 * 五个面板共享一个 SectionCard，避免详情页再长出五张卡片（原本已有预览/内容版本/
 * 盖章回传三块）。tab 受控：签发被闸门拦下时，「去确认事实」要把用户直接送到事实面板。
 */
import { SectionCard } from "@/components/shared/section-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { DocConsistencyPanel } from "./doc-consistency-panel";
import { DocExportVerifyPanel } from "./doc-export-verify-panel";
import { DocFactsPanel } from "./doc-facts-panel";
import { DocReceiptsPanel } from "./doc-receipts-panel";
import { DocSetPanel } from "./doc-set-panel";

export type HardeningTab =
  | "facts"
  | "consistency"
  | "receipts"
  | "doc-set"
  | "export-verify";

interface Props {
  docId: number;
  status: string | null;
  currency: string | null;
  tab: HardeningTab;
  onTabChange: (tab: HardeningTab) => void;
}

export function DocHardeningSection({
  docId,
  status,
  currency,
  tab,
  onTabChange,
}: Props) {
  return (
    <SectionCard
      title="单证加固"
      description="事实确认 → 一致性 → 收款 → 清单 → 导出自检；未确认事实会阻断签发（不是可选项）。"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as HardeningTab)}
      >
        <TabsList>
          <TabsTrigger value="facts">事实确认</TabsTrigger>
          <TabsTrigger value="consistency">一致性</TabsTrigger>
          <TabsTrigger value="receipts">收款登记</TabsTrigger>
          <TabsTrigger value="doc-set">单证清单</TabsTrigger>
          <TabsTrigger value="export-verify">导出自检</TabsTrigger>
        </TabsList>
        <TabsContent value="facts">
          <DocFactsPanel docId={docId} status={status} />
        </TabsContent>
        <TabsContent value="consistency">
          <DocConsistencyPanel docId={docId} />
        </TabsContent>
        <TabsContent value="receipts">
          <DocReceiptsPanel docId={docId} docCurrency={currency} />
        </TabsContent>
        <TabsContent value="doc-set">
          <DocSetPanel docId={docId} status={status} />
        </TabsContent>
        <TabsContent value="export-verify">
          <DocExportVerifyPanel docId={docId} />
        </TabsContent>
      </Tabs>
    </SectionCard>
  );
}
