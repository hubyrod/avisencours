import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { buildApiUrl } from "./params.ts";

const saved = { url: Bun.env.PORTAL_API_URL, dataset: Bun.env.PORTAL_DATASET };

beforeAll(() => {
  Bun.env.PORTAL_API_URL = "https://portal.example/api/explore/v2.1/catalog/datasets";
  Bun.env.PORTAL_DATASET = "boamp";
});

afterAll(() => {
  Bun.env.PORTAL_API_URL = saved.url;
  Bun.env.PORTAL_DATASET = saved.dataset;
});

describe("buildApiUrl", () => {
  test("compose base URL, dataset et pagination", () => {
    const url = buildApiUrl({ query: "", rows: 100, start: 200 });
    expect(url).toStartWith("https://portal.example/api/explore/v2.1/catalog/datasets/boamp/records?");
    expect(url).toContain("limit=100");
    expect(url).toContain("offset=200");
  });

  test("les termes OR deviennent des search() combinés", () => {
    const url = buildApiUrl({ query: 'mobilité OR "schéma directeur"' });
    const where = decodeURIComponent(url.split("where=")[1]!);
    expect(where).toContain('search(*, "mobilité")');
    expect(where).toContain('search(*, "schéma directeur")');
    expect(where).toContain(" OR ");
  });

  test("le filtre de date couvre datelimitereponse et datefindiffusion", () => {
    const url = buildApiUrl({ query: "vélo", deadlineFrom: "2026-07-16" });
    const where = decodeURIComponent(url.split("where=")[1]!);
    expect(where).toContain("datelimitereponse>=date'2026-07-16'");
    expect(where).toContain("datefindiffusion>=date'2026-07-16'");
    expect(where).toContain(" AND ");
  });

  test("type_marche devient un refine", () => {
    const url = buildApiUrl({ query: "", typeMarche: ["SERVICES"] });
    expect(url).toContain(`refine=${encodeURIComponent("type_marche:SERVICES")}`);
  });

  test("code_departement devient un refine", () => {
    const url = buildApiUrl({ query: "", codeDepartement: ["31", "2A"] });
    expect(url).toContain(`refine=${encodeURIComponent("code_departement:31")}`);
    expect(url).toContain(`refine=${encodeURIComponent("code_departement:2A")}`);
  });
});
