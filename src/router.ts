// Minimal path matcher: ":name" segments capture (URL-decoded), everything
// else must match exactly. Returns the captured params, or null on mismatch.
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  if (!pattern.includes(":")) return pattern === pathname ? {} : null;
  const patternSegs = pattern.split("/");
  const pathSegs = pathname.split("/");
  if (patternSegs.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i]!;
    const x = pathSegs[i]!;
    if (p.startsWith(":")) {
      if (!x) return null;
      try {
        params[p.slice(1)] = decodeURIComponent(x);
      } catch {
        return null;
      }
    } else if (p !== x) {
      return null;
    }
  }
  return params;
}
