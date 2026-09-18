"use client";

import { useState } from "react";
import {
  useIntelTradeStats,
  type IntelTradeStatFilters,
} from "../hooks/use-intel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";

export function TradeStatsView() {
  const [filters, setFilters] = useState<IntelTradeStatFilters>({});
  const [searchInput, setSearchInput] = useState({
    hs_code: "",
    partner_country: "",
    trade_flow: "",
    period: "",
  });

  const { data, isLoading, error } = useIntelTradeStats(filters);

  const handleSearch = () => {
    setFilters({ ...searchInput });
  };

  const formatValue = (value?: number) => {
    if (value === undefined || value === null) return "-";
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
    return value.toString();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>贸易统计数据</CardTitle>
        <div className="flex flex-wrap gap-2 mt-4">
          <Input
            placeholder="HS编码"
            value={searchInput.hs_code}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, hs_code: e.target.value }))
            }
            className="w-32"
          />
          <Input
            placeholder="贸易伙伴国"
            value={searchInput.partner_country}
            onChange={(e) =>
              setSearchInput((prev) => ({
                ...prev,
                partner_country: e.target.value,
              }))
            }
            className="w-40"
          />
          <Input
            placeholder="进出口类型"
            value={searchInput.trade_flow}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, trade_flow: e.target.value }))
            }
            className="w-32"
          />
          <Input
            placeholder="期间 (如 2024-01)"
            value={searchInput.period}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, period: e.target.value }))
            }
            className="w-32"
          />
          <Button onClick={handleSearch} size="icon">
            <Search className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8 text-muted-foreground">
            加载失败，请稍后重试
          </div>
        ) : data && data.length > 0 ? (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>HS编码</TableHead>
                    <TableHead>期间</TableHead>
                    <TableHead>贸易伙伴</TableHead>
                    <TableHead>进出口</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">金额 (USD)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((stat) => (
                    <TableRow key={stat.id}>
                      <TableCell className="font-medium">{stat.hs_code}</TableCell>
                      <TableCell>{stat.period}</TableCell>
                      <TableCell>{stat.partner_country}</TableCell>
                      <TableCell>
                        {stat.trade_flow === "import" ? "进口" : "出口"}
                      </TableCell>
                      <TableCell className="text-right">
                        {stat.qty?.toLocaleString() || "-"} {stat.qty_unit}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatValue(stat.value_usd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              共 {data.length} 条记录
            </p>
          </>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            暂无贸易统计数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}
