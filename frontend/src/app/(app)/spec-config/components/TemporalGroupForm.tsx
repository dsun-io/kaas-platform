"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export interface TemporalFormValue {
  effective_from: string;
  effective_to: string;
}

interface Props {
  value: TemporalFormValue;
  onChange: (v: TemporalFormValue) => void;
}

export function TemporalGroupForm({ value, onChange }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">时效信息</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>生效日期</Label>
            <Input
              type="date"
              value={value.effective_from}
              onChange={(e) =>
                onChange({ ...value, effective_from: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>失效日期</Label>
            <Input
              type="date"
              value={value.effective_to}
              onChange={(e) =>
                onChange({ ...value, effective_to: e.target.value })
              }
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
