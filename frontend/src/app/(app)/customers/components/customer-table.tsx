"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";
import type { Customer } from "../hooks/use-customers";

interface Props {
  customers: Customer[];
  loading?: boolean;
}

export function CustomerTable({ customers, loading }: Props) {
  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        加载中...
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="hidden sm:table-cell">客户 ID</TableHead>
          <TableHead>名称</TableHead>
          <TableHead>品类数</TableHead>
          <TableHead>区域</TableHead>
          <TableHead className="hidden md:table-cell">最后更新</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {customers.map((c) => (
          <TableRow key={c.customer_id}>
            <TableCell className="hidden sm:table-cell font-mono text-xs">
              {c.customer_id}
            </TableCell>
            <TableCell className="font-medium">{c.customer_name}</TableCell>
            <TableCell>
              <Badge variant="secondary">{c.category_count} 个品类</Badge>
            </TableCell>
            <TableCell className="text-xs">{c.region}</TableCell>
            <TableCell className="hidden md:table-cell text-xs">
              {new Date(c.updated_at).toLocaleString("zh-CN")}
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="icon-xs"
                render={
                  <Link href={{ pathname: `/customers/${c.customer_id}` }}>
                    <ChevronRight className="size-4" />
                  </Link>
                }
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
