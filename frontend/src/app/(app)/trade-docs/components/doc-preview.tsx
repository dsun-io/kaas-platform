"use client";

/**
 * 单证预览：把业务数据渲染成可打印的英文单据，并给出「合规缺口」提示。
 *
 * 关键点
 * ------
 * - 渲染在**前端**完成（零网络往返，点开即见），后端只给数据。
 * - 预览用 iframe + srcDoc：单据 HTML 自带完整样式与 @page 规则，
 *   与最终打印出来的效果一致（所见即所得），不会两边各写一套排版。
 * - 缺字段不是「加载失败」，而是明确列出还差哪几项 ——
 *   否则用户看到的是空白单据，不知道是自己没填还是系统没带过来。
 */
import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Download, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { findMissingRequiredFields } from "@/lib/trade-doc/compliance";
import { downloadHtml, printHtml } from "@/lib/trade-doc/export";
import { renderTradeDoc } from "@/lib/trade-doc/render";

interface DocPreviewProps {
  docType: string;
  docNo: string;
  data: Record<string, unknown>;
  /** 是否已配置企业主体（未配置时卖方抬头是空的，必须显式提示） */
  companyProfileConfigured: boolean;
}

export function DocPreview({
  docType,
  docNo,
  data,
  companyProfileConfigured,
}: DocPreviewProps) {
  const html = useMemo(() => {
    try {
      return renderTradeDoc(docType, data);
    } catch {
      // 未知类型不应该让整个工位崩掉：给出可读提示，其余单据照常可看
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
        <h2>无法渲染该单证</h2><p>单证类型「${docType}」没有对应模板。</p></body></html>`;
    }
  }, [docType, data]);

  const missing = useMemo(
    () => findMissingRequiredFields(docType, data),
    [docType, data],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={missing.length === 0 ? "success" : "warning"} dot>
          {missing.length === 0
            ? "必填齐全，可签发"
            : `还差 ${missing.length} 项必填`}
        </StatusBadge>
        {!companyProfileConfigured && (
          <StatusBadge tone="danger" dot>
            未配置企业主体信息 —— 单据卖方抬头为空
          </StatusBadge>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => printHtml(html)}>
            <Printer className="mr-1 h-4 w-4" />
            打印 / 导出 PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadHtml(`${docNo || docType}.html`, html)}
          >
            <Download className="mr-1 h-4 w-4" />
            下载 HTML
          </Button>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" />
            这张单据还不能直接发给客户 / 报关（以下必填项为空）
          </div>
          <ul className="ml-5 list-disc space-y-0.5">
            {missing.map((item) => (
              <li key={item.field}>
                {item.label}
                <span className="ml-1 text-amber-700">({item.field})</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-800">
            常见原因：企业主体信息未填（卖方抬头）、客户档案缺地址/联系人、上游订单未填贸易条款。
          </p>
        </div>
      )}

      {missing.length === 0 && (
        <div className="flex items-center gap-1 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          必填项齐全，可直接打印或签发。
        </div>
      )}

      <div className="overflow-hidden rounded-md border bg-white">
        <iframe
          title={`单证预览 ${docNo}`}
          srcDoc={html}
          className="h-[900px] w-full"
          sandbox="allow-same-origin"
        />
      </div>
    </div>
  );
}
