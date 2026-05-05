/**
 * Single source of truth: v2 design document §2.2 (business domain)
 * 联佳丝网业务术语表。
 */

import { ProductCategory } from './categories';

export interface GlossaryEntry {
  term: string;
  category: ProductCategory;
  description: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: '牛栏网', category: ProductCategory.牛栏网, description: '牧场围栏用 hexagonal wire mesh（六角网）' },
  { term: '石笼网', category: ProductCategory.石笼网, description: '水利工程用 gabion mesh（重型六角网）' },
  { term: '镀锌', category: ProductCategory.镀锌, description: '热浸镀锌/电镀锌表面处理工艺' },
  { term: '包塑', category: ProductCategory.包塑, description: 'PVC 包塑涂层工艺' },
  { term: '丝径', category: ProductCategory.牛栏网, description: 'wire diameter，单位为 mm' },
  { term: '网孔', category: ProductCategory.牛栏网, description: 'mesh opening，单位为 mm × mm' },
];
