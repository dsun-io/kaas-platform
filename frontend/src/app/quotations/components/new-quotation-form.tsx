'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { QuoteRequestSchema } from '@contracts/quote';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useCreateQuotation } from '../hooks/use-quotations';
import { useCreateEvent } from '@/lib/events/use-create-event';
import { Loader2 } from 'lucide-react';

const formSchema = QuoteRequestSchema.omit({ session_id: true }).extend({
  unit_price: QuoteRequestSchema.shape.session_id.optional(), // will be set from hook
});
type FormValues = z.infer<typeof formSchema>;

const CATEGORIES = ['牛栏网', '石笼网', '镀锌', '包塑', '立柱'];

interface Props {
  onSuccess?: () => void;
}

export function NewQuotationForm({ onSuccess }: Props) {
  const createMutation = useCreateQuotation();
  const createEvent = useCreateEvent();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      customer_id: 'cust-liankai',
      items: [{ product_category: '牛栏网', product_spec: {}, quantity: 100, unit_price: null, confidence: 'high' }],
    },
  });

  const onSubmit = async (values: FormValues) => {
    const item = values.items[0];
    if (!item) return;

    await createMutation.mutateAsync({
      customer_id: values.customer_id,
      product_category: item.product_category,
      product_spec: item.product_spec as Record<string, unknown>,
      quantity: item.quantity,
      unit_price: item.unit_price ?? null,
      status: item.unit_price != null ? 'matched' : 'estimated',
      confidence: item.confidence,
      discount: 0,
      notes: '',
    });

    createEvent.mutate({
      event_type: 'quote.response',
      event_source: 'frontend',
      payload: {
        session_id: `manual-${Date.now()}`,
        status: 'estimated',
        source: 'quotations_db',
        unit_price: item.unit_price ?? null,
        confidence: item.confidence,
      },
    });

    reset();
    onSuccess?.();
  };

  const category = watch('items.0.product_category');

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>人工录入报价</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">客户 ID</label>
              <Input {...register('customer_id')} className="mt-1 h-8 text-xs" />
              {errors.customer_id && <p className="mt-0.5 text-xs text-destructive">{errors.customer_id.message}</p>}
            </div>
            <div>
              <label className="text-xs font-medium">品类</label>
              <Select value={category} onValueChange={(v) => { if (v) setValue('items.0.product_category', v); }}>
                <SelectTrigger className="mt-1 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium">数量</label>
              <Input type="number" {...register('items.0.quantity', { valueAsNumber: true })} className="mt-1 h-8 text-xs" />
            </div>
            <div>
              <label className="text-xs font-medium">单价 (¥)</label>
              <Input
                type="number"
                step="0.01"
                {...register('items.0.unit_price', {
                  setValueAs: (v) => (v === '' ? null : Number(v)),
                })}
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-xs font-medium">置信度</label>
              <Select
                value={watch('items.0.confidence')}
                onValueChange={(v) => setValue('items.0.confidence', v as 'high' | 'medium' | 'low')}
              >
                <SelectTrigger className="mt-1 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">高</SelectItem>
                  <SelectItem value="medium">中</SelectItem>
                  <SelectItem value="low">低</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="submit" size="sm" disabled={createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="mr-1 size-3 animate-spin" />}
            提交报价
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
