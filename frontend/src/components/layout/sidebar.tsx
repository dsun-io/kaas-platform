"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
    LayoutDashboard,
    ScrollText,
    Settings,
    Menu,
    ChevronLeft,
    Users,
    FileText,
    ToggleLeft,
    BookOpen,
    History,
    Zap,
    Database,
    Compass,
    CreditCard,
    Radar,
    Target,
    Send,
    Sparkles,
} from "lucide-react";
import { useState, Fragment } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface NavItem {
    href: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    adminOnly?: boolean;
}

interface NavGroup {
    label: string;
    items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
        label: "业务",
        items: [
          { href: "/dashboard", label: "仪表盘", icon: LayoutDashboard },
          { href: "/quotations/v2-quote", label: "智能报价", icon: Zap },
          { href: "/quotations", label: "报价历史", icon: FileText },
              ],
  },
  {
        label: "情报体系",
        items: [
          { href: "/intel", label: "进出口情报", icon: Radar, adminOnly: true },
          { href: "/market", label: "市场调研", icon: BookOpen, adminOnly: true },
          { href: "/leadgen", label: "地图源客户信息获取", icon: Target, adminOnly: true },
              ],
  },
  {
        label: "数据",
        items: [
          { href: "/pricing-data", label: "报价数据", icon: Database },
          { href: "/onboarding", label: "新手引导", icon: Compass },
              ],
  },
  {
        label: "订阅",
        items: [{ href: "/billing", label: "升级订阅", icon: CreditCard }],
  },
  {
        label: "客户",
        items: [
          { href: "/customers", label: "客户管理", icon: Users },
              ],
  },
  {
        label: "触达",
        items: [
          { href: "/outreach", label: "客户触达", icon: Send },
              ],
  },
  {
        label: "审计",
        items: [
          { href: "/events", label: "事件审计", icon: ScrollText },
          { href: "/audit-log", label: "操作日志", icon: History },
              ],
  },
  {
        label: "管理",
        items: [
          { href: "/admin/gray-release", label: "灰度切换", icon: ToggleLeft, adminOnly: true },
          { href: "/kb", label: "知识库", icon: BookOpen,
