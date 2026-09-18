"use client";

import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useIntelShipments,
  type IntelShipmentFilters,
} from "../hooks/use-intel";
import { Search, RotateCcw } from "lucide-react";

const PAGE_SIZE = 20;

export function ShipmentsTable() {
  const [filters, setFilters] = useState<IntelShipmentFilters>({
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [searchInput, setSearchInput] = useState({
    shipper: "",
    consignee: "",
    dest_country: "",
    hs_code: "",
    date_from: "",
    date_to: "",
  });

  const { data, isLoading, error } = useIntelShipments(filters);

  const handleSearch = () => {
    setFilters((prev) => ({
      ...prev,
      ...searchInput,
      page: 1,
    }));
  };

  const handleReset = () => {
    setSearchInput({
      shipper: "",
      consignee: "",
      dest_country: "",
      hs_code: "",
      date_from: "",
      date_to: "",
    });
    setFilters({ page: 1, page_size: PAGE_SIZE });
  };

  const handlePageChange = (newPage: number) => {
    setFilters((prev) => ({ ...prev, page: newPage }));
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>货运记录查询</CardTitle>
        <div className="flex flex-wrap gap-2 mt-4">
          <Input
            placeholder="发货人"
            value={searchInput.shipper}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, shipper: e.target.value }))
            }
            className="w-40"
          />
          <Input
            placeholder="收货人"
            value={searchInput.consignee}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, consignee: e.target.value }))
            }
            className="w-40"
          />
          <Input
            placeholder="目的国"
            value={searchInput.dest_country}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, dest_country: e.target.value }))
            }
            className="w-32"
          />
          <Input
            placeholder="HS编码"
            value={searchInput.hs_code}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, hs_code: e.target.value }))
            }
            className="w-32"
          />
          <Input
            type="date"
            placeholder="开始日期"
            value={searchInput.date_from}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, date_from: e.target.value }))
            }
            className="w-36"
          />
          <Input
            type="date"
            placeholder="结束日期"
            value={searchInput.date_to}
            onChange={(e) =>
              setSearchInput((prev) => ({ ...prev, date_to: e.target.value }))
            }
            className="w-36"
          />
          <Button onClick={handleSearch} size="icon">
            <Search className="size-4" />
          </Button>
          <Button onClick={handleReset} variant="outline" size="icon">
            <RotateCcw className="size-4" />
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
        ) : data && data.items.length > 0 ? (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>发货人</TableHead>
                    <TableHead>收货人</TableHead>
                    <TableHead>产品描述</TableHead>
                    <TableHead>目的国</TableHead>
                    <TableHead>HS编码</TableHead>
                    <TableHead>日期</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((shipment) => (
                    <TableRow key={shipment.id}>
                      <TableCell className="font-medium">
                        {shipment.shipper}
                      </TableCell>
                      <TableCell>{shipment.consignee}</TableCell>
                      <TableCell className="max-w-xs truncate">
                        {shipment.product_desc}
                      </TableCell>
                      <TableCell>{shipment.dest_country || "-"}</TableCell>
                      <TableCell>{shipment.hs_code || "-"}</TableCell>
                      <TableCell>
                        {shipment.ship_date
                          ? shipment.ship_date.slice(0, 10)
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={shipment.is_verified ? "default" : "secondary"}
                        >
                          {shipment.is_verified ? "已验证" : "未验证"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(filters.page! - 1)}
                  disabled={filters.page === 1}
                >
                  上一页
                </Button>
                <span className="text-sm text-muted-foreground">
                  第 {filters.page} 页 / 共 {totalPages} 页（共 {data.total} 条）
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(filters.page! + 1)}
                  disabled={filters.page === totalPages}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            暂无货运记录数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}
