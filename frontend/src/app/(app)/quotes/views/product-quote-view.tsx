"use client";

/**
 * ⚠️ 已被 `quote-workbench-view.tsx` 取代（2026-09-27）：**不再被任何页面引用**。
 *
 * 取代理由（详见 docs/MULTI_PRODUCT_QUOTE_PLAN.md）：
 *   · 本视图一次只能算**一个产品的一组规格**，而一个询盘常常要报多种产品；
 *   · 它只试算、不落库 —— 因此无法“存成报价单”，也就无法从报价单生成整套单证。
 * 保留原因：`frontend/src/app/(app)/quotes` 在 `scripts/protected-paths.json`
 * 的保护清单里（业务功能，删除须用户明确指令）。因此保留留档，**请勿在此新增功能**。
 *
 * 产品报价视图（报价工位的核心）。
 *
 * 与旧实现的根本区别：
 *  旧：属性写死为「产品类型/丝径/高度/网孔宽度/网孔规格/卷长」这套扁平字段，
 *      提交到一个并不存在的接口 —— 属性与工厂口径不符，且点了必然失败。
 *  新：产品与属性都来自算价引擎（产品清单 + 规格空间），提交到真正的算价接口，
 *      只算用户选中的那一组规格。
 *
 * 试算**不写台账** —— 台账只在报价单签发 / 订单成交时写入（见平台升级方案 P4）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { handleApiError } from "@/lib/api/error-handler";
import { cn } from "@/lib/utils";
import type {
  ExportQuoteRequest,
  ExportQuoteResponse,
  ExportTermsTemplate,
  PieceInput,
  QuoteProfile,
  QuoteProfileTax,
} from "@contracts/export-quote";
import {
  useExportProducts,
  useExportRateSets,
  useExportTermsTemplate,
} from "../../quotations/v2-quote/hooks/use-export-quote-import";
import {
  useCalcQuote,
  useProductFormulas,
  type QuoteView,
} from "../../quotations/v2-quote/hooks/use-export-quote-calc";
import {
  SpecPicker,
  isSpecComplete,
  type SpecRow,
} from "../../quotations/v2-quote/components/spec-picker";
import { EngineQuoteResult } from "../../quotations/v2-quote/components/engine-quote-result";
import { FreightPanel } from "../../quotations/v2-quote/components/freight-panel";
import {
  useDeleteQuoteProfile,
  useQuoteProfiles,
  useSaveQuoteProfile,
} from "../../quotations/v2-quote/hooks/use-quote-profiles";

/** 上次用过的汇率，避免每次报价重复输入（仅作预填，仍需业务确认）。 */
const FX_KEY = "kaas:last-fx-rate";

/** 稳定的空数组：避免 formulas 未就绪时每次渲染都新建引用，把下游 useMemo 带崩。 */
const NO_PIECE_INPUTS: PieceInput[] = [];

/** 稳定的空数组：同上，供档案列表未就绪时用。 */
const NO_PROFILES: QuoteProfile[] = [];

/**
 * 印花税计税基数。`""` = 用法定档案里的值。
 */
type StampBase = "" | "profit" | "cost" | "base_quote";

/**
 * 报价政策的初始值。
 *
 * 为什么写成常量：**切换档案时要把表单恢复到这个状态**，初始渲染也用同一组值。
 * 两处各写一份，改一处就会不一致 —— 表现为「取消了档案，界面上还留着档案里的数字」，
 * 而这种不一致不会报错。
 *
 * 这几个值与后端默认政策等价，所以它们本身不改变任何金额。
 */
const POLICY_DEFAULTS = {
  inputVatRatePct: "10",
  giveRatioPct: "80",
  outputVatRatePct: "0",
  rebateRatePct: "",
  stampRatePct: "",
  stampBase: "" as StampBase,
};

/**
 * 加工利润的两种给法：固定金额（元/kg）或按税前成本的百分比。
 * 两者互为换算（金额 ÷ 税前成本 = 利润率），界面上同时展示、改哪个都行。
 */
type ProfitAnchor = "fixed" | "ratio";

/** 参数变多之后，靠「按计算顺序分组 + 分组标题」才读得下去。 */
function SectionTitle({
  index,
  title,
  hint,
}: {
  index: number;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t pt-4">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
        {index}
      </span>
      <h3 className="text-xs font-medium">{title}</h3>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * 一个「可按件改写」的参数输入框。
 *
 * 单件米数、卷径等全部共用这一个组件 —— 样式与提示语一致，
 * 不会因为各写一份而走样。单位换算与默认值都由调用方算好传进来。
 */
function PieceInputField({
  pi,
  value,
  defaultHint,
  onChange,
}: {
  pi: PieceInput;
  value: string;
  defaultHint: string;
  onChange: (v: string) => void;
}) {
  const unit = pi.ui_unit || pi.unit;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {pi.label}
        {unit ? `（${unit}）` : ""}
      </Label>
      <Input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        默认跟随规格（{defaultHint || "—"}）
      </p>
    </div>
  );
}

export function ProductQuoteView() {
  const products = useExportProducts();
  const rateSets = useExportRateSets();
  const termsQuery = useExportTermsTemplate();
  const calc = useCalcQuote();

  const [productKey, setProductKey] = useState("");
  const [rateSetCode, setRateSetCode] = useState("");
  const [spec, setSpec] = useState<SpecRow>({});
  // 数量区：件数**不给默认值**。给一个默认件数，用户不填就直接提交，
  // 报出来的是「他并没有确认过的数量」—— 报价单上的数量必须来自人工输入。
  const [pieces, setPieces] = useState("");
  const [pieceOverrides, setPieceOverrides] = useState<Record<string, string>>(
    {},
  );
  const [fxRate, setFxRate] = useState("");
  // 报价政策输入 —— 与「批量报价」页保持同一套，避免同一工位两个页签算出不同的价。
  // 一律按【百分比】填写（10 = 10%），提交前除以 100。
  // 默认 10 / 80 / 0 与后端默认政策等价，因此这些输入框本身【不改变任何金额】。
  const [inputVatRatePct, setInputVatRatePct] = useState(
    POLICY_DEFAULTS.inputVatRatePct,
  );
  const [giveRatioPct, setGiveRatioPct] = useState(
    POLICY_DEFAULTS.giveRatioPct,
  );
  const [outputVatRatePct, setOutputVatRatePct] = useState(
    POLICY_DEFAULTS.outputVatRatePct,
  );
  // 加工利润 —— 报价的主项，必填。没有利润的「报价」不成立。
  //  两个输入**同时展示、互为换算**：金额 ÷ 税前成本 = 利润率。
  //  profitAnchor 记住用户最后动的是哪一个，另一个由它推算 ——
  //  否则规格一换（普锌 4.4 / 高锌 5.6），两个数就会各说各话。
  const [profitFixed, setProfitFixed] = useState("0.1");
  const [profitPct, setProfitPct] = useState("10");
  const [profitAnchor, setProfitAnchor] = useState<ProfitAnchor>("fixed");
  // 出口退税率（%）。**留空 = 未核实**：引擎按「进项税额全额可回收」算并给出提示。
  // 填了才按 退税率 ÷ 进项票税点 折算 —— 可退额不再按满退处理。
  const [rebateRatePct, setRebateRatePct] = useState(
    POLICY_DEFAULTS.rebateRatePct,
  );
  // 印花税：法定值来自税务档案；这里留空 = 用档案，填了 = 本单覆盖。
  const [stampRatePct, setStampRatePct] = useState(
    POLICY_DEFAULTS.stampRatePct,
  );
  const [stampBase, setStampBase] = useState<StampBase>(
    POLICY_DEFAULTS.stampBase,
  );
  // 报价条件：币种换算、有效期与报价日期（日期决定按哪一天解析税务档案）
  const [quoteCurrency, setQuoteCurrency] = useState("USD");
  const [validityDays, setValidityDays] = useState("7");
  const [quoteDate, setQuoteDate] = useState("");
  // 贸易术语：对外报价用哪一档，以及各费用项的本单金额（key -> 用户输入串）。
  // 这两项由**结果区的运费模块**填写 —— 运费是在 EXW 之上叠加的，
  // 不是与报价参数并列的另一类输入，所以输入框不在上面这张卡里。
  const [quoteAs, setQuoteAs] = useState("");
  const [feeInputs, setFeeInputs] = useState<Record<string, string>>({});
  // 起运港/目的港：货代询价必填，放在页面级状态以免重算时被清掉
  const [originPort, setOriginPort] = useState("");
  const [destPort, setDestPort] = useState("");
  const [view, setView] = useState<QuoteView>("customer");
  const [result, setResult] = useState<ExportQuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 产品与税档列表回来前保持空选择，避免用错口径算出错价
  const effectiveProduct = productKey || products.data?.products[0]?.key || "";
  const effectiveRateSet =
    rateSetCode || rateSets.data?.rate_sets[0]?.code || "";

  const formulas = useProductFormulas(effectiveProduct || null);

  // 换产品 → 规格空间变了 → 回到「未选择」状态。
  // 不预置第一组取值：预置会让人不填就报价，而规格是成本/重量/体积的输入，
  // 多一个默认值就多一份「没确认过的报价」。
  useEffect(() => {
    if (formulas.data) setSpec({});
  }, [formulas.data]);

  // 换产品/换规格 → 按件参数回到「跟随规格」状态，
  // 否则会把上一个规格的卷长/卷径带过去（静默算错重量与体积）。
  useEffect(() => {
    setPieceOverrides({});
  }, [formulas.data, spec]);

  const pieceInputs = formulas.data?.piece_inputs ?? NO_PIECE_INPUTS;

  /** 取某个按件参数在**当前规格**下的默认值（从所属变体组选中项的属性里读）。 */
  const pieceDefault = (variant: string, key: string): string => {
    const groups = [
      ...(formulas.data?.space.axes ?? []),
      ...(formulas.data?.space.variants ?? []),
    ];
    const group = groups.find((g) => g.name === variant);
    if (!group) return "";
    const selected = spec[variant];
    const opt = group.options.find((o) => String(o.value) === String(selected));
    const raw = opt?.attributes?.[key];
    return raw === undefined || raw === null ? "" : String(raw);
  };

  /** 界面单位 ÷ 引擎单位的倍数（米 → 公分 = 100）。界面只换算，不懂业务单位。 */
  const pieceScale = (pi: PieceInput): number =>
    pi.ui_scale && pi.ui_scale > 0 ? pi.ui_scale : 1;

  /** 消除浮点噪声（0.3 × 100 会得到 30.000000000000004）。 */
  const scale6 = (n: number): number => Math.round(n * 1e6) / 1e6;

  // ── 客户税率档案 ─────────────────────────────────────────────────────────
  //
  // 它和上面的「税务档案」是同一个下拉里的两层：
  //   法定档案（rate_sets）= 国家政策，平台维护，很少变；
  //   客户档案（本段）= 这个客户自己填的那套税率，按「客户 + 产品」存，可多份。
  //
  // 套用档案做的事就是**把下面这些输入框填好**，与人工手敲一遍完全等价。
  // 引擎收到的仍然是「rate_set_code + policy 覆盖」，一行都不用改 ——
  // 所以「用档案算出来的价」和「手填算出来的价」不可能分叉。
  const profilesQuery = useQuoteProfiles(effectiveProduct || null);
  const saveProfile = useSaveQuoteProfile(effectiveProduct);
  const deleteProfile = useDeleteQuoteProfile(effectiveProduct);
  const profiles = profilesQuery.data?.profiles ?? NO_PROFILES;

  /**
   * 下拉选中的是哪一项：`rate:<code>` 法定档案 / `profile:<id>` 客户档案 / `\"\"` 未指定。
   * 未指定时后端按报价日取当期生效的一份，也就是本页原来的行为。
   */
  const [taxPick, setTaxPick] = useState("");
  const [savingOpen, setSavingOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  /** 百分比输入 → 档案里的比例值（10 → 0.1）。留空 = 不覆盖，用法定值。 */
  const pctToRate = (text: string): number | undefined =>
    text === "" ? undefined : (Number(text) || 0) / 100;
  /** 档案里的比例值 → 百分比输入（0.1 → 10）。 */
  const rateToPct = (rate: number | undefined, fallback: string): string =>
    rate === undefined ? fallback : String(scale6(rate * 100));

  /**
   * 把一份档案套到表单上。
   *
   * 两个关键点：
   *  1. **法定档案也跟着切**。档案存在同一个下拉里，只套税率不切法定档案的话，
   *     「客户档案 + 另一份法定档案」会算出一个谁都没确认过的组合，而金额看着很正常。
   *  2. 档案里**没存的项回到默认值**，而不是留着上一份档案的数字。
   *     否则换了一份档案之后，界面上还混着上一份的值，且没有任何提示。
   */
  const applyProfile = (p: QuoteProfile) => {
    const t = p.tax_overrides ?? {};
    setRateSetCode(p.rate_set_code);
    setInputVatRatePct(
      rateToPct(t.input_vat_rate, POLICY_DEFAULTS.inputVatRatePct),
    );
    setOutputVatRatePct(
      rateToPct(t.output_vat_rate, POLICY_DEFAULTS.outputVatRatePct),
    );
    setRebateRatePct(rateToPct(t.rebate_rate, POLICY_DEFAULTS.rebateRatePct));
    setStampRatePct(rateToPct(t.stamp_rate, POLICY_DEFAULTS.stampRatePct));
    setStampBase(t.stamp_base ?? POLICY_DEFAULTS.stampBase);
  };

  /** 回到「不套用任何客户档案」的状态（法定档案的选择不动）。 */
  const clearProfileTax = () => {
    setInputVatRatePct(POLICY_DEFAULTS.inputVatRatePct);
    setOutputVatRatePct(POLICY_DEFAULTS.outputVatRatePct);
    setRebateRatePct(POLICY_DEFAULTS.rebateRatePct);
    setStampRatePct(POLICY_DEFAULTS.stampRatePct);
    setStampBase(POLICY_DEFAULTS.stampBase);
  };

  // 默认选中「最新创建的一份」。
  //
  // 只在「还没为这个产品选过」时套用一次：列表每次刷新都重新套用的话，
  // 用户手改的税率会被无声地覆盖回去 —— 那就成了「我改了，它自己变回去」。
  const autoPickedRef = useRef<string>("");
  useEffect(() => {
    if (!effectiveProduct || !profilesQuery.isSuccess) return;
    if (autoPickedRef.current === effectiveProduct) return;
    autoPickedRef.current = effectiveProduct;
    const newest = profiles[0];
    if (!newest) return;
    setTaxPick(`profile:${newest.id}`);
    applyProfile(newest);
    setProfileNotice(`已套用档案「${newest.profile_name}」`);
    // applyProfile 每次渲染都是新引用，但上面的 ref 门栓保证只执行一次，
    // 所以这里不会形成循环。
  }, [effectiveProduct, profilesQuery.isSuccess, profiles, applyProfile]);

  /** 当前填的税率 —— 存档案时提交的就是它。只含税率类，不含利润与让利比例。 */
  const profileTax = useMemo<QuoteProfileTax>(() => {
    const t: QuoteProfileTax = {};
    const iv = pctToRate(inputVatRatePct);
    const ov = pctToRate(outputVatRatePct);
    const rb = pctToRate(rebateRatePct);
    const st = pctToRate(stampRatePct);
    if (iv !== undefined) t.input_vat_rate = iv;
    if (ov !== undefined) t.output_vat_rate = ov;
    if (rb !== undefined) t.rebate_rate = rb;
    if (st !== undefined) t.stamp_rate = st;
    if (stampBase) t.stamp_base = stampBase;
    return t;
  }, [
    inputVatRatePct,
    outputVatRatePct,
    rebateRatePct,
    stampRatePct,
    stampBase,
  ]);

  const onSaveProfile = async () => {
    setProfileNotice(null);
    try {
      const created = await saveProfile.mutateAsync({
        product_key: effectiveProduct,
        profile_name: profileName.trim(),
        rate_set_code: effectiveRateSet,
        tax_overrides: profileTax,
      });
      setSavingOpen(false);
      setProfileName("");
      setTaxPick(`profile:${created.id}`);
      setProfileNotice(
        `已保存档案「${created.profile_name}」，下次打开报价页会自动套用它。`,
      );
    } catch (err) {
      setProfileNotice(
        handleApiError(err as Parameters<typeof handleApiError>[0]),
      );
    }
  };

  const onDeleteProfile = async (p: QuoteProfile) => {
    setProfileNotice(null);
    try {
      await deleteProfile.mutateAsync(p.id);
      setTaxPick("");
      clearProfileTax();
      setProfileNotice(`已移除档案「${p.profile_name}」（历史报价不受影响）。`);
    } catch (err) {
      setProfileNotice(
        handleApiError(err as Parameters<typeof handleApiError>[0]),
      );
    }
  };

  const pickedProfile =
    profiles.find((p) => `profile:${p.id}` === taxPick) ?? null;

  /** 规格默认值（引擎单位）。 */
  const pieceDefaultBase = (pi: PieceInput): string =>
    pieceDefault(pi.variant, pi.key);

  /** 规格默认值换算到界面单位的展示串（给「默认跟随规格」提示用）。 */
  const pieceDefaultDisplay = (pi: PieceInput): string => {
    const d = pieceDefaultBase(pi);
    if (!d) return "";
    const n = Number(d);
    return Number.isFinite(n) ? String(scale6(n * pieceScale(pi))) : d;
  };

  /** 界面显示值：用户填的本来就是界面单位；没填则把规格默认值换算过来。 */
  const pieceDisplay = (pi: PieceInput): string => {
    const typed = pieceOverrides[pi.key];
    if (typed !== undefined && typed !== "") return typed;
    return pieceDefaultDisplay(pi);
  };

  /** 回写成变体覆盖时用的**引擎值**（界面值 ÷ 倍数）。没填过 → null（不覆盖）。 */
  const pieceOverrideBase = (pi: PieceInput): number | null => {
    const typed = pieceOverrides[pi.key];
    if (typed === undefined || typed === "") return null;
    const n = Number(typed);
    return Number.isFinite(n) ? n / pieceScale(pi) : null;
  };

  /** 每件的数量（单件米数）—— 由产品声明里 unit_quantity 标记的那一项决定，不靠顺序猜。 */
  const unitQtyInput = pieceInputs.find((pi) => pi.unit_quantity);
  const unitQtyDefault = unitQtyInput
    ? Number(pieceDefaultBase(unitQtyInput)) || 0
    : 0;
  const unitQty = unitQtyInput
    ? (pieceOverrideBase(unitQtyInput) ?? unitQtyDefault)
    : 0;
  /** 总数 = 单件数量 × 件数。系统算，只读。 */
  const total = (unitQty || 0) * (Number(pieces) || 0);

  /** 在当前规格下读某个属性的值（从各变体组选中项里找，如成本字段 raw_price）。 */
  const specAttr = (key: string): string => {
    if (!key) return "";
    const groups = [
      ...(formulas.data?.space.axes ?? []),
      ...(formulas.data?.space.variants ?? []),
    ];
    for (const g of groups) {
      const opt = g.options.find(
        (o) => String(o.value) === String(spec[g.name]),
      );
      const raw = opt?.attributes?.[key];
      if (raw !== undefined && raw !== null && String(raw) !== "")
        return String(raw);
    }
    return "";
  };

  /** 税前成本（元/kg）—— 与引擎同源：取产品声明的 cost.field 那个属性。 */
  const costFieldKey = formulas.data?.cost?.field ?? "";
  const costPretax = Number(specAttr(costFieldKey)) || 0;

  /** 保留 4 位，避免双向换算抖动（0.1 ÷ 4.4 会得到一长串小数）。 */
  const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

  /** 改金额 → 反算利润率。 */
  const editProfitFixed = (v: string) => {
    setProfitAnchor("fixed");
    setProfitFixed(v);
    const n = Number(v);
    if (costPretax > 0 && Number.isFinite(n)) {
      setProfitPct(String(round4((n / costPretax) * 100)));
    }
  };

  /** 改利润率 → 反算金额。 */
  const editProfitPct = (v: string) => {
    setProfitAnchor("ratio");
    setProfitPct(v);
    const n = Number(v);
    if (costPretax > 0 && Number.isFinite(n)) {
      setProfitFixed(String(round4((costPretax * n) / 100)));
    }
  };

  /** 当前规格的可读描述：给货代询价时用来说明「这是什么货」。 */
  const specSummary = useMemo(() => {
    if (!formulas.data) return "";
    const groups = [
      ...(formulas.data.space.axes ?? []),
      ...(formulas.data.space.variants ?? []),
    ];
    return groups
      .map((g) => {
        const v = spec[g.name];
        return v === undefined || v === "" ? "" : `${g.label || g.name}: ${v}`;
      })
      .filter(Boolean)
      .join("　");
  }, [formulas.data, spec]);

  // 税前成本随规格变化（普锌 4.4 / 高锌 5.6）→ 按用户最后动的那一侧重算另一侧。
  // 依赖里只放成本：把两个利润值也放进来会自己触发自己，来回算。
  useEffect(() => {
    if (costPretax <= 0) return;
    if (profitAnchor === "fixed") {
      const n = Number(profitFixed);
      if (Number.isFinite(n))
        setProfitPct(String(round4((n / costPretax) * 100)));
    } else {
      const n = Number(profitPct);
      if (Number.isFinite(n))
        setProfitFixed(String(round4((costPretax * n) / 100)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costPretax]);

  // ── 运费与附加费（贸易术语阶梯）────────────────────────────────────
  // 结构与口径由平台声明（termsQuery），这里只负责填金额并回传。
  const termsTemplate: ExportTermsTemplate | undefined = termsQuery.data;
  /** 对外报价术语：默认取平台的建议值（现为 CIF） */
  const effectiveQuoteAs = quoteAs || termsTemplate?.quote_as || "CIF";

  /**
   * 要算到「对外报价术语」这一档，必须填全它之前（含它）的所有费用项。
   * 阶梯是逐档累加的，所以档位越靠后，必填项越多 —— 这也是为什么
   * 只报 CFR 时不必填保险费。
   */
  const requiredFeeKeys = useMemo(() => {
    if (!termsTemplate) return [] as string[];
    const keys: string[] = [];
    for (const rung of termsTemplate.ladder) {
      for (const k of rung.items) if (!keys.includes(k)) keys.push(k);
      if (rung.code === effectiveQuoteAs) break;
    }
    return keys;
  }, [termsTemplate, effectiveQuoteAs]);

  const feeNumberOf = (key: string): number | null => {
    const v = feeInputs[key];
    if (v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /** 填全了才发 terms —— 有空白项时引擎会直接报错，不会静默按 0 算。 */
  const termsReady =
    !!termsTemplate &&
    requiredFeeKeys.length > 0 &&
    requiredFeeKeys.every((k) => {
      const n = feeNumberOf(k);
      return n !== null && n > 0;
    });

  /** 回传的形状就是模板的形状（只把 value 填成数字），界面不做结构转换。 */
  const builtTerms = useMemo(() => {
    if (!termsTemplate || !termsReady) return undefined;
    const items: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(termsTemplate.items)) {
      items[k] = { ...f, value: feeNumberOf(k) ?? 0 };
    }
    return {
      base: termsTemplate.base,
      quote_as: effectiveQuoteAs,
      weight_field: termsTemplate.weight_field,
      items,
      ladder: termsTemplate.ladder,
    };
    // feeNumberOf 只是读 feeInputs 的纯函数，故依赖列到 feeInputs 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termsTemplate, termsReady, feeInputs, effectiveQuoteAs]);

  /** 用户改过的按件参数 → 变体覆盖 {组: {选项名: {属性: 值}}}。
   *  只覆盖「真的改了」的那些，没改的保持产品定义里的默认值。 */
  const variantOverrides = useMemo(() => {
    const out: Record<string, Record<string, Record<string, number>>> = {};
    for (const pi of pieceInputs) {
      // 界面值 → 引擎值：单位倍数在这里消掉，引擎只认自己的单位。
      const n = pieceOverrideBase(pi);
      if (n === null || !pi.variant) continue;
      const optionName = String(spec[pi.variant] ?? "");
      if (!optionName) continue;
      const group = (out[pi.variant] = out[pi.variant] ?? {});
      group[optionName] = { ...(group[optionName] ?? {}), [pi.key]: n };
    }
    return out;
  }, [pieceInputs, pieceOverrides, spec]);

  useEffect(() => {
    const saved = window.localStorage.getItem(FX_KEY);
    if (saved) setFxRate(saved);
  }, []);

  const specReady = formulas.data ? isSpecComplete(formulas.data, spec) : false;
  // 利润必填：0 也拦住 —— 否则「忘了填」会静默出一张不含利润的价。
  const profitReady =
    profitAnchor === "ratio" ? Number(profitPct) > 0 : Number(profitFixed) > 0;
  const canSubmit =
    !!effectiveProduct &&
    specReady &&
    Number(fxRate) > 0 &&
    total > 0 &&
    profitReady;

  const payload = useMemo<ExportQuoteRequest>(
    () => ({
      product_key: effectiveProduct,
      rate_set_code: effectiveRateSet || undefined,
      fx_rate: Number(fxRate) || 0,
      // 汇率由报价人按报价当日填写（后续可改为系统维护当期汇率、自动带入）
      fx_source: "manual",
      orders: [{ total, unit: unitQtyInput?.unit || "m" }],
      spec_rows: [spec],
      // 按件改写的规格参数（卷长/卷径等）回写成变体覆盖
      variant_overrides: variantOverrides,
      with_verification: false,
      currency: "CNY",
      quote_currency: quoteCurrency,
      validity_days: Number(validityDays) || 7,
      // 报价日期决定按哪一天解析税务档案（政策换档后补历史单子要用它）；留空 = 今天
      quote_date: quoteDate || undefined,
      // 贸易术语：填全费用项才发。不发则只算 EXW（保持原有行为不变）。
      terms: builtTerms,
      // 政策覆盖项：**留空即取税务档案的法定值**，填了才覆盖（本单专用）。
      // 这样国家调税率只需新增一份档案，前端不动、代码不动。
      policy: {
        input_vat_rate: (Number(inputVatRatePct) || 0) / 100,
        give_ratio: (Number(giveRatioPct) || 0) / 100,
        // 销项税按业务实际填（出口 0、内销 13…）。
        // 刻意不做「选出口就自动 0」这类推导 —— 政策会变，写死的规则三年后就是错的。
        output_vat_rate: (Number(outputVatRatePct) || 0) / 100,
        // 出口退税率：**只在填了的时候下发**。留空时引擎按「未核实」处理并给提示，
        // 不能被一个默认 0 覆盖 —— 0 与「没填」是两件事：0 会把可退额直接压成 0。
        ...(rebateRatePct !== ""
          ? { rebate_rate: (Number(rebateRatePct) || 0) / 100 }
          : {}),
        // 印花税同理：留空 = 用档案里的法定值，填了 = 本单覆盖
        ...(stampRatePct !== ""
          ? { stamp_rate: (Number(stampRatePct) || 0) / 100 }
          : {}),
        ...(stampBase ? { stamp_base: stampBase } : {}),
        // 加工利润：按用户最后动的那一侧提交（fixed 给金额，ratio 给比例），
        // 避免拿换算后的近似值二次数整。
        profit_mode: profitAnchor,
        profit_value:
          profitAnchor === "ratio"
            ? (Number(profitPct) || 0) / 100
            : Number(profitFixed) || 0,
      },
    }),
    [
      effectiveProduct,
      effectiveRateSet,
      fxRate,
      total,
      unitQtyInput,
      variantOverrides,
      spec,
      inputVatRatePct,
      giveRatioPct,
      outputVatRatePct,
      profitAnchor,
      profitFixed,
      profitPct,
      rebateRatePct,
      stampRatePct,
      stampBase,
      quoteCurrency,
      validityDays,
      quoteDate,
      builtTerms,
    ],
  );

  const reset = () => {
    setResult(null);
    setError(null);
    if (formulas.data) setSpec({});
  };

  const submit = async () => {
    setResult(null);
    setError(null);
    try {
      const data = await calc.mutateAsync({ payload, view });
      setResult(data);
      window.localStorage.setItem(FX_KEY, fxRate);
    } catch (err: unknown) {
      if (err instanceof Error && "response" in err) {
        setError(handleApiError(err as Parameters<typeof handleApiError>[0]));
      } else {
        setError(err instanceof Error ? err.message : "未知错误，请稍后重试");
      }
    }
  };

  return (
    <div className="space-y-5">
      {/* 参数区横向铺开：产品/税档 一行 → 规格 一行 → 数量汇率 一行。
          不再挤在一个窄列里（那样会拉成一条），结果表有 20+ 列，须独占整宽。 */}
      <Card className="overflow-visible">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">报价参数</CardTitle>
              <CardDescription>
                {formulas.data
                  ? `共 ${formulas.data.space.combo_count} 种规格 · 标「联动」的属性一次选定后自动确定其他参数`
                  : "选择产品与规格后算价"}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs text-muted-foreground"
              onClick={reset}
            >
              <RotateCcw className="mr-1 size-3" />
              清空
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 产品 + 税务档案 */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">产品</Label>
              <select
                value={effectiveProduct}
                onChange={(e) => {
                  setProductKey(e.target.value);
                  setResult(null);
                  setError(null);
                }}
                disabled={products.isLoading}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(products.data?.products ?? []).length === 0 && (
                  <option value="">
                    {products.isLoading ? "加载中…" : "暂无可报价产品"}
                  </option>
                )}
                {(products.data?.products ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {(rateSets.data?.rate_sets ?? []).length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">税务档案</Label>
                {/* 一个下拉装两层：上面的「客户税率档案」是给这个客户存的那套税率，
                    下面的「法定税务档案」是国家政策。选中客户档案时法定档案会跟着切过去
                    —— 两层是配套使用的，分开选会拼出没人确认过的组合。 */}
                <select
                  value={taxPick}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTaxPick(v);
                    setProfileNotice(null);
                    if (v.startsWith("profile:")) {
                      const p = profiles.find((x) => `profile:${x.id}` === v);
                      if (p) applyProfile(p);
                      return;
                    }
                    // 切回法定档案 = 不再套用客户档案 → 税率项回到默认。
                    // 不这么做的话，用户以为「取消套用了」，实际还在用档案里的数字。
                    setRateSetCode(
                      v.startsWith("rate:") ? v.slice("rate:".length) : "",
                    );
                    clearProfileTax();
                  }}
                  className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">（未指定，按报价当期生效的一份）</option>
                  {profiles.length > 0 && (
                    <optgroup label="客户税率档案">
                      {profiles.map((p) => (
                        <option
                          key={`profile:${p.id}`}
                          value={`profile:${p.id}`}
                        >
                          {p.profile_name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="法定税务档案">
                    {(rateSets.data?.rate_sets ?? []).map((r) => (
                      <option key={`rate:${r.code}`} value={`rate:${r.code}`}>
                        {r.name || r.code}
                      </option>
                    ))}
                  </optgroup>
                </select>

                {/* 存为档案 / 移除档案。只保存**税率类**参数（利润与让利比例不存）——
                    利润是每单的商业决策，被档案悄悄带回来会报出没确认过的价。 */}
                {savingOpen ? (
                  <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2">
                    <Input
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder="给这份档案起个名字"
                      className="h-8 text-xs"
                      maxLength={60}
                    />
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={
                          !profileName.trim() ||
                          saveProfile.isPending ||
                          !effectiveRateSet
                        }
                        onClick={onSaveProfile}
                      >
                        {saveProfile.isPending && (
                          <Loader2 className="mr-1 size-3 animate-spin" />
                        )}
                        保存
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => {
                          setSavingOpen(false);
                          setProfileName("");
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      onClick={() => {
                        setSavingOpen(true);
                        setProfileName(pickedProfile?.profile_name ?? "");
                        setProfileNotice(null);
                      }}
                    >
                      <Save className="size-3" />
                      存为档案
                    </Button>
                    {pickedProfile && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-xs text-muted-foreground"
                        disabled={deleteProfile.isPending}
                        onClick={() => onDeleteProfile(pickedProfile)}
                      >
                        <Trash2 className="size-3" />
                        移除
                      </Button>
                    )}
                  </div>
                )}

                {profileNotice && (
                  <p className="text-[11px] text-muted-foreground">
                    {profileNotice}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 规格属性 —— 由引擎的规格空间驱动，横向铺开 */}
          <SectionTitle
            index={1}
            title="规格"
            hint="取值同时决定成本、重量与体积"
          />
          <div className="space-y-3">
            {formulas.isLoading && (
              <p className="text-xs text-muted-foreground">规格加载中…</p>
            )}
            {formulas.data && (
              <SpecPicker
                formulas={formulas.data}
                value={spec}
                onChange={setSpec}
                disabled={calc.isPending}
              />
            )}
            {formulas.isError && (
              <p className="text-xs text-destructive">
                规格加载失败，请刷新重试
              </p>
            )}
          </div>

          {/* ② 数量 —— 单件参数与件数相邻，总数紧跟其后 */}
          <SectionTitle
            index={2}
            title="数量"
            hint="总数 = 单件数量 × 件数，由系统计算，不可手改"
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {/* 按件参数（单件米数、卷径…）按产品定义里的顺序铺开，不另外分区 —— */}
            {/* 卷径紧跟单件米数，两者是同一件物理规格的两个面，读起来才连得上。 */}
            {pieceInputs.map((pi) => (
              <PieceInputField
                key={pi.key}
                pi={pi}
                value={pieceDisplay(pi)}
                defaultHint={pieceDefaultDisplay(pi)}
                onChange={(v) =>
                  setPieceOverrides((prev) => ({ ...prev, [pi.key]: v }))
                }
              />
            ))}

            <div className="space-y-1.5">
              <Label className="text-xs">件数</Label>
              <Input
                type="number"
                min={1}
                value={pieces}
                onChange={(e) => setPieces(e.target.value)}
                placeholder="请填写订单件数"
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                总数（{unitQtyInput?.unit || "m"}）
              </Label>
              {/* 只读：总数 = 单件数量 × 件数。允许手改会与件数自相矛盾。 */}
              <Input
                type="number"
                value={Number.isFinite(total) ? total : 0}
                readOnly
                className="h-8 text-xs bg-muted"
              />
              <p className="text-[11px] text-muted-foreground">
                系统计算，不可更改
              </p>
            </div>
          </div>

          {/* ③ 成本与利润 —— 价链的第一段；成本来自定价数据，随规格变 */}
          <SectionTitle
            index={3}
            title="成本与利润"
            hint={`税前成本取自定价数据${costFieldKey ? `（${costFieldKey}）` : ""}，随规格自动带入`}
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">税前成本（元/kg）</Label>
              {/* 只读：要改成本请去「定价数据」按定价键改，而不是在这里写死 */}
              <Input
                type="number"
                value={costPretax || ""}
                readOnly
                className="h-8 text-xs bg-muted"
              />
              <p className="text-[11px] text-muted-foreground">
                随规格自动带入
              </p>
            </div>

            {/* 金额与利润率是一对，互为换算，必须相邻同排 */}
            <div className="space-y-1.5">
              <Label className="text-xs">加工利润（元/kg）</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="如 0.1"
                value={profitFixed}
                onChange={(e) => editProfitFixed(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                每公斤的加工所得，全单只计一次
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">利润率（%）</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="如 2.2727"
                value={profitPct}
                onChange={(e) => editProfitPct(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                按税前成本计：利润率 = 加工利润 ÷ 税前成本
              </p>
            </div>
          </div>

          {/* ④ 税与让利 —— 严格按价链顺序：进项税 → 退税让利 → 印花税 → 销项税 */}
          <SectionTitle
            index={4}
            title="税与让利"
            hint="留空的项自动取税务档案里的法定值；填了则本单覆盖"
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">进项票税点（%）</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="供应商开票收的点，如 10"
                value={inputVatRatePct}
                onChange={(e) => setInputVatRatePct(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                决定含税采购价与可退税额
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">出口退税率（%）</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="按 HS 编码核实，如 13"
                value={rebateRatePct}
                onChange={(e) => setRebateRatePct(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                {rebateRatePct === ""
                  ? "⚠ 未填：按进项税额全额可退估算，报价可能偏低"
                  : `可退比例 = ${rebateRatePct}% ÷ 进项票税点`}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">让利比例（%）</Label>
              <Input
                type="number"
                step="1"
                placeholder="退回的税让给客户多少，如 80"
                value={giveRatioPct}
                onChange={(e) => setGiveRatioPct(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                让出可退税额的比例，自留部分作风险对冲
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">印花税率（%）</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="留空用档案法定值（现为 5）"
                value={stampRatePct}
                onChange={(e) => setStampRatePct(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                留空即取税务档案的法定值
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">印花税计税基数</Label>
              <select
                value={stampBase}
                onChange={(e) =>
                  setStampBase(
                    e.target.value as "" | "profit" | "cost" | "base_quote",
                  )
                }
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">跟随档案（现为加工利润）</option>
                <option value="profit">加工利润</option>
                <option value="cost">税前成本</option>
                <option value="base_quote">基础报价</option>
              </select>
              <p className="text-[11px] text-muted-foreground">
                印花税 = 计税基数 × 印花税率
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">销项税率（%）</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="出口填 0、内销填 13"
                value={outputVatRatePct}
                onChange={(e) => setOutputVatRatePct(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                按业务实际填，不按出口/内销自动推导
              </p>
            </div>
          </div>

          {/* ⑤ 汇率与报价条件 —— 折算外币价与报价有效期，是价链的最后一步 */}
          <SectionTitle
            index={5}
            title="汇率与报价条件"
            hint="报价币种决定「单价」用什么币种展示；日期决定按哪一天的汇率/税务档案算"
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">报价币种</Label>
              <select
                value={quoteCurrency}
                onChange={(e) => setQuoteCurrency(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                选什么，报价单位就是什么
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                汇率（1 {payload.currency ?? "CNY"} = ? {quoteCurrency}）
              </Label>
              <Input
                type="number"
                step="0.0001"
                placeholder="按报价当日汇率填写"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                换币种请同步换汇率，否则外币价就是错的
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">报价日期</Label>
              <Input
                type="date"
                value={quoteDate}
                onChange={(e) => setQuoteDate(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                留空 = 今天；补历史单子请填原日期
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">报价有效期（天）</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={validityDays}
                onChange={(e) => setValidityDays(e.target.value)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">默认 7 天</p>
            </div>
          </div>

          {/* 结果视图 + 提交 */}
          <div className="flex flex-wrap items-end justify-between gap-4 border-t pt-4">
            <div className="space-y-1.5">
              <Label className="text-xs">结果视图</Label>
              <div className="flex gap-2">
                {(
                  [
                    ["customer", "客户视图"],
                    ["internal", "内部核算"],
                  ] as [QuoteView, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setView(k);
                      setResult(null);
                      setError(null);
                    }}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs transition-colors",
                      view === k
                        ? "border-primary bg-primary/10 font-medium text-foreground"
                        : "border-input text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                客户视图不含成本、利润与税额；内部核算需要管理员权限
              </p>
            </div>

            <div className="flex flex-col items-end gap-1.5">
              <Button
                type="button"
                className="min-w-[148px]"
                disabled={!canSubmit || calc.isPending}
                onClick={submit}
              >
                {calc.isPending && (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                )}
                {calc.isPending ? "报价计算中…" : "获取报价"}
              </Button>
              {!canSubmit && !calc.isPending && (
                <p className="text-[11px] text-muted-foreground">
                  请先选择完整规格，并填写数量、汇率与利润
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 结果：独占整宽（表格列多，需要宽度） */}
      <div className="space-y-4">
        {error && (
          <Card>
            <CardContent className="py-6">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}
        {result && <EngineQuoteResult result={result} view={view} />}
        {/* 运费是 EXW 之上的后续环节：先有出厂价，再向货代询价、叠加运费 → FOB/CFR/CIF */}
        {result && (
          <FreightPanel
            result={result}
            view={view}
            termsTemplate={termsTemplate}
            termsLoading={termsQuery.isLoading}
            termsFailed={termsQuery.isError}
            quoteAs={effectiveQuoteAs}
            onQuoteAsChange={setQuoteAs}
            feeInputs={feeInputs}
            onFeeChange={(key, v) =>
              setFeeInputs((prev) => ({ ...prev, [key]: v }))
            }
            requiredFeeKeys={requiredFeeKeys}
            onRecalc={submit}
            busy={calc.isPending}
            productName={formulas.data?.name ?? ""}
            productNameEn={formulas.data?.name_en ?? ""}
            hsCodes={formulas.data?.hs_codes ?? []}
            specSummary={specSummary}
            pieces={pieces}
            unitLabel={unitQtyInput?.unit || "卷"}
            quoteCurrency={quoteCurrency}
            originPort={originPort}
            onOriginPortChange={setOriginPort}
            destPort={destPort}
            onDestPortChange={setDestPort}
          />
        )}
        {!result && !error && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-muted-foreground">
                选择产品与规格、填写数量与汇率，点击「获取报价」查看结果
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
