import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // ---- TEMPORARY DEBUG: report config problems instead of crashing ----
  const problems: string[] = [];
  if (!url) problems.push("NEXT_PUBLIC_SUPABASE_URL is MISSING (undefined at runtime)");
  else {
    if (!/^https:\/\//.test(url)) problems.push(`URL doesn't start with https:// — starts with "${url.slice(0, 12)}"`);
    if (!/supabase\.co\/?$/.test(url.trim())) problems.push(`URL doesn't end with supabase.co — ends with "${url.slice(-14)}"`);
    if (url !== url.trim()) problems.push("URL has leading/trailing whitespace");
    if (/["']/.test(url)) problems.push("URL contains quote characters");
  }
  if (!key) problems.push("NEXT_PUBLIC_SUPABASE_ANON_KEY is MISSING (undefined at runtime)");
  else {
    if (!key.trim().startsWith("eyJ") && !key.trim().startsWith("sb_")) problems.push(`Key doesn't look like an anon key — starts with "${key.slice(0, 6)}"`);
    if (key !== key.trim()) problems.push("Key has leading/trailing whitespace");
    if (/\s/.test(key.trim())) problems.push("Key contains a space or line break in the middle");
  }
  if (problems.length > 0) {
    return new Response(
      "PORTAL CONFIG PROBLEM:\n\n- " + problems.join("\n- ") +
      "\n\nFix the environment variable(s) in Vercel, redeploy, and this message disappears.",
      { status: 500, headers: { "content-type": "text/plain" } }
    );
  }
  // ---- END DEBUG BLOCK ----

  try {
    let response = NextResponse.next({ request });
    const supabase = createServerClient(url!, key!, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    const { data: { user } } = await supabase.auth.getUser();
    const isLogin = request.nextUrl.pathname.startsWith("/login");
    if (!user && !isLogin) return NextResponse.redirect(new URL("/login", request.url));
    if (user && isLogin) return NextResponse.redirect(new URL("/", request.url));
    return response;
  } catch (e) {
    return new Response(
      "PORTAL RUNTIME PROBLEM:\n\n" + (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
      "\n\nSend this message to Claude.",
      { status: 500, headers: { "content-type": "text/plain" } }
    );
  }
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
