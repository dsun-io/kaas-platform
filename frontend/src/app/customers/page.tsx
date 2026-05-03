'use client';

import { useCustomers } from './hooks/use-customers';
import { CustomerTable } from './components/customer-table';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { usePageView } from '@/lib/events/use-page-view';

export default function CustomersPage() {
  usePageView({ resource_id: '/customers' });
  const { data: customers, isLoading } = useCustomers();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">客户管理</h1>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>客户列表</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerTable customers={customers ?? []} loading={isLoading} />
        </CardContent>
      </Card>
    </div>
  );
}
