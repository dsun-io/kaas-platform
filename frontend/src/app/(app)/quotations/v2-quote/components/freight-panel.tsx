"use client";

import { LoadingBlock } from "@/components/shared/loading-block";

/**
 * 运费与贸易术语 —— 报价结果**之后**的后续环节。
 *
 * 为什么放在结果之后，而不是和报价参数并列的一个页签
 * --------------------------------------------------
 * 运费是**在 EXW 出厂价之上叠加**的，不是另一类输入。真实业务流程也是：
 * 先定出厂价 → 向货代询价 → 拿到运费再对外报 FOB / CFR / CIF / DAP / DDP。
 * 所以顺序必须是：**先出 EXW，再出现这一块**。
 *
 * 这一块同时承担两件事：
 *   ① 把「向货代询价所需的参数」整理成结构化文本，一键复制
 *      （货量、件数、重量、体积、起运港/目的港 —— 货代报价要的就是这几项，
 *       人工拼这些数字既慢又容易抄错）；
 *   ② 收到货代报价后，把各费用项填进来，算出 FOB / CFR / CIF / DAP / DDP。
 *
 * 费用项与门槛口径由平台声明（后端模板），本组件只负责填金额与回传，
 * 不把「FOB 包含哪些费」这类业务知识写死在前端。
 */
import { useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  ExportQuoteResponse,
  ExportTermsTemplate,
  QuoteTable,
} from "@contracts/export-quote";

interface Props {
  result: ExportQuoteResponse;
  view: "customer" | "internal";
  termsTemplate: ExportTermsTemplate | undefined;
  termsLoading: boolean;
  termsFailed: boolean;
  /** 对外报价术语（默认取模板建议值） */
  quoteAs: string;
  onQuoteAsChange: (v: string) => void;
  feeInputs: Record<string, string>;
  onFeeChange: (key: string, v: string) => void;
  requiredFeeKeys: string[];
  /** 填全后重新算一次，得到 FOB / CFR / CIF / DAP / DDP */
  onRecalc: () => void;
  busy: boolean;
  /** 询价参数（来自产品定义与当前规格） */
  productName: string;
  productNameEn: string;
  hsCodes: string[];
  specSummary: string;
  pieces: string;
  unitLabel: string;
  quoteCurrency: string;
  /** 起运港/目的港放在页面级状态 —— 重算时本组件会瞬时卸载，
   *  放在组件内部会把用户刚填的港口清掉。 */
  originPort: string;
  onOriginPortChange: (v: string) => void;
  destPort: string;
  onDestPortChange: (v: string) => void;
}

/** 表头 → 值。列名由后端定义，所以这里只做关键字匹配，不写死完整列名。 */
function rowMap(table: QuoteTable): Map<string, unknown> {
  const first = table.rows[0] ?? [];
  return new Map(table.header.map((h, i) => [h, first[i]]));
}

function pick(map: Map<string, unknown>, ...keywords: string[]): string {
  for (const [h, v] of map) {
    if (keywords.every((k) => h.includes(k))) {
      if (v === null || v === undefined || v === "") return "";
      return String(v);
    }
  }
  return "";
}

function CopyButton({
  text,
  label = "复制给货代",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // 剪贴板不可用（非安全上下文等）时退化为选中提示，不静默失败
          window.prompt("自动复制不可用，请手动复制：", text);
        }
        setDone(true);
        window.setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? "已复制" : label}
    </Button>
  );
}

/** 下拉 / 档位标题的统一显示格式：**`代码 · 中文（English）`**。
 *
 * 例：`DAP · 到门价（Delivered at Place）`。
 * 为什么要带英文全称：DAP / DDP 与 FOB / CIF 的中文叫法在业内并不统一
 * （「到门价」「完税到门价」各家说法不同），对外报价与跟货代沟通时
 * 英文全称才是无歧义的那一半。代码仍是提交给后端的值，不参与显示逻辑。
 *
 * `label_en` 缺失（或与代码相同）时只显示中文，避免出现 `FOB · 离岸价（FOB）` 这类冗余。
 *
 * 中文 label 自带的**尾部括号说明**（如「到门价（目的地交货）」里的「目的地交货」）
 * 在选项里会被裁掉：用户要求的是 `代码 · 中文（English）` 这一种括号，
 * 两层括号会读成 `到门价（目的地交货）（Delivered at Place）`，可读性差。
 * 说明信息仍在档位卡下面的费用项里（每档只列本档新增费用的名称与口径）。
 */
export function termOptionLabel(r: {
  code: string;
  label?: string;
  label_en?: string;
}): string {
  const zh = r.label || r.code;
  // 只裁「整段以全角括号结尾」的说明，不动正文里的括号（如「CIF 加成(110%)」）。
  const zhShort = zh.replace(/（[^（）]*）\s*$/, "").trim() || zh;
  const en = r.label_en && r.label_en !== r.code ? r.label_en : "";
  return en ? `${r.code} · ${zhShort}（${en}）` : `${r.code} · ${zhShort}`;
}

export function FreightPanel({
  result,
  view,
  termsTemplate,
  termsLoading,
  termsFailed,
  quoteAs,
  onQuoteAsChange,
  feeInputs,
  onFeeChange,
  requiredFeeKeys,
  onRecalc,
  busy,
  productName,
  productNameEn,
  hsCodes,
  specSummary,
  pieces,
  unitLabel,
  quoteCurrency,
  originPort,
  onOriginPortChange,
  destPort,
  onDestPortChange,
}: Props) {
  const table =
    view === "internal" && result.internal ? result.internal : result.customer;
  const map = rowMap(table);

  // 货代询价的核心就是「货量」：件数、单件/总重量、体积。
  // 列名不做完整匹配 —— 后端调整列名不应让这块直接失效。
  const unitWeight = pick(map, "单卷", "净重") || pick(map, "净重");
  const totalWeight = pick(map, "总净重") || pick(map, "总重");
  const unitVolume = pick(map, "单卷", "体积");
  // 给货代看的是**实际占用体积**（长方体总体积 − 每单扣减 2.5m³），
  // 不是外接方柱的毛体积 —— 后者只是中间量，报出去会多算运费。
  const effVolume = pick(map, "占用");

  const agentText = [
    "【出口运输询价】",
    `品名：${productName}${productNameEn ? ` / ${productNameEn}` : ""}`,
    hsCodes.length ? `HS 编码：${hsCodes.join(" / ")}` : "",
    specSummary ? `规格：${specSummary}` : "",
    `件数：${pieces} ${unitLabel || "卷"}`,
    unitWeight ? `单卷净重：${unitWeight} kg` : "",
    totalWeight ? `总净重：${totalWeight} kg` : "",
    unitVolume ? `单卷净体积：${unitVolume} m³` : "",
    effVolume ? `实际占用体积：${effVolume} m³（已按每单扣减 2.5 m³）` : "",
    `起运港：${originPort || "（待填）"}`,
    `目的港：${destPort || "（待填）"}`,
    `对外报价术语意向：${quoteAs}`,
    "",
    "请按以上货量报：内陆运费（厂→港）、港杂费、报关费、海运费（或整箱价）、保险费率。",
    "如按 DAP（到门价）/ DDP（完税到门）报价，请另报：目的港费用（拆箱、港杂及送货到门）、进口关税及税费（DDP 完税到门口径），并注明各项有效期。",
  ]
    .filter(Boolean)
    .join("\n");

  const ladder = result.meta.main_term_summary ?? {};
  const ladderCodes = Object.keys(ladder);
  const filledCount = requiredFeeKeys.filter(
    (k) => (feeInputs[k] ?? "") !== "",
  ).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          运费与贸易术语
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            出厂价（EXW）已算出 ｜ 加上运费即得 FOB / CFR / CIF / DAP / DDP
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── ① 向货代询价的参数 ─────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-xs font-medium">① 向货代询价</h3>
              <p className="text-[11px] text-muted-foreground">
                货量参数按已算出的报价自动汇总，补上港口即可发出
              </p>
            </div>
            <CopyButton text={agentText} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">起运港</Label>
              <Input
                value={originPort}
                onChange={(e) => onOriginPortChange(e.target.value)}
                placeholder="如 上海 / 天津新港"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">目的港</Label>
              <Input
                value={destPort}
                onChange={(e) => onDestPortChange(e.target.value)}
                placeholder="如 Jebel Ali / Santos"
                className="h-8 text-xs"
              />
            </div>
          </div>

          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
            {agentText}
          </pre>
        </div>

        {/* ── ② 填写货代报来的费用 ───────────────────────────────────── */}
        <div className="space-y-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-xs font-medium">② 填入货代报来的费用</h3>
              <p className="text-[11px] text-muted-foreground">
                费用项由平台固定，这里只填本单金额；已填 {filledCount} /{" "}
                {requiredFeeKeys.length}
              </p>
            </div>
            {termsTemplate && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">
                  对外报价术语
                </Label>
                <select
                  value={quoteAs}
                  onChange={(e) => onQuoteAsChange(e.target.value)}
                  className="h-7 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {termsTemplate.ladder.map((r) => (
                    <option key={r.code} value={r.code}>
                      {termOptionLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {termsLoading && <LoadingBlock rows={2} />}
          {termsFailed && (
            <p className="text-xs text-destructive">
              费用项加载失败，刷新页面重试
            </p>
          )}

          {termsTemplate && (
            <>
              {/* 每个术语档位一张小卡：只列本档**新增**的费用（阶梯逐档累加） */}
              <div className="grid gap-4 xl:grid-cols-3">
                {termsTemplate.ladder
                  .filter((r) => r.items.length > 0)
                  .map((rung) => (
                    <div
                      key={rung.code}
                      className="space-y-3 rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h4 className="text-xs font-medium">
                          {termOptionLabel(rung)}
                        </h4>
                        <p className="text-[11px] text-muted-foreground">
                          上一档基础上新增
                        </p>
                      </div>
                      <div className="space-y-3">
                        {rung.items.map((key) => {
                          const fee = termsTemplate.items[key];
                          if (!fee) return null;
                          return (
                            <div key={key} className="space-y-1.5">
                              <Label className="text-xs">
                                {fee.name}
                                {fee.unit_hint ? `（${fee.unit_hint}）` : ""}
                              </Label>
                              <Input
                                type="number"
                                step="any"
                                placeholder="填本单金额"
                                value={feeInputs[key] ?? ""}
                                onChange={(e) =>
                                  onFeeChange(key, e.target.value)
                                }
                                className="h-8 text-xs"
                              />
                              {fee.note && (
                                <p className="text-[11px] text-muted-foreground">
                                  {fee.note}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  className="min-w-[180px]"
                  disabled={busy || filledCount < requiredFeeKeys.length}
                  onClick={onRecalc}
                >
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                  {busy ? "计算中…" : `加上运费，算 ${quoteAs}`}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {filledCount < requiredFeeKeys.length
                    ? `还有 ${requiredFeeKeys.length - filledCount} 项没填 —— 未填全时只报 EXW。`
                    : "填全了，可以算对外报价。"}
                </p>
              </div>
            </>
          )}
        </div>

        {/* ── ③ 术语阶梯结果 ────────────────────────────────────────── */}
        {ladderCodes.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="text-xs font-medium">③ 术语阶梯报价</h3>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {[
                      "术语",
                      "说明",
                      `单卷价（${quoteCurrency}）`,
                      `整批总价（${quoteCurrency}）`,
                    ].map((h) => (
                      <th
                        scope="col"
                        key={h}
                        className="whitespace-nowrap px-2 py-2 text-left font-medium text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ladderCodes.map((code) => {
                    const s = ladder[code];
                    if (!s) return null;
                    // 同一笔报价只有一组规格，故区间上下限相同；这里仍按区间展示，
                    // 以便将来一次算多组规格时不用改这里。
                    const price =
                      s.min_price_fx === s.max_price_fx
                        ? String(s.min_price_fx)
                        : `${s.min_price_fx} ~ ${s.max_price_fx}`;
                    const total =
                      s.min_total === s.max_total
                        ? String(s.min_total)
                        : `${s.min_total} ~ ${s.max_total}`;
                    return (
                      <tr key={code} className="border-t">
                        <td className="px-2 py-1.5 font-medium">{code}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {s.label}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {price}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {total}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              含运费的档位才有参考意义：EXW
              与上一档的差额就是这一段运费摊到单卷的金额，
              可直接拿去和货代报价核对。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
