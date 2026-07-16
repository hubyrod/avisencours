import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import {
  normalizeEmail,
  safeEqual,
  rateLimit,
  sessionCookieName,
  sessionSetCookie,
  sessionClearCookie,
  readSessionToken,
  isEmailDomainAllowed,
  allowedDomains,
} from "./auth.ts";

const savedDashboardUrl = Bun.env.DASHBOARD_URL;
const savedDomains = Bun.env.ALLOWED_EMAIL_DOMAINS;

beforeAll(() => {
  // Force dev mode: plain cookie name, no Secure attribute.
  delete Bun.env.DASHBOARD_URL;
});

afterAll(() => {
  Bun.env.DASHBOARD_URL = savedDashboardUrl;
  Bun.env.ALLOWED_EMAIL_DOMAINS = savedDomains;
});

describe("isEmailDomainAllowed", () => {
  test("domaine autorisé, insensible à la casse et au @ de tête", () => {
    Bun.env.ALLOWED_EMAIL_DOMAINS = " @ExplainConsultancy.com , autre.fr ";
    expect(allowedDomains()).toEqual(["explainconsultancy.com", "autre.fr"]);
    expect(isEmailDomainAllowed("Jean.Dupont@ExplainConsultancy.com")).toBeTrue();
    expect(isEmailDomainAllowed("x@autre.fr")).toBeTrue();
    expect(isEmailDomainAllowed("x@gmail.com")).toBeFalse();
    expect(isEmailDomainAllowed("x@sub.explainconsultancy.com")).toBeFalse();
    expect(isEmailDomainAllowed("pasdemail")).toBeFalse();
  });

  test("aucun domaine configuré → tout refusé", () => {
    delete Bun.env.ALLOWED_EMAIL_DOMAINS;
    expect(isEmailDomainAllowed("x@explainconsultancy.com")).toBeFalse();
  });
});

describe("normalizeEmail", () => {
  test("minuscules et espaces", () => {
    expect(normalizeEmail("  Hugo.Venturini@GMAIL.com ")).toBe("hugo.venturini@gmail.com");
  });
});

describe("safeEqual", () => {
  test("égalité et différences", () => {
    expect(safeEqual("abc", "abc")).toBeTrue();
    expect(safeEqual("abc", "abd")).toBeFalse();
    expect(safeEqual("abc", "abcd")).toBeFalse();
    expect(safeEqual("", "")).toBeTrue();
  });
});

describe("rateLimit", () => {
  test("bloque au-delà du plafond dans la fenêtre", () => {
    const key = `test:${Math.random()}`;
    expect(rateLimit(key, 3, 60_000)).toBeTrue();
    expect(rateLimit(key, 3, 60_000)).toBeTrue();
    expect(rateLimit(key, 3, 60_000)).toBeTrue();
    expect(rateLimit(key, 3, 60_000)).toBeFalse();
  });

  test("clés indépendantes", () => {
    const a = `test:${Math.random()}`;
    const b = `test:${Math.random()}`;
    expect(rateLimit(a, 1, 60_000)).toBeTrue();
    expect(rateLimit(b, 1, 60_000)).toBeTrue();
  });
});

describe("session cookie (mode dev)", () => {
  test("nom, attributs et expiration", () => {
    expect(sessionCookieName()).toBe("session");
    const set = sessionSetCookie("tok123");
    expect(set).toStartWith("session=tok123;");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Max-Age=2592000");
    expect(set).not.toContain("Secure");
    expect(sessionClearCookie()).toContain("Max-Age=0");
  });

  test("readSessionToken extrait le bon cookie", () => {
    const req = new Request("http://x/", {
      headers: { cookie: "other=1; session=abc123; more=2" },
    });
    expect(readSessionToken(req)).toBe("abc123");
    expect(readSessionToken(new Request("http://x/"))).toBeNull();
  });
});
