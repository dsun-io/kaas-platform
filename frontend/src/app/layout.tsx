import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "@/lib/query/provider";
import { MswProvider } from "@/components/msw-provider";
import { AuthProvider } from "@/lib/auth/auth-context";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "PowerVoy 智能报价平台",
  description: "PowerVoy — 牛栏网智能报价系统",
  icons: { icon: "/assets/brand/logo.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={cn("font-sans", inter.variable)}>
      <body>
        <MswProvider>
          <Suspense fallback={null}>
            <AuthProvider>
              <QueryProvider>
                <TooltipProvider>
                  {children}
                  <Toaster />
                </TooltipProvider>
              </QueryProvider>
            </AuthProvider>
          </Suspense>
        </MswProvider>
      </body>
    </html>
  );
}
