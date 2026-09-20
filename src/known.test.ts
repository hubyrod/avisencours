import { describe, expect, test } from "bun:test";
import { KNOWN_MAX_AGE_MS, knownIndex, reusable, toAnnouncement, type KnownAnnouncement } from "./known.ts";

const now = Date.parse("2026-09-20T08:00:00Z");
const known: KnownAnnouncement = {
  idweb: "MO-1",
  url: "https://www.marchesonline.com/appels-offres/avis/x/ao-1-2",
  publishedAt: "18/09/2026",
  deadline: "09/10/2026",
  objet: "Étude de plan de mobilité",
  department: "93",
  acheteur: "SNCF",
  typeAvis: "Avis Marchés Online (Études)",
  procedure: "Procédure adaptée",
  raw: "Étude de plan de mobilité — descriptif complet",
  source: "marchesonline",
  famille: "mobilité",
  lastSeenAt: new Date(now - 24 * 3600_000),
};

describe("known.reusable", () => {
  test("même URL, intitulé et date limite, vu récemment : réutilisable", () => {
    expect(reusable(known, { url: known.url, objet: known.objet, deadline: "09/10/2026" }, now)).toBe(true);
  });
  test("nouvelle version (URL), intitulé ou date limite modifiés : relire", () => {
    expect(reusable(known, { url: known.url.replace(/-2$/, "-3"), objet: known.objet, deadline: known.deadline }, now)).toBe(false);
    expect(reusable(known, { url: known.url, objet: "Autre intitulé", deadline: known.deadline }, now)).toBe(false);
    expect(reusable(known, { url: known.url, objet: known.objet, deadline: "10/10/2026" }, now)).toBe(false);
    expect(reusable(known, { url: known.url, objet: known.objet, deadline: null }, now)).toBe(false);
  });
  test("champ omis non comparé ; date limite absente des deux côtés = égale", () => {
    expect(reusable(known, { url: known.url }, now)).toBe(true);
    expect(reusable({ ...known, deadline: null }, { url: known.url, deadline: null }, now)).toBe(true);
  });
  test("trop ancien ou jamais daté : relire", () => {
    expect(reusable({ ...known, lastSeenAt: new Date(now - KNOWN_MAX_AGE_MS - 1) }, { url: known.url }, now)).toBe(false);
    expect(reusable({ ...known, lastSeenAt: null }, { url: known.url }, now)).toBe(false);
  });
  test("toAnnouncement retire la date de vue ; knownIndex indexe par idweb", () => {
    expect((toAnnouncement(known) as Record<string, unknown>).lastSeenAt).toBeUndefined();
    const lookup = knownIndex([toAnnouncement(known), { ...toAnnouncement(known), idweb: "" }], new Date(now));
    expect(lookup("MO-1")?.lastSeenAt?.getTime()).toBe(now);
    expect(lookup("")).toBeUndefined();
    expect(lookup("MO-2")).toBeUndefined();
  });
});
