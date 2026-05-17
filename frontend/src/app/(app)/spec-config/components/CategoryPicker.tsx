"use client";

import { useState, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { CategoryNode } from "@contracts/spec-system";

interface Props {
  categories: CategoryNode[];
  onSelect: (categoryId: number) => void;
}

function flattenLeaves(nodes: CategoryNode[]): CategoryNode[] {
  const leaves: CategoryNode[] = [];
  function walk(list: CategoryNode[]) {
    for (const n of list) {
      if (!n.children || n.children.length === 0) {
        leaves.push(n);
      } else {
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return leaves;
}

function buildPath(
  nodes: CategoryNode[],
  targetId: number,
  path: CategoryNode[] = [],
): CategoryNode[] | null {
  for (const n of nodes) {
    const cur = [...path, n];
    if (n.id === targetId) return cur;
    if (n.children?.length) {
      const found = buildPath(n.children, targetId, cur);
      if (found) return found;
    }
  }
  return null;
}

export function CategoryPicker({ categories, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);

  const leaves = useMemo(() => flattenLeaves(categories), [categories]);

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSelect(id: number) {
    setSelected(id);
    onSelect(id);
  }

  function renderNode(node: CategoryNode, depth: number = 0) {
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    const isSelected = selected === node.id;

    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors ${
            isSelected ? "bg-accent font-medium" : ""
          }`}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => {
            if (hasChildren) {
              toggleExpand(node.id);
            } else {
              handleSelect(node.id);
            }
          }}
        >
          {hasChildren ? (
            isExpanded ? (
              <FolderOpen className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Folder className="h-4 w-4 text-muted-foreground" />
            )
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm">{node.name}</span>
        </div>
        {hasChildren && isExpanded && (
          <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">选择品类</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">{categories.map((c) => renderNode(c))}</div>
        {selected && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              已选: {leaves.find((l) => l.id === selected)?.name}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
