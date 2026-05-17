import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Paths that middleware should NOT protect
const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/setup-admin",
  "/forgot-password",
];

// Path prefixes that are always allowed
const EXCLUDED_PREFIXES = ["/_next", "/api", "/favicon.ico", "/favicon.svg"];

// File extensions that are static assets
const STATIC_EXTENSIONS =
  /\.(svg|png|jpg|jpeg|gif|ico|css|js|woff2?|ttf|eot|map)$/i;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip excluded prefixes (Next internals, API routes, favicon)
  if (EXCLUDED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Skip static assets
  if (STATIC_EXTENSIONS.test(pathname)) {
    return NextResponse.next();
  }

  const hasToken = request.cookies.get("has_token")?.value === "1";
  const isPublic = PUBLIC_PATHS.includes(pathname);
  const isSetupAdmin = pathname === "/setup-admin";

  if (!hasToken && !isPublic) {
    // Not authenticated, not on a public page — redirect to login
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (hasToken && isPublic && !isSetupAdmin) {
    // Already authenticated, on login/register/forgot-password — redirect to dashboard
    // setup-admin is exempt: backend decides if already initialized
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all routes except:
     * - /api (backend proxy or MSW passthrough)
     * - /_next/static, /_next/image (Next.js internals)
     * - /favicon.ico, /favicon.svg
     */
    "/((?!api/|_next/|favicon\\.).*)",
  ],
};
