"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { AsyncButton } from "@/components/shared";
import { useAsyncAction } from "@/lib/hooks/use-async-action";
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
  /**
   * P0-B2/SC5：提交失败必须有出口（旧实现直接 `mutateAsync`，失败即未处理 rejection；
   * 成功也没有 toast）。`useAsyncAction` 默认不 toast：拦截器已统一提示错误，
   * 这里补「弹窗内错误 + 成功后 toast」；pending 期间禁用并禁止关窗。
   */
  const submit = useAsyncAction(
    (input: Parameters<typeof propose.mutateAsync>[0]) =>
      propose.mutateAsync(input),
    {
      onSuccess: () => {
        toast.success("已提交属性提议，等待管理员审核");
        setName("");
        setDataType("text");
        setUnit("");
        setSampleValues("");
        onClose();
      },
    },
  );

  function handleSubmit() {
    if (!name.trim()) return;
    const samples = sampleValues
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    void submit.run({
      category_id: categoryId,
      group_code: groupCode,
      proposed_name: name.trim(),
      proposed_type: dataType,
      proposed_unit: unit || null,
      sample_values: samples.length > 0 ? samples : null,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !submit.pending) onClose();
      }}
    >
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
        {/* P0-B2/SC5：失败原因如实显示在弹窗里，弹窗不关、可直接重试 */}
        {submit.error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            提交失败：{submit.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.pending}>
            取消
          </Button>
          <AsyncButton
            onClick={handleSubmit}
            disabled={!name.trim()}
            pending={submit.pending}
            pendingLabel="提交中..."
          >
            提交
          </AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
