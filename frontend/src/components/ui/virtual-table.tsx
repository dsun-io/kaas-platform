'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface VirtualTableProps<T> {
  rows: T[];
  columns: { key: string; header: string; className?: string }[];
  rowHeight?: number;
  renderCell: (row: T, columnKey: string) => React.ReactNode;
  renderRowKey: (row: T) => string;
}

export function VirtualTable<T>({
  rows,
  columns,
  rowHeight = 40,
  renderCell,
  renderRowKey,
}: VirtualTableProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  if (rows.length <= 200) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.key} className={c.className}>{c.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={renderRowKey(row)}>
              {columns.map((c) => (
                <TableCell key={c.key} className={c.className}>
                  {renderCell(row, c.key)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div ref={parentRef} style={{ height: '600px', overflow: 'auto' }}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.key} className={c.className}>{c.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <tr style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <td style={{ padding: 0 }} colSpan={columns.length}>
              <div style={{ position: 'relative' }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const row = rows[virtualItem.index]!;
                  return (
                    <div
                      key={renderRowKey(row)}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <TableRow>
                        {columns.map((c) => (
                          <TableCell key={c.key} className={c.className}>
                            {renderCell(row, c.key)}
                          </TableCell>
                        ))}
                      </TableRow>
                    </div>
                  );
                })}
              </div>
            </td>
          </tr>
        </TableBody>
      </Table>
    </div>
  );
}
