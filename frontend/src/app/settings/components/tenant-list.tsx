'use client';

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { Tenant } from './types';

interface Props {
  tenants: Tenant[];
  loading?: boolean;
}

export function TenantList({ tenants, loading }: Props) {
  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>租户 ID</TableHead>
          <TableHead>名称</TableHead>
          <TableHead>区域</TableHead>
          <TableHead>语言</TableHead>
          <TableHead>状态</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tenants.map((t) => (
          <TableRow key={t.tenant_id}>
            <TableCell className="font-mono text-xs">{t.tenant_id}</TableCell>
            <TableCell className="font-medium">{t.display_name}</TableCell>
            <TableCell className="text-xs">{t.region}</TableCell>
            <TableCell className="text-xs">{t.locale}</TableCell>
            <TableCell>
              <Badge variant={t.is_active ? 'default' : 'secondary'}>
                {t.is_active ? '活跃' : '停用'}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
