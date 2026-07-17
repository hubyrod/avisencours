import { describe, expect, test } from "bun:test";
import {
  frDateTime,
  statusAuthorLabel,
  statusAttributionLine,
  statusTooltip,
  type StatusAttributionEvent,
} from "./attribution.ts";

function evt(over: Partial<StatusAttributionEvent> = {}): StatusAttributionEvent {
  return {
    user_id: 1,
    author_name: "Ana",
    author_email: "ana@example.com",
    created_at: new Date("2026-07-17T10:55:00Z"),
    ...over,
  };
}

describe("frDateTime", () => {
  test("formate en français, fuseau Europe/Paris (UTC+2 en été)", () => {
    expect(frDateTime(new Date("2026-07-17T10:55:00Z"))).toBe("17 juillet 2026 à 12:55");
  });

  test("heure d'hiver (UTC+1)", () => {
    expect(frDateTime(new Date("2026-01-05T10:55:00Z"))).toBe("5 janvier 2026 à 11:55");
  });
});

describe("statusAuthorLabel", () => {
  test("nom affiché en priorité", () => {
    expect(statusAuthorLabel(evt())).toBe("Ana");
  });

  test("sans nom → email", () => {
    expect(statusAuthorLabel(evt({ author_name: null }))).toBe("ana@example.com");
  });

  test("utilisateur supprimé (user_id null) → « utilisateur supprimé », même si un nom traîne", () => {
    expect(statusAuthorLabel(evt({ user_id: null }))).toBe("utilisateur supprimé");
  });

  test("user_id présent mais utilisateur introuvable → « ? »", () => {
    expect(statusAuthorLabel(evt({ author_name: null, author_email: null }))).toBe("?");
  });
});

describe("statusAttributionLine (page avis)", () => {
  test("aucun événement → texte du statut par défaut", () => {
    expect(statusAttributionLine(null)).toBe("Statut par défaut — encore aucun changement.");
  });

  test("avec événement → « Défini par X le … »", () => {
    expect(statusAttributionLine(evt())).toBe("Défini par Ana le 17 juillet 2026 à 12:55");
  });

  test("auteur supprimé", () => {
    expect(statusAttributionLine(evt({ user_id: null }))).toBe(
      "Défini par utilisateur supprimé le 17 juillet 2026 à 12:55",
    );
  });
});

describe("statusTooltip (badge du tableau de bord)", () => {
  test("statut par défaut implicite → pas d'info-bulle (null, pas de title)", () => {
    expect(statusTooltip(null)).toBeNull();
  });

  test("avec événement → « défini par X le … »", () => {
    expect(statusTooltip(evt())).toBe("défini par Ana le 17 juillet 2026 à 12:55");
  });

  test("auteur supprimé", () => {
    expect(statusTooltip(evt({ user_id: null }))).toBe(
      "défini par utilisateur supprimé le 17 juillet 2026 à 12:55",
    );
  });
});
