"use client";

/**
 * 「从地图源挑选」tab（从 page.tsx 拆出；勾选/挑选按钮/空态/aria 不变）。
 */
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatusBadge } from "@/components/shared";
import { CRAWL_STATUS_TONES, toneForStatus } from "@/lib/status-tones";
import { CheckCircle2, MapPin, XCircle } from "lucide-react";

import { CRAWL_STATUS_CN } from "../lib/status-labels";
import type { LeadOption } from "../lib/types";

export function ResearchPickSection({
  leads,
  total,
  picked,
  picking,
  onToggle,
  onPick,
}: {
  leads: LeadOption[];
  total: number;
  picked: number[];
  picking: boolean;
  onToggle: (id: number, checked: boolean) => void;
  onPick: () => void;
}) {
  return (
    <SectionCard
      title={`地图源线索 (${total})`}
      description="选择值得深化的记录。产品信息来自官网爬取，而非 Google Places。"
      action={
        <Button
          size="sm"
          onClick={onPick}
          disabled={picking || picked.length === 0}
        >
          {picking ? "挑选中…" : `挑选已选 (${picked.length})`}
        </Button>
      }
    >
      {leads.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="地图源中暂无线索"
          description="请先在「地图源线索采集」中运行抓取"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="p-2 w-8" />
                <th scope="col" className="p-2">
                  公司
                </th>
                <th scope="col" className="p-2">
                  地区
                </th>
                <th scope="col" className="p-2">
                  店铺类型
                </th>
                <th scope="col" className="p-2">
                  产品
                </th>
                <th scope="col" className="p-2">
                  爬取
                </th>
                <th scope="col" className="p-2">
                  可供货
                </th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b hover:bg-muted/40">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={picked.includes(l.id)}
                      onChange={(e) => onToggle(l.id, e.target.checked)}
                    />
                  </td>
                  <td className="p-2 font-medium">{l.company_name}</td>
                  <td className="p-2 text-xs">
                    {[l.country, l.city].filter(Boolean).join(" / ") || "—"}
                  </td>
                  <td className="p-2 text-xs">{l.shop_type ?? "—"}</td>
                  <td className="p-2 text-xs">
                    <div>{l.product_name ?? "—"}</div>
                    <div className="text-muted-foreground">
                      {l.product_name_cn ?? ""}
                    </div>
                  </td>
                  <td className="p-2">
                    <StatusBadge
                      tone={toneForStatus(CRAWL_STATUS_TONES, l.crawl_status)}
                    >
                      {CRAWL_STATUS_CN[l.crawl_status ?? "pending"] ??
                        l.crawl_status ??
                        "pending"}
                    </StatusBadge>
                  </td>
                  <td className="p-2">
                    {l.can_supply === true ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : l.can_supply === false ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
