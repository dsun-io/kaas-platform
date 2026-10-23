/**
 * 贸易术语显示格式（U-P1D 从 `quotations/v2-quote/components/freight-panel.tsx` 平移）。
 *
 * 原 freight-panel 的 427 行运费面板早已 0 引用并删除；只剩这个纯函数：
 * 报价参数卡（quotes/views/workbench-params-card）与单测共用同一份显示口径。
 *
 * 为什么放在 quotes/lib：它是**纯展示函数**（不依赖 React / 请求），
 * 与 terms-amortize / line-to-item 同级，避免再挂在一条已废弃的目录下。
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
