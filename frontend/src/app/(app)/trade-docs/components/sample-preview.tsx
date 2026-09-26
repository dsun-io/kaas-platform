"use client";

/**
 * 样板预览 —— 用内置样例数据渲染全部 18 类单据，**不需要后端**。
 *
 * 为什么需要这条通路
 * ----------------
 * 单据渲染已经在前端完成（后端只给数据），但工位台账依赖数据库。
 * 开发阶段后端没起时，整个工位是空的 —— 很容易让人误以为「预览坏了」。
 * 这里给一条不依赖任何服务的通路：随时可以看版式、校对金额大写与日期写法。
 *
 * 边界说清楚：样例数据是固定的演示数据，**不写数据库、不产生任何业务记录**，
 * 只用于版面评审与自检。
 */
import { useMemo, useState } from "react";
import { Eye } from "lucide-react";

import { getAvailableTemplates } from "@/lib/trade-doc/render";
import sample from "@/lib/trade-doc/sample-data.json";

import { DocPreview } from "./doc-preview";
import { DOC_TYPE_GROUPS, THIRD_PARTY_TYPES } from "../lib/doc-type-groups";

interface SampleData {
  doc_types: string[];
  base: Record<string, unknown>;
  other_extra: Record<string, unknown>;
}

const SAMPLE = sample as unknown as SampleData;

export function SamplePreview() {
  const [docType, setDocType] = useState("ci");
  const templates = useMemo(() => getAvailableTemplates(), []);

  // other 类型需要额外的 title/content，与其基准产物保持一致
  const data = useMemo(
    () => ({
      ...SAMPLE.base,
      ...(docType === "other" ? SAMPLE.other_extra : {}),
    }),
    [docType],
  );

  const docNo = useMemo(() => {
    const spec = templates.find((t) => t.doc_type === docType);
    return `样板 · ${spec?.name_en ?? docType}`;
  }, [docType, templates]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Eye className="h-4 w-4 text-muted-foreground" />
        <select
          className="h-9 min-w-[320px] rounded-md border border-input bg-background px-2 text-sm"
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
        >
          {DOC_TYPE_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.types
                .map((type) => templates.find((t) => t.doc_type === type))
                .filter((t): t is NonNullable<typeof t> => Boolean(t))
                .map((t) => (
                  <option key={t.doc_type} value={t.doc_type}>
                    {t.name_zh} · {t.name_en}
                    {THIRD_PARTY_TYPES.has(t.doc_type) ? "（第三方签发）" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          固定样例数据（不写库）；点「打印 / 导出 PDF」可直接出成品
        </span>
      </div>

      <DocPreview
        docType={docType}
        docNo={docNo}
        data={data}
        companyProfileConfigured
      />
    </div>
  );
}
