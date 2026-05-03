'use client';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
interface StatCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  total: number | string;
  sampledCount?: number;
  samplingRate?: number;
  unit?: string;
  hint?: string;
}

export function StatCard({
  title,
  icon: Icon,
  total,
  sampledCount,
  samplingRate,
  unit,
  hint,
}: StatCardProps) {
  const hasSampling = sampledCount !== undefined && samplingRate !== undefined;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-2xl font-bold">
          {typeof total === 'number' ? total.toLocaleString('zh-CN') : total}
          {unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}
        </p>
        {hasSampling && (
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="flex gap-2 text-xs text-muted-foreground cursor-help">
                  <span>
                    采样: {sampledCount!.toLocaleString('zh-CN')}
                  </span>
                  <span>
                    ({(samplingRate! * 100).toFixed(1)}%)
                  </span>
                </div>
              }
            />
            <TooltipContent>
              <p className="text-xs">
                基于 {samplingRate! * 100}% 采样率推算，
                <br />
                实际值误差 ±{(samplingRate! > 0 ? (100 / (samplingRate! * 100)).toFixed(0) : '∞')} 条以内
              </p>
            </TooltipContent>
          </Tooltip>
        )}
        {hint && (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}
