"use client";

import { useMemo } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import type { BindingWithAttribute } from "@contracts/spec-system";

interface Props {
  bindings: BindingWithAttribute[];
  groupCode: string;
  groupLabel: string;
  value: Record<number, { value: unknown; value_code?: string | null }>;
  onChange: (
    v: Record<number, { value: unknown; value_code?: string | null }>,
  ) => void;
  onPropose?: () => void;
}

function buildSchema(bindings: BindingWithAttribute[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const b of bindings) {
    const attr = b.attribute;
    let field: z.ZodTypeAny;
    if (attr.data_type === "number") {
      field = z.coerce.number();
    } else if (attr.data_type === "enum") {
      field = z.string();
    } else if (attr.data_type === "boolean") {
      field = z.boolean();
    } else {
      field = z.string();
    }
    if (!b.is_required) {
      field = field.optional().nullable();
    }
    shape[String(attr.id)] = field;
  }
  return z.object(shape);
}

export function DynamicSpecForm({
  bindings,
  groupCode,
  groupLabel,
  value,
  onChange,
  onPropose,
}: Props) {
  const groupBindings = useMemo(
    () =>
      bindings
        .filter((b) => b.group_code === groupCode)
        .sort((a, b) => a.sort_order - b.sort_order),
    [bindings, groupCode],
  );

  if (groupBindings.length === 0) return null;

  function handleFieldChange(
    attrId: number,
    fieldValue: unknown,
    valueCode?: string | null,
  ) {
    onChange({
      ...value,
      [attrId]: { value: fieldValue, value_code: valueCode },
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">{groupLabel}</CardTitle>
        {onPropose && (
          <Button variant="outline" size="sm" onClick={onPropose}>
            <Plus className="h-4 w-4 mr-1" />
            提议属性
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groupBindings.map((binding) => {
            const attr = binding.attribute;
            const current = value[attr.id];

            return (
              <div key={attr.id} className="space-y-2">
                <Label>
                  {attr.name}
                  {binding.is_required && (
                    <span className="text-destructive ml-1">*</span>
                  )}
                  {attr.unit && (
                    <span className="text-muted-foreground ml-1">
                      ({attr.unit})
                    </span>
                  )}
                </Label>

                {attr.data_type === "enum" ? (
                  <Select
                    value={
                      current?.value_code || (current?.value as string) || ""
                    }
                    onValueChange={(v) => {
                      const av = attr.values?.find(
                        (val) => val.value_code === v,
                      );
                      handleFieldChange(attr.id, v, av?.value_code);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={`选择${attr.name}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {attr.values?.map((v) => (
                        <SelectItem key={v.id} value={v.value_code}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : attr.data_type === "boolean" ? (
                  <Select
                    value={
                      current?.value === true
                        ? "true"
                        : current?.value === false
                          ? "false"
                          : ""
                    }
                    onValueChange={(v) =>
                      handleFieldChange(attr.id, v === "true")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={`选择${attr.name}`} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">是</SelectItem>
                      <SelectItem value="false">否</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={attr.data_type === "number" ? "number" : "text"}
                    value={(current?.value as string | number) ?? ""}
                    onChange={(e) => {
                      const v =
                        attr.data_type === "number"
                          ? e.target.value === ""
                            ? ""
                            : Number(e.target.value)
                          : e.target.value;
                      handleFieldChange(attr.id, v);
                    }}
                    placeholder={`输入${attr.name}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
