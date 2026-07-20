import { NextResponse, type NextRequest } from "next/server";

// Lightweight gatekeeper: checks for the Supabase auth cookie and redirects
// accordingly. Session validity is enforced by Supabase RLS on every data
// query, so middleware only needs to handle the redirect UX.
export function middleware(request: NextRequest) {
  const hasSession = request.cookies
    .getAll()
    .some((c) => /^sb-.+-auth-token/.test(c.name) && !!c.value);
  const isLogin = request.nextUrl.pathname.startsWith("/login");
  if (!hasSession && !isLogin) return NextResponse.redirect(new URL("/login", request.url));
  if (hasSession && isLogin) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
