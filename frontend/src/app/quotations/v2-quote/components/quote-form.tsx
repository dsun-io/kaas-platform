"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2, Plus, X } from "lucide-react";
import { useProductSpecs } from "../hooks/use-v2-quote";
import type { QuoteV2Request } from "@contracts/quote";

interface AccessoryRow {
  key: string;
  product_category: string;
  quantity: number;
}

interface Props {
  onSubmit: (input: QuoteV2Request) => void;
  isLoading: boolean;
}

const CATEGORIES = ["牛栏网", "石笼网", "镀锌", "包塑", "立柱"];

function orEmpty(v: string | null): string {
  return v ?? "";
}

export function QuoteForm({ onSubmit, isLoading }: Props) {
  const [productCategory, setProductCategory] = useState("牛栏网");
  const [productType, setProductType] = useState("");
  const [wireDiameter, setWireDiameter] = useState("");
  const [meshSpec, setMeshSpec] = useState("");
  const [meshWidth, setMeshWidth] = useState("");
  const [height, setHeight] = useState("");
  const [rollLength, setRollLength] = useState("");
  const [quantity, setQuantity] = useState("100");
  const [province, setProvince] = useState("");
  const [accessories, setAccessories] = useState<AccessoryRow[]>([]);

  const { data: specs, isLoading: specsLoading } =
    useProductSpecs(productCategory);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      product_category: productCategory,
      quantity: parseInt(quantity) || 1,
      ...(productType && { product_type: productType }),
      ...(wireDiameter && { wire_diameter: wireDiameter }),
      ...(meshSpec && { mesh_spec: meshSpec }),
      ...(meshWidth && { mesh_width: parseFloat(meshWidth) }),
      ...(height && { height: parseFloat(height) }),
      ...(rollLength && { roll_length: parseFloat(rollLength) }),
      ...(province && { province }),
      ...(accessories.length > 0 && {
        accessories: accessories.map((a) => ({
          product_category: a.product_category,
          quantity: a.quantity,
        })),
      }),
    } as QuoteV2Request);
  };

  const addAccessory = () => {
    const accCats = specs?.accessory_categories ?? ["立柱", "地锚"];
    const newCat =
      accCats.find((c) => !accessories.find((a) => a.product_category === c)) ||
      accCats[0];
    setAccessories([
      ...accessories,
      { key: `${Date.now()}`, product_category: newCat || "立柱", quantity: 1 },
    ]);
  };

  const removeAccessory = (key: string) => {
    setAccessories(accessories.filter((a) => a.key !== key));
  };

  const updateAccessory = (
    key: string,
    field: "product_category" | "quantity",
    value: string | number,
  ) => {
    setAccessories(
      accessories.map((a) => (a.key === key ? { ...a, [field]: value } : a)),
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Product Category */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>产品品类</Label>
          <Select
            value={productCategory}
            onValueChange={(v) => {
              if (v) {
                setProductCategory(v);
                setProductType("");
              }
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>数量</Label>
          <Input
            type="number"
            min="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
      </div>

      {/* Spec Options */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">规格参数</CardTitle>
        </CardHeader>
        <CardContent>
          {specsLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              加载规格选项...
            </div>
          ) : specs ? (
            <div className="grid grid-cols-2 gap-3">
              {specs.options.product_types.length > 0 && (
                <div className="space-y-1.5">
                  <Label>产品类型</Label>
                  <Select
                    value={productType}
                    onValueChange={(v) => setProductType(orEmpty(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {specs.options.product_types.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {specs.options.wire_diameters.length > 0 && (
                <div className="space-y-1.5">
                  <Label>丝径</Label>
                  <Select
                    value={wireDiameter}
                    onValueChange={(v) => setWireDiameter(orEmpty(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {specs.options.wire_diameters.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {specs.options.mesh_specs.length > 0 && (
                <div className="space-y-1.5">
                  <Label>网孔规格</Label>
                  <Select
                    value={meshSpec}
                    onValueChange={(v) => setMeshSpec(orEmpty(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {specs.options.mesh_specs.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {specs.options.mesh_widths.length > 0 && (
                <div className="space-y-1.5">
                  <Label>网孔宽度</Label>
                  <Select
                    value={meshWidth}
                    onValueChange={(v) => setMeshWidth(orEmpty(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {specs.options.mesh_widths.map((w) => (
                        <SelectItem key={w} value={String(w)}>
                          {w}mm
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {specs.options.heights.length > 0 && (
                <div className="space-y-1.5">
                  <Label>高度 (m)</Label>
                  <Select
                    value={height}
                    onValueChange={(v) => setHeight(orEmpty(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {specs.options.heights.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {h}m
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {specs.options.roll_lengths.length > 0 && (
                <div className="space-y-1.5">
                  <Label>卷长 (m)</Label>
                  <Select
                    value={rollLength}
                    onValueChange={(v) => setRollLength(orEmpty(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {specs.options.roll_lengths.map((l) => (
                        <SelectItem key={l} value={String(l)}>
                          {l}m
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          ) : (
            <p className="py-2 text-xs text-muted-foreground">
              加载规格选项失败
            </p>
          )}
        </CardContent>
      </Card>

      {/* Accessories */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">配件选项</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {accessories.map((acc) => (
            <div key={acc.key} className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>配件品类</Label>
                <Select
                  value={acc.product_category}
                  onValueChange={(v) =>
                    updateAccessory(acc.key, "product_category", orEmpty(v))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(specs?.accessory_categories ?? ["立柱", "地锚"]).map(
                      (cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-24 space-y-1.5">
                <Label>数量</Label>
                <Input
                  type="number"
                  min="1"
                  value={acc.quantity}
                  onChange={(e) =>
                    updateAccessory(
                      acc.key,
                      "quantity",
                      parseInt(e.target.value) || 1,
                    )
                  }
                  className="h-8 text-xs"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={() => removeAccessory(acc.key)}
              >
                <X className="size-3" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={addAccessory}
          >
            <Plus className="mr-1 size-3" />
            添加配件
          </Button>
        </CardContent>
      </Card>

      {/* Freight */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">运费选项（可选）</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>省份</Label>
              <Input
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                placeholder="如：广东省"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Button
        type="submit"
        size="default"
        disabled={isLoading}
        className="w-full"
      >
        {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
        {isLoading ? "报价计算中..." : "获取报价"}
      </Button>
    </form>
  );
}
