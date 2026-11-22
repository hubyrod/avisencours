import { describe, expect, test } from "bun:test";
import {
  auteurHistorique,
  changementsAvis,
  grouperParJour,
  jourLabel,
  phraseHistorique,
  phraseSuppression,
  type AvisEtat,
  type HistoriqueEntry,
} from "./historique.ts";

const etat = (extra: Partial<AvisEtat> = {}): AvisEtat => ({
  idweb: "B1",
  deadline_text: "12/11/2026 à 12h00",
  category: "relevant",
  type_avis: "Avis de marché",
  ...extra,
});

const entry = (extra: Partial<HistoriqueEntry> = {}): HistoriqueEntry => ({
  id: 1,
  created_at: new Date("2026-11-20T10:00:00Z"),
  idweb: "B1",
  kind: "statut",
  user_id: 7,
  user_label: "Marie Dupont",
  status_label: "répondu",
  status_color: "#1d4ed8",
  from_status_label: "à évaluer",
  from_status_color: "#626d66",
  avant: null,
  apres: null,
  detail: null,
  ...extra,
});

describe("changementsAvis", () => {
  test("rien ne change : aucune entrée", () => {
    expect(changementsAvis(etat(), etat())).toEqual([]);
  });

  test("échéance : espaces ignorés, changement réel noté avec l'avant et l'après", () => {
    expect(changementsAvis(etat(), etat({ deadline_text: " 12/11/2026  à 12h00 " }))).toEqual([]);
    expect(changementsAvis(etat(), etat({ deadline_text: "26/11/2026 à 12h00" }))).toEqual([
      { idweb: "B1", kind: "echeance", avant: "12/11/2026 à 12h00", apres: "26/11/2026 à 12h00", detail: null },
    ]);
  });

  test("échéance apparue : notée ; échéance disparue : lecture incomplète, pas d'entrée", () => {
    expect(changementsAvis(etat({ deadline_text: null }), etat())).toEqual([
      { idweb: "B1", kind: "echeance", avant: null, apres: "12/11/2026 à 12h00", detail: null },
    ]);
    expect(changementsAvis(etat(), etat({ deadline_text: null }))).toEqual([]);
    expect(changementsAvis(etat(), etat({ deadline_text: "" }))).toEqual([]);
  });

  test("reclassement : libellés français et motif du nouveau classement", () => {
    expect(changementsAvis(etat(), etat({ category: "excluded", reason: "règle : toujours exclure « autocar »" }))).toEqual([
      { idweb: "B1", kind: "categorie", avant: "pertinent", apres: "exclu", detail: "règle : toujours exclure « autocar »" },
    ]);
  });

  test("rectificatif : seulement quand il apparaît", () => {
    const rectif = etat({ type_avis: "Avis de marché - rectificatif" });
    expect(changementsAvis(etat(), rectif).map((c) => c.kind)).toEqual(["rectificatif"]);
    expect(changementsAvis(rectif, rectif)).toEqual([]);
    expect(changementsAvis(rectif, etat())).toEqual([]);
  });

  test("plusieurs changements dans le même run", () => {
    const kinds = changementsAvis(etat(), etat({ deadline_text: "01/12/2026 à 17h00", category: "travaux", type_avis: "Avis - rectificatif" })).map((c) => c.kind);
    expect(kinds).toEqual(["echeance", "categorie", "rectificatif"]);
  });
});

describe("auteurHistorique", () => {
  test("nom recopié ; compte supprimé signalé ; veille ; auteur d'avant le journal", () => {
    expect(auteurHistorique(entry())).toBe("Marie Dupont");
    expect(auteurHistorique(entry({ user_id: null }))).toBe("Marie Dupont (compte supprimé)");
    expect(auteurHistorique(entry({ user_id: null, user_label: null }))).toBe("utilisateur supprimé");
    expect(auteurHistorique(entry({ kind: "echeance", user_id: null, user_label: null }))).toBe("La veille");
  });
});

describe("phraseHistorique", () => {
  test("changement de statut : ancien → nouveau", () => {
    expect(phraseHistorique(entry())).toEqual({
      qui: "Marie Dupont",
      veille: false,
      texte: "a changé le statut",
      de: { label: "à évaluer", color: "#626d66" },
      vers: { label: "répondu", color: "#1d4ed8" },
    });
  });

  test("statut sans ancien connu, statut disparu", () => {
    const p = phraseHistorique(entry({ from_status_label: null, from_status_color: null, status_label: null, status_color: null }));
    expect(p.texte).toBe("a défini le statut");
    expect(p.de).toBeUndefined();
    expect(p.vers).toEqual({ label: "statut supprimé", color: "#626d66" });
  });

  test("entrées de la veille", () => {
    const veille = { user_id: null, user_label: null, status_label: null, from_status_label: null };
    expect(phraseHistorique(entry({ ...veille, kind: "echeance", avant: "12/11/2026 à 12h00", apres: "26/11/2026 à 12h00" })).texte).toBe(
      "Échéance modifiée : 12/11/2026 à 12h00 → 26/11/2026 à 12h00",
    );
    expect(phraseHistorique(entry({ ...veille, kind: "echeance", apres: "26/11/2026" })).texte).toBe("Échéance précisée : 26/11/2026");
    const reclasse = phraseHistorique(entry({ ...veille, kind: "categorie", avant: "pertinent", apres: "exclu", detail: "transport scolaire" }));
    expect(reclasse).toMatchObject({ qui: "La veille", veille: true, texte: "Reclassé : pertinent → exclu", precision: "transport scolaire" });
    expect(phraseHistorique(entry({ ...veille, kind: "rectificatif" })).texte).toBe("Rectificatif publié par l'acheteur");
    expect(phraseHistorique(entry({ ...veille, kind: "doublon", detail: "Publication Marchés Online rattachée à cet avis" })).texte).toBe(
      "Publication Marchés Online rattachée à cet avis",
    );
  });
});

describe("phraseSuppression", () => {
  const le = new Date("2026-11-03T09:00:00Z");
  test("son propre commentaire, celui d'un autre, celui d'un compte supprimé", () => {
    expect(phraseSuppression(true, "Marie", le)).toBe("a supprimé son commentaire du 3 novembre 2026");
    expect(phraseSuppression(false, "Marie", le)).toBe("a supprimé un commentaire de Marie du 3 novembre 2026");
    expect(phraseSuppression(false, null, le)).toBe("a supprimé un commentaire de un utilisateur supprimé du 3 novembre 2026");
  });
});

describe("regroupement par jour (heure de Paris)", () => {
  const now = new Date("2026-11-22T10:00:00Z");
  test("aujourd'hui, hier, puis la date", () => {
    expect(jourLabel(new Date("2026-11-22T07:00:00Z"), now)).toBe("Aujourd'hui");
    expect(jourLabel(new Date("2026-11-21T12:00:00Z"), now)).toBe("Hier");
    expect(jourLabel(new Date("2026-11-19T12:00:00Z"), now)).toBe("19 novembre 2026");
    // 23h30 UTC le 21 = 0h30 le 22 à Paris.
    expect(jourLabel(new Date("2026-11-21T23:30:00Z"), now)).toBe("Aujourd'hui");
  });

  test("les entrées consécutives du même jour sont regroupées, l'ordre est conservé", () => {
    const e = (id: number, iso: string) => ({ id, created_at: new Date(iso) });
    const groupes = grouperParJour([e(3, "2026-11-22T09:00:00Z"), e(2, "2026-11-22T08:00:00Z"), e(1, "2026-11-20T08:00:00Z")], now);
    expect(groupes.map((g) => [g.jour, g.entries.map((x) => x.id)])).toEqual([
      ["Aujourd'hui", [3, 2]],
      ["20 novembre 2026", [1]],
    ]);
  });
});
