import type { Page } from "playwright";
import { buildSearchUrl } from "./params.ts";
import type { SearchParams } from "./params.ts";

export type Announcement = {
  idweb: string;
  url: string;
  publishedAt: string;
  deadline: string | null;
  objet: string;
  department: string;
  acheteur: string;
  typeAvis: string;
  procedure: string;
  raw: string;
};

export type ScrapeOptions = {
  maxPages?: number;
  pageSize?: number;
  onPage?: (pageNum: number, items: Announcement[]) => void;
};

const CARD = ".card-notification.fr-callout";
const NO_RESULT = "[ng-if*='nhits == 0'], .no-result, .ods-results-no-result";

export async function scrapeAll(
  page: Page,
  params: SearchParams,
  opts: ScrapeOptions = {},
): Promise<Announcement[]> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const pageSize = opts.pageSize ?? 10;

  const all: Announcement[] = [];
  let pageNum = 1;
  let start = 0;

  while (pageNum <= maxPages) {
    const url = buildSearchUrl({ ...params, start });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const found = await Promise.race([
      page
        .locator(CARD)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "cards" as const)
        .catch(() => null),
      page
        .locator(NO_RESULT)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "empty" as const)
        .catch(() => null),
    ]);

    if (found !== "cards") break;

    const items = await extractItems(page);
    if (items.length === 0) break;

    all.push(...items);
    opts.onPage?.(pageNum, items);

    if (items.length < pageSize) break;
    start += pageSize;
    pageNum++;
  }

  return all;
}

async function extractItems(page: Page): Promise<Announcement[]> {
  return page.locator(CARD).evaluateAll((cards) => {
    const text = (el: Element | null): string =>
      (el?.textContent ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

    return cards.map((c) => {
      const idLabel = text(c.querySelector("[ng-bind*='idweb']"));
      const idweb = idLabel.replace(/^Avis n°\s*/, "");

      const link =
        (c.querySelector("a.fr-btn[href*='idweb']") as HTMLAnchorElement | null) ??
        (c.querySelector("a[href*='idweb']") as HTMLAnchorElement | null);

      const publishedAt = text(c.querySelector("[ng-bind*='Publié le']")).replace(
        /^Publié le\s*/,
        "",
      );

      const deadlineText = text(c.querySelector("[ng-init*='DATE_LIMITE_REPONSE']"));
      const deadlineMatch = deadlineText.match(
        /Date limite de réponse le (\d{2}\/\d{2}\/\d{4}(?: à \d{1,2}h\d{2})?)/,
      );

      const objet = text(c.querySelector("[ng-bind-html*='objet']"));

      const department = Array.from(c.querySelectorAll("[ng-repeat*='tab_dept']"))
        .map((el) => text(el))
        .filter(Boolean)
        .join(", ");

      const acheteur = text(c.querySelector("[ng-bind-html*='nomacheteur']"));

      const natureBase = text(c.querySelector("[ng-bind*='nature_libelle']"));
      const rectif = text(c.querySelector("[ng-if*=\"'RECTIFICATIF'\"]"));
      const annul = text(c.querySelector("[ng-if*=\"'ANNULATION'\"]"));
      const rectifAnnul = text(c.querySelector("[ng-if*=\"'RECTIFANNUL'\"]"));
      const typeAvis = [natureBase, rectif, annul, rectifAnnul].filter(Boolean).join(" ").trim();

      const procedure = text(c.querySelector("[ng-bind*='procedure_libelle']"));

      const raw = (c.textContent ?? "").replace(/\s+/g, " ").trim();

      return {
        idweb,
        url: link?.href ?? "",
        publishedAt,
        deadline: deadlineMatch?.[1] ?? null,
        objet,
        department,
        acheteur,
        typeAvis,
        procedure,
        raw,
      };
    });
  });
}
