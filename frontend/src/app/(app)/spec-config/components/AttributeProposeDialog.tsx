"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useProposeAttribute } from "../hooks/use-wizard-submit";

interface Props {
  open: boolean;
  onClose: () => void;
  categoryId: number;
  groupCode: string;
}

const DATA_TYPES = [
  { value: "text", label: "文本" },
  { value: "number", label: "数字" },
  { value: "enum", label: "枚举" },
  { value: "boolean", label: "布尔" },
];

export function AttributeProposeDialog({
  open,
  onClose,
  categoryId,
  groupCode,
}: Props) {
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState("text");
  const [unit, setUnit] = useState("");
  const [sampleValues, setSampleValues] = useState("");

  const propose = useProposeAttribute();

  async function handleSubmit() {
    if (!name.trim()) return;
    const samples = sampleValues
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    await propose.mutateAsync({
      category_id: categoryId,
      group_code: groupCode,
      proposed_name: name.trim(),
      proposed_type: dataType,
      proposed_unit: unit || null,
      sample_values: samples.length > 0 ? samples : null,
    });

    setName("");
    setDataType("text");
    setUnit("");
    setSampleValues("");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>提议新属性</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>
              属性名称 <span className="text-destructive">*</span>
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: 镀锌层厚度"
            />
          </div>
          <div className="space-y-2">
            <Label>数据类型</Label>
            <Select value={dataType} onValueChange={(v) => v && setDataType(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATA_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>单位</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="例如: mm, g/m2"
            />
          </div>
          <div className="space-y-2">
            <Label>示例值（逗号分隔）</Label>
            <Input
              value={sampleValues}
              onChange={(e) => setSampleValues(e.target.value)}
              placeholder="例如: 40g, 60g, 80g"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || propose.isPending}
          >
            {propose.isPending ? "提交中..." : "提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
