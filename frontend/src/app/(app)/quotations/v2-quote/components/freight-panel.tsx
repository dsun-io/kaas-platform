"use client";

/**
 * 贸易术语显示格式（原 freight-panel 的唯一存活导出）。
 *
 * 2026-10-23 U-P1D 审计 R2：这里原本还有一个 427 行的 `FreightPanel` 运费面板，
 * 全仓 **0 引用** —— 报价结果早改成引擎结果组件，那面板是历史 v2 报价页的残骸，
 * 已删除。
 *
 * ⚠️ 文件本身**没有整份删掉**：`termOptionLabel` 仍被
 * `app/(app)/quotes/views/workbench-params-card.tsx` 与
 * `quotations/v2-quote/components/__tests__/terms-option-label.test.ts` 引用，
 * 而前者属于报价工位（本轮并行任务在写），不在本批写入范围。
 * 后续把该函数移到共享展示层后即可整份删除本文件并在审计清单销账。
 */

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
