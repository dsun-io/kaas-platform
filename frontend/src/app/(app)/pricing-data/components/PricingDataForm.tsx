"use client";

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, X } from "lucide-react";
import type { PricingEntry } from "../hooks/use-pricing-data";

const CATEGORIES = [
  { value: "niulanwang", label: "牛栏网" },
  { value: "gouhuawang", label: "勾花网" },
  { value: "post", label: "立柱" },
  { value: "fence", label: "围栏" },
  { value: "barbed_wire", label: "刺绳" },
  { value: "gabion", label: "石笼网" },
  { value: "steel_grating", label: "钢格板" },
  { value: "other", label: "其他" },
];

const CATEGORY_MAP = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

const HEIGHTS = [0.8, 1.0, 1.25, 1.5, 1.8, 2.0];
const MESH_WIDTHS = [5, 10, 15, 20, 25];
const ROLL_LENGTHS = [30, 50, 100];
const WIRE_DIAMETERS = ["1.5", "2.0", "2.5", "3.0", "3.5", "4.0", "5.0"];
const COST_UNITS = ["元/卷", "元/kg", "元/捆", "元/平方米", "元/个", "元/根"];

const PRODUCT_TYPES: Record<string, string[]> = {
  niulanwang: ["上疏下密", "环扣"],
  gouhuawang: ["普通"],
  post: ["直边", "花边"],
  fence: ["双边", "框架"],
  barbed_wire: ["单股", "双股"],
  gabion: ["六角", "双绞"],
  steel_grating: ["压焊", "插接"],
  other: ["其他"],
};

const NO_EXPIRY = "__no_expiry__";

const formSchema = z.object({
  product_category: z.string().min(1, "请选择产品品类"),
  product_type: z.string().optional(),
  wire_diameter: z.string().optional(),
  height: z.string().optional(),
  mesh_width: z.string().optional(),
  mesh_spec: z.string().optional(),
  roll_length: z.string().optional(),
  weight_kg: z.string().optional(),
  cost_amount: z.coerce.number().min(0, "成本金额必须大于或等于 0"),
  cost_unit: z.string().min(1, "请选择成本单位"),
  effective_from: z.string().optional(),
  effective_to: z.string().optional(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  editingEntry?: PricingEntry | null;
  onSubmit: (values: FormValues, editingId: number | null) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}

export function PricingDataForm({
  editingEntry,
  onSubmit,
  onCancel,
  submitting,
  error,
}: Props) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      product_category: "",
      product_type: "",
      wire_diameter: "",
      height: "",
      mesh_width: "",
      mesh_spec: "",
      roll_length: "",
      weight_kg: "",
      cost_amount: 0,
      cost_unit: "元/卷",
      effective_from: "",
      effective_to: "",
      notes: "",
    },
  });

  const productCategory = watch("product_category");

  useEffect(() => {
    if (editingEntry) {
      const spec = editingEntry.product_spec ?? {};
      reset({
        product_category: editingEntry.product_category ?? "",
        product_type: (spec.product_type as string) ?? "",
        wire_diameter: (spec.wire_diameter as string) ?? "",
        height: spec.height != null ? String(spec.height) : "",
        mesh_width: spec.mesh_width != null ? String(spec.mesh_width) : "",
        mesh_spec: (spec.mesh_spec as string) ?? "",
        roll_length: spec.roll_length != null ? String(spec.roll_length) : "",
        weight_kg: spec.weight_kg != null ? String(spec.weight_kg) : "",
        cost_amount: editingEntry.amount,
        cost_unit: editingEntry.unit ?? "元/卷",
        effective_from: editingEntry.effective_from?.split("T")[0] ?? "",
        effective_to: editingEntry.effective_to?.split("T")[0] ?? "",
        notes: editingEntry.notes ?? "",
      });
    }
  }, [editingEntry, reset]);

  const editingId = editingEntry?.id ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {editingId != null ? "编辑规格与成本" : "录入规格与成本"}
        </CardTitle>
        <CardDescription>
          {editingId != null
            ? "修改产品规格参数或成本价信息"
            : "填写产品规格参数和成本价信息"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit((v) => onSubmit(v, editingId))}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>产品品类 *</Label>
              <Controller
                name="product_category"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择">
                        {field.value ? CATEGORY_MAP[field.value] : "请选择"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.product_category && (
                <p className="text-xs text-destructive">
                  {errors.product_category.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>加工工艺</Label>
              <Controller
                name="product_type"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || ""}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择">
                        {field.value || "请选择"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(PRODUCT_TYPES[productCategory] ?? []).map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>丝径 (mm)</Label>
              <Controller
                name="wire_diameter"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || ""}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择">
                        {field.value ? `${field.value}mm` : "请选择"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {WIRE_DIAMETERS.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}mm
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>高度 (米)</Label>
              <Controller
                name="height"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || ""}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择">
                        {field.value ? `${field.value}m` : "请选择"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {HEIGHTS.map((v) => (
                        <SelectItem key={v} value={String(v)}>
                          {v}m
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>网宽 (cm)</Label>
              <Controller
                name="mesh_width"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || ""}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择">
                        {field.value ? `${field.value}cm` : "请选择"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {MESH_WIDTHS.map((v) => (
                        <SelectItem key={v} value={String(v)}>
                          {v}cm
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>网孔规格</Label>
              <Input
                {...register("mesh_spec")}
                placeholder="例: 10x10"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>卷长 (米)</Label>
              <Controller
                name="roll_length"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || ""}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择">
                        {field.value ? `${field.value}m` : "请选择"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {ROLL_LENGTHS.map((v) => (
                        <SelectItem key={v} value={String(v)}>
                          {v}m
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>重量 (kg)</Label>
              <Input
                {...register("weight_kg")}
                type="number"
                step="0.1"
                placeholder="每卷/每件重量"
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label>生效日期</Label>
              <Input
                {...register("effective_from")}
                type="date"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>成本金额 *</Label>
              <Input
                {...register("cost_amount")}
                type="number"
                step="0.01"
                placeholder="0.00"
                disabled={submitting}
              />
              {errors.cost_amount && (
                <p className="text-xs text-destructive">
                  {errors.cost_amount.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>成本单位 *</Label>
              <Controller
                name="cost_unit"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={submitting}
                  >
                    <SelectTrigger>
                      <SelectValue>{field.value}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {COST_UNITS.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.cost_unit && (
                <p className="text-xs text-destructive">
                  {errors.cost_unit.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>失效日期</Label>
              <Input
                {...register("effective_to")}
                type="date"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>备注</Label>
            <Input
              {...register("notes")}
              placeholder="可选备注"
              disabled={submitting}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {editingId != null ? "保存修改" : "保存"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
            >
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
