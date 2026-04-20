import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.ts";

export type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

export async function openSession(): Promise<Session> {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ userAgent: config.userAgent });
  context.setDefaultTimeout(config.timeoutMs);
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
