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
 * **本文件不再声明任何规格轴取值**（2026-10-11 退役）
 * --------------------------------------------------
 * 尺寸类（丝径 / 网高 / 竖丝间距 / 卷长 / 卷径 / 横丝根数）已改为
 * **自由数值参数**：客户填任意值，由公式折算重量与价格。连续量本来就没有
 * "可选值清单"，更没有"组合数"可言。
 *
 * 原先这里是一份**会过期的手抄镜像**（5 轴 / 48 组合 /
 * `NIULANWANG_COMBO_COUNT = 160`）：前端按它写死了下拉与组合数，
 * 后端改了规格它不会跟着变 —— 于是出现「120 / 160 / 48 三个数各说各话」。
 * 界面现在一律从 `/formulas` 读 `space.axes` / `space.variants` / `numeric_inputs`。
 *
 * 这里只保留**与规格空间无关**的口径常量与纯数学助手
 * （体积口径、波弯增重）—— 它们不随取值增减而失效。
 */

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
  /**
   * 扣减**按比例**（2026-10-11 用户裁决），不是固定 m³。
   *
   * 固定额每单只扣一次、不随卷数缩放，**小单上会算出负体积**
   * （实测牛栏网 < 2314 米 / 23 卷时 `volume_effective_m3` 为负），
   * 而这个数是要给货代/报关的。
   *
   * 比例来源：工厂原话「满柜减 2~3 m³」取中位 2.5 m³
   * ÷ 40HQ 可用容积约 68 m³ ≈ 3.7% —— 满柜（约 630 卷）时扣 2.52 m³，
   * 正好落回工厂经验值。
   */
  deduction: {
    mode: 'ratio',
    /** 扣减比例（装柜系数 = 1 − 它） */
    ratio: 0.037,
    /** 工厂经验原话的记录：满柜 2~3 m³ */
    fullContainerM3: [2, 3] as const,
    containerCapacityM3: 68,
  },
  effectiveFormula: '长方体总体积 * (1 - 扣减比例)',
  note: '实际占用体积 = 长方体总体积 × 装柜系数 0.963（= 1 − 3.7%）。'
    + '按比例而非固定额：发得越少扣得越少，且永远不会出现负体积。'
    + '运行时权威值以 `/export-quote/products/{key}/formulas` 为准。',
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
