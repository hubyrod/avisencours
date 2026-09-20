import { describe, expect, test } from "bun:test";
import { decouperRaw, estEforms, structurerTexte } from "./avis-texte.ts";

describe("decouperRaw", () => {
  test("BOAMP : objet répété écarté, description gardée, étiquettes connues ignorées", () => {
    const objet = "Élaboration du plan de mobilité simplifié";
    const raw = `${objet} — ${objet} — Étude en trois phases : diagnostic, scénarios, plan d'actions. — Acheteur: CC du Val — Département: 26 — Type d'avis: Avis de marché — Procédure: MAPA`;
    expect(decouperRaw(raw, objet)).toEqual({
      description: ["Étude en trois phases : diagnostic, scénarios, plan d'actions."],
      precisions: [],
    });
  });
  test("achatpublic / Maximilien : CPV, lieu, lots deviennent des précisions", () => {
    const objet = "Étude de circulation";
    const raw = `${objet} — Le présent marché porte sur… — CPV: 71311200 - Conseil en transport — Acheteur: Ville — Lieu: Gard — Nature: Services — Contrat: Accord-cadre — Lots: 2`;
    expect(decouperRaw(raw, objet)).toEqual({
      description: ["Le présent marché porte sur…"],
      precisions: [["CPV", "71311200 - Conseil en transport"], ["Lieu", "Gard"], ["Contrat", "Accord-cadre"], ["Lots", "2"]],
    });
  });
  test("texte vide ou absent", () => {
    expect(decouperRaw(null, "x")).toEqual({ description: [], precisions: [] });
    expect(decouperRaw("x", "x")).toEqual({ description: [], precisions: [] });
  });
});

describe("structurerTexte (eForms aplati)", () => {
  const texte =
    "1. Acheteur 1.1 Acheteur Nom officiel: IRCEM agirc-arrco Forme juridique de l'acheteur: Organisme de droit public, contrôlé par une autorité publique centrale Activité du pouvoir adjudicateur: Protection sociale 2. Procédure 2.1 Procédure Titre: Mise en oeuvre d'une offre de service territoriale pour préserver la mobilité des seniors Description: Via le présent marché, le Groupe IRCEM souhaite confier au Titulaire la conception, l'organisation et l'animation d'une offre de service territoriale. Identifiant de la procédure: 17745041-a59b Type de procédure: Ouverte La procédure est accélérée: non 2.1.1 Objet Nature principale du marché: Services Nomenclature principale (cpv): 85000000 Services de santé et services sociaux 2.1.3 Valeur Valeur estimée hors TVA: 0 Euro 2.1.4 Informations générales Base juridique: Directive 2014/24/UE 5.1.12 Conditions du marché public Date limite de réception des offres: 21/09/2026 12:00 +02:00 Durée de validité";
  test("sections, titres, champs et résumé", () => {
    const s = structurerTexte(texte)!;
    expect(s).not.toBeNull();
    expect(s.sections.map((x) => `${x.numero} ${x.titre}`)).toEqual([
      "1 Acheteur",
      "1.1 Acheteur",
      "2 Procédure",
      "2.1 Procédure",
      "2.1.1 Objet",
      "2.1.3 Valeur",
      "2.1.4 Informations générales",
      "5.1.12 Conditions du marché public",
    ]);
    expect(s.sections[1]!.champs).toEqual([
      { label: "Nom officiel", valeur: "IRCEM agirc-arrco" },
      { label: "Forme juridique de l'acheteur", valeur: "Organisme de droit public, contrôlé par une autorité publique centrale" },
      { label: "Activité du pouvoir adjudicateur", valeur: "Protection sociale" },
    ]);
    expect(s.sections[3]!.champs.map((c) => c.label)).toEqual(["Titre", "Description", "Identifiant de la procédure", "Type de procédure", "La procédure est accélérée"]);
    // « 0 Euro » n'ouvre pas une section ; la valeur reste entière.
    expect(s.sections[5]!.champs).toEqual([{ label: "Valeur estimée hors TVA", valeur: "0 Euro" }]);
    expect(s.sections[7]!.champs[0]).toEqual({ label: "Date limite de réception des offres", valeur: "21/09/2026 12:00 +02:00 Durée de validité" });
    const long = structurerTexte("1. Acheteur Nom officiel: X 5.1.12 Conditions Soumission par voie électronique: Autorisée Langues dans lesquelles les offres ou demandes de participation/candidatures peuvent être présentées: français Variantes: Non autorisée")!;
    expect(long.sections[1]!.champs.map((c) => c.label)).toEqual(["Soumission par voie électronique", "Langues dans lesquelles les offres ou demandes de participation/candidatures peuvent être présentées", "Variantes"]);
    expect(s.resume).toBe("Via le présent marché, le Groupe IRCEM souhaite confier au Titulaire la conception, l'organisation et l'animation d'une offre de service territoriale.");
  });
  test("texte libre : pas de structure", () => {
    expect(structurerTexte("Étude de circulation du centre-ville, en deux phases. Rendu attendu en mars.")).toBeNull();
    expect(estEforms("Lot 1 : études. Nom officiel: x")).toBe(false);
  });
});

describe("structurerTexte (avis national BOAMP aplati)", () => {
  const texte =
    "Avis de marché Département(s) de publication : 30 Annonce n° 26-76236 Services Section 1 - Identification de l'acheteur Nom complet de l'acheteur : Sm Eptb Vistre Vistrenque Numéro national d'indentification : SIRET N° National d'identification : 20009089200015 Ville : RODILHAN Code postal : 30230 Groupement de commandes : Non Section 2 - Communication Lien direct aux documents de la consultation : https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematent.login&type=Dce&Idm=1856298 Identifiant interne de la consultation : 2026-10 Section 3 - Procédure Type de procédure : Procédure adaptée ouverte Technique d'achat : Accord-cadre Date et heure limite de réception des plis : 21/09/2026 à 12:00 Section 4 - Identification du marché Intitulé du marché : Etude de la vulnérabilité des infrastructures primaires d'alimentation en eau potable (AEP) - Action 5.6 du PAPI 3 Vistre Code CPV principal - Descripteur principal : 71335000 Type de marché : Services Description succincte du marché : L'accord-cadre sera exécuté par émission de bons de commande. Cette étude s'inscrit au PAPI 3 Vistre.";
  test("sections « Section N - », champs « Libellé : valeur », résumé = description succincte", () => {
    const s = structurerTexte(texte)!;
    expect(s).not.toBeNull();
    expect(s.sections.map((x) => `${x.numero}|${x.titre}`)).toEqual([
      "|Avis de marché",
      "1|Identification de l'acheteur",
      "2|Communication",
      "3|Procédure",
      "4|Identification du marché",
    ]);
    expect(s.sections[0]!.champs[0]).toEqual({ label: "Département(s) de publication", valeur: "30 Annonce n° 26-76236 Services" });
    // « Type de Numéro national… » n'est pas reconnu comme libellé (mot capitalisé
    // au milieu) : « Type de » reste dans la valeur précédente — imperfection assumée.
    expect(s.sections[1]!.champs.map((c) => c.label)).toEqual([
      "Nom complet de l'acheteur", "Numéro national d'indentification", "N° National d'identification", "Ville", "Code postal", "Groupement de commandes",
    ]);
    expect(s.sections[1]!.champs[0]!.valeur).toBe("Sm Eptb Vistre Vistrenque Type de");
    expect(s.sections[1]!.champs[2]!.valeur).toBe("20009089200015");
    expect(s.sections[3]!.champs).toEqual([
      { label: "Type de procédure", valeur: "Procédure adaptée ouverte" },
      { label: "Technique d'achat", valeur: "Accord-cadre" },
      { label: "Date et heure limite de réception des plis", valeur: "21/09/2026 à 12:00" },
    ]);
    expect(s.sections[4]!.champs.map((c) => c.label)).toEqual(["Intitulé du marché", "Code CPV principal - Descripteur principal", "Type de marché", "Description succincte du marché"]);
    expect(s.resume).toBe("L'accord-cadre sera exécuté par émission de bons de commande. Cette étude s'inscrit au PAPI 3 Vistre.");
  });
});
