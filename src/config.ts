export const config = {
  headless: Bun.env.HEADLESS !== "false",
  timeoutMs: Number(Bun.env.TIMEOUT_MS ?? 30_000),
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
} as const;

export type Config = typeof config;
