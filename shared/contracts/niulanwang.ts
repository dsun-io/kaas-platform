/**
 * 牛栏网规格空间与体积口径 —— 前端侧的唯一参照
 *
 * 为什么有这个文件
 * ----------------
 * 平台里牛栏网的产品知识散落在几处，历史上出现过互相矛盾的值：
 *   · `PricingDataForm` 把牛栏网类型写成「上疏下密 / 环扣」
 *   · mock 数据用 `2.0x1.8`、高度 `1.8`、卷长 `50` 这类**产品里不存在**的取值
 *   · 旧扁平模型（v2 报价流程）与新规格体系（spec-config 向导）各有一套字段
 *
 * 为了不再各写各的，这里把**已核对过的牛栏网规格空间与计算口径**集中声明一次。
 *
 * 权威性说明（重要）
 * ------------------
 * **运行时的权威来源仍是后端**：
 *   · `GET /api/v1/export-quote/products/field_fence/formulas` —— 规格轴、公式、口径
 *   · `POST /api/v1/export-quote/products/field_fence/explain` —— 按规格逐步代入自证
 *   · `spec_attributes` / `category_attribute_bindings` —— 属性与绑定
 *
 * 本文件里的取值是**与后端对齐的静态镜像**，供前端做校验、联动与 mock，
 * 免得各处再手写一遍而写歪。改动规格时必须同步改后端产品定义
 * （`app/services/export_quote/products/field_fence.py`）与 DB 迁移，
 * 并由 `niulanwang.test.ts` 里的算术断言兜住（5 轴 × 取值 = 48 组合）。
 */
import { z } from 'zod';

/** 会真正决定 SKU 的规格轴（5 个 → 3×2×2×2×2 = 48 个组合）。 */
export const NIULANWANG_SKU_AXES = {
  /** 丝径方案：一次选定，边丝/内横丝/竖丝三个直径与卷长、卷径同时确定 */
  wire_option: {
    label: '丝径方案',
    options: [
      {
        value: 'all_wire_20',
        label: '全丝2.0',
        edgeWireMm: 2.0,
        innerWireMm: 2.0,
        verticalWireMm: 2.0,
        rollLengthM: 100,
        rollDiameterCm: 30,
      },
      {
        value: 'all_wire_25',
        label: '全丝2.5',
        edgeWireMm: 2.5,
        innerWireMm: 2.5,
        verticalWireMm: 2.5,
        rollLengthM: 50,
        rollDiameterCm: 25,
      },
      {
        value: 'edge25_inner20',
        label: '边丝2.5+内丝2.0',
        edgeWireMm: 2.5,
        innerWireMm: 2.0,
        verticalWireMm: 2.0,
        rollLengthM: 100,
        rollDiameterCm: 30,
      },
    ],
  },
  /** 网高（米） */
  height: {
    label: '网高',
    options: [
      { value: 1.2, label: '1.2m' },
      { value: 1.5, label: '1.5m' },
    ],
  },
  /** 竖丝间距（cm）—— 即网孔竖丝间距；横向间距上疏下密，不参与重量与计价 */
  vertical_wire_spacing: {
    label: '竖丝间距',
    options: [
      { value: 10, label: '10cm' },
      { value: 15, label: '15cm' },
    ],
  },
  /** 镀锌量 */
  zinc_coating: {
    label: '镀锌量',
    options: [
      { value: 'zinc_40', label: '普锌40g/㎡', zincGm2: 40 },
      { value: 'zinc_200', label: '重镀锌≥200g/㎡', zincGm2: 200 },
    ],
  },
  /** 工艺：波弯款按每 100 米增重 3kg 折算 */
  wave_type: {
    label: '工艺',
    options: [
      { value: 'no_wave', label: '无波款', waveFactor: 0 },
      { value: 'wave_bend', label: '波弯款', waveFactor: 1 },
    ],
  },
} as const;

export const NIULANWANG_COMBO_COUNT = 48;

/** 记录在案但不参与 SKU 编码的量（由上面的轴决定，或按品种固定）。 */
export const NIULANWANG_DESCRIPTIVE = {
  product_form: 'ningbian_shangshuxiami',
  surface_finish: 'hot_dip_galv',
  packing: 'no_packing',
  horizontal_wire_count: 10,
} as const;

/**
 * 波弯增重：按每 100 米增重 3kg 折算。
 * 100 米卷 +3kg，50 米卷只 +1.5kg —— 卷长不同，增重不同。
 */
export const WAVE_ADD_KG_PER_100M = 3;

/**
 * 体积口径（两个，不要混用）
 * --------------------------
 * perRollCylinder：单卷净体积按**实际圆柱体** = π/4 × 卷径² × 网高。
 * perRollBox     ：单卷长方体体积按**外接方柱** = 卷径² × 网高，用于堆码与报运价。
 *
 * 对外报运价/报关用「实际占用体积」，它基于**长方体**口径扣减，
 * 而不是圆柱体 —— 圆柱体只是钢材本身占用的体积。
 */
export const NIULANWANG_VOLUME_MODEL = {
  perRollCylinderFormula: 'pi / 4 * 卷径² * 网高',
  perRollBoxFormula: '卷径² * 网高',
  orderTotalFormula: '单卷长方体体积 * 卷数',
  deduction: {
    mode: 'median',
    range: [2, 3] as const,
    valueM3: 2.5,
    /** 每单只扣一次，不随卷数放大 */
    appliesPer: 'order' as const,
  },
  effectiveFormula: '长方体总体积 - 空间扣减',
  note: '实际占用体积 = 长方体总体积 − 2~3 m³（取中位数 2.5 m³），每单只扣一次。',
} as const;

/** 派生量代号 —— 与后端指标名一一对应，供前端按名取数。 */
export const NIULANWANG_METRIC_CODES = {
  weightBase: 'weight_base_kg',
  edgeWeight: 'edge_weight_kg',
  waveAdd: 'wave_add_kg',
  netWeightPerRoll: 'weight_per_piece_kg',
  cylinderVolumePerRoll: 'volume_per_piece_m3',
  boxVolumePerRoll: 'volume_box_per_piece_m3',
  rollCount: 'roll_count',
  totalNetWeight: 'total_net_weight_kg',
  boxVolumeTotal: 'volume_box_m3',
  effectiveVolumeTotal: 'volume_effective_m3',
  pricePerPiece: 'price_per_piece',
  pricePerMeter: 'price_per_meter',
  pricePerPieceFx: 'price_per_piece_fx',
} as const;

/** 前端展示用的规格项 —— 与后端 `GET /products/{key}/formulas` 同步。 */
export const NiulanwangAxisSchema = z.object({
  code: z.enum([
    'wire_option',
    'height',
    'vertical_wire_spacing',
    'zinc_coating',
    'wave_type',
  ]),
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  label_text: z.string().optional(),
});
export type NiulanwangAxis = z.infer<typeof NiulanwangAxisSchema>;

/**
 * 按轴取值算组合数 —— 用作「48」这个数字的自检，
 * 避免有人在某处多加/少加一个取值而没人发现。
 */
export function niulanwangComboCount(): number {
  return Object.values(NIULANWANG_SKU_AXES).reduce(
    (n, axis) => n * axis.options.length,
    1,
  );
}

/** 取某个丝径方案的联动属性（三个丝径 + 卷长 + 卷径一次全定）。 */
export function wireOptionOf(value: string) {
  return NIULANWANG_SKU_AXES.wire_option.options.find((o) => o.value === value);
}

/**
 * 波弯增重（单卷 kg）—— 与后端 `wave_add_kg` 同一口径。
 * 前端如需在提交前预检可调用；正式数值仍以后端返回为准。
 */
export function waveAddKg(rollLengthM: number, waveFactor: number): number {
  return (waveFactor * WAVE_ADD_KG_PER_100M * rollLengthM) / 100;
}

/** 单卷净体积（圆柱体，m³）。 */
export function cylinderVolumePerRoll(rollDiameterM: number, heightM: number): number {
  return (Math.PI / 4) * rollDiameterM ** 2 * heightM;
}

/** 单卷长方体体积（外接方柱，m³）。 */
export function boxVolumePerRoll(rollDiameterM: number, heightM: number): number {
  return rollDiameterM ** 2 * heightM;
}
