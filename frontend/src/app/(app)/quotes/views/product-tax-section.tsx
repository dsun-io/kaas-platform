"use client";

/**
 * 报价参数 · 产品 + 税务档案区（从 product-quote-view 拆出）。
 *
 * 拆分口径（2026-10-17 巨石拆分第一刀）：
 * **只搬 JSX，不动 state 与业务逻辑** —— 所有状态（产品 key、档案选中、
 * 存档文案…）仍在父组件，本组件只收 props + 发事件。这样拆错了好回退
 * （revert 一个文件），且不会碰到 30 个 useState 之间的联动。
 *
 * 业务口径（与拆分前逐字一致）：
 * - 产品下拉：选产品 → 清结果/错误（换产品等于换计算逻辑）；
 * - 税务档案下拉**两层**：客户税率档案（这个客户存过的那套税率）+ 法定税务
 *   档案（国家政策）；选客户档案时法定档案跟着切过去（配套使用，分开选会
 *   拼出没人确认过的组合）；
 * - 「存为档案」只保存**税率类**参数（利润与让利比例不存 —— 利润是每单的
 *   商业决策，被档案悄悄带回来会报出没确认过的价）。
 */
import { Loader2, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { QuoteProfile } from "@contracts/export-quote";

interface ProductOption {
  key: string;
  name: string;
}

interface RateSetOption {
  code: string;
  name?: string | null;
}

export interface ProductTaxSectionProps {
  /** 可报价产品列表（下拉数据源） */
  products: ProductOption[] | undefined;
  productsLoading: boolean;
  /** 当前选中的产品 key */
  effectiveProduct: string;
  /** 选产品：父组件里负责清 result/error */
  onProductChange: (key: string) => void;

  /** 法定税务档案列表（下拉下层） */
  rateSets: RateSetOption[] | undefined;
  /** 客户税率档案列表（下拉上层） */
  profiles: QuoteProfile[];
  /** 当前选中的档案（`profile:{id}` / `rate:{code}` / 空） */
  taxPick: string;
  /** 选档案：父组件里负责套用档案/清档案税率 */
  onTaxPickChange: (value: string) => void;
  /** 套用/移除档案的提示文案 */
  profileNotice: string | null;
  /** 当前套用中的客户档案（为空 = 法定档案） */
  pickedProfile: QuoteProfile | null;

  // 「存为档案」展开态与表单
  savingOpen: boolean;
  onSavingOpenChange: (open: boolean) => void;
  profileName: string;
  onProfileNameChange: (v: string) => void;
  onSaveProfile: () => void;
  onDeleteProfile: (p: QuoteProfile) => void;
  savePending: boolean;
  deletePending: boolean;
  /** 当前生效的法定档案 code（保存按钮的可用条件） */
  effectiveRateSet: string;
}

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ProductTaxSection({
  products,
  productsLoading,
  effectiveProduct,
  onProductChange,
  rateSets,
  profiles,
  taxPick,
  onTaxPickChange,
  profileNotice,
  pickedProfile,
  savingOpen,
  onSavingOpenChange,
  profileName,
  onProfileNameChange,
  onSaveProfile,
  onDeleteProfile,
  savePending,
  deletePending,
  effectiveRateSet,
}: ProductTaxSectionProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <div className="space-y-1.5">
        <Label className="text-xs">产品</Label>
        <select
          value={effectiveProduct}
          onChange={(e) => onProductChange(e.target.value)}
          disabled={productsLoading}
          className={SELECT_CLASS}
        >
          {(products ?? []).length === 0 && (
            <option value="">
              {productsLoading ? "加载中…" : "暂无可报价产品"}
            </option>
          )}
          {(products ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {(rateSets ?? []).length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">税务档案</Label>
          {/* 一个下拉装两层：上面的「客户税率档案」是给这个客户存的那套税率，
              下面的「法定税务档案」是国家政策。选中客户档案时法定档案会跟着切过去
              —— 两层是配套使用的，分开选会拼出没人确认过的组合。 */}
          <select
            value={taxPick}
            onChange={(e) => onTaxPickChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">（未指定，按报价当期生效的一份）</option>
            {profiles.length > 0 && (
              <optgroup label="客户税率档案">
                {profiles.map((p) => (
                  <option key={`profile:${p.id}`} value={`profile:${p.id}`}>
                    {p.profile_name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="法定税务档案">
              {(rateSets ?? []).map((r) => (
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
                onChange={(e) => onProfileNameChange(e.target.value)}
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
                    !profileName.trim() || savePending || !effectiveRateSet
                  }
                  onClick={onSaveProfile}
                >
                  {savePending && (
                    <Loader2 className="mr-1 size-3 animate-spin" />
                  )}
                  保存
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => onSavingOpenChange(false)}
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
                onClick={() => onSavingOpenChange(true)}
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
                  disabled={deletePending}
                  onClick={() => onDeleteProfile(pickedProfile)}
                >
                  <Trash2 className="size-3" />
                  移除
                </Button>
              )}
            </div>
          )}

          {profileNotice && (
            <p className="text-[11px] text-muted-foreground">{profileNotice}</p>
          )}
        </div>
      )}
    </div>
  );
}
