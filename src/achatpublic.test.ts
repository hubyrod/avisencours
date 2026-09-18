import { describe, expect, test } from "bun:test";
import { parseCards, parseCardDeadline, parseFiche, parsePagination, toAnnouncement } from "./achatpublic.ts";
import { classifyFamille, keywordRegex, matchKeywords } from "./familles.ts";
import { departementCodes } from "./departements.ts";

// Extrait d'une page de résultats réelle (septembre 2026), réduit aux balises lues.
const CARD = `
<ul class="sdmListResult__mainList">
<li id="li_consult_CSL_2026_48eQGEibtE" class="jqTriggableCard sdmCardConsult " tabindex="0" role="link">
  <h2 class="sdmCardGeneric__title">
    <a href="/sdm/ent2/gen/ficheCsl.action?PCSLID=CSL_2026_48eQGEibtE&ongletActif=2" class="jqCardLink sdmCardGeneric__topLink" tabindex="0">
      Prestations de nettoyage des locaux R&eacute;gie de stationnement</a>
  </h2>
  <div class="sdmCardConsult__blocTime" style="color: red" >
    <span class="sdmCardConsult__numberTime textLatoBold--24">24</span>
    <span class="sdmCardConsult__ddyyyy textLatoReg--14">Sept. 2026</span>
    <span class="sdmCardConsult__preciseTime textLatoReg--14">12 : 00</span>
  </div>
  <ul class="sdmCardConsult__list">
    <li class="sdmCardConsult__listItem" >
      <span class="textLatoBold--14">Organisme :</span>
      <span class="jqShave same-content-title">Ville d&#39;Alès</span >
    </li>
    <li class="sdmCardConsult__listItem">
      <span class="textLatoBold--14">Référence :</span>
      <span class="jqShave same-content-title">2026-S-NETTPAR</span>
    </li>
    <li class="sdmCardConsult__listItem">
      <span class="textLatoBold--14">Lots : </span>
      <span class="jqShave same-content-title"> 2 </span>
    <li class="sdmCardConsult__listItem infobulle" aria-label="Services">
      <span class="textLatoBold--14">Nature des prestations : </span>
      <span class="jqShave same-content-title">Services</span>
    </li>
    <li class="sdmCardConsult__listItem infobulle" aria-label="Procédure adaptée ouverte">
      <span class="textLatoBold--14">Type de procédure : </span>
      <span class="jqShave same-content-title">Procédure adaptée ouverte</span>
    </li>
    <li class="sdmCardConsult__listItem">
      <span class="textLatoBold--14">  Type de contrat&nbsp;: </span>
      <span>Accord-cadre</span>
    </li>
    <li class="sdmCardConsult__listItem infobulle" aria-label="Lieu d'exécution" tabindex="0" role="link">
      <span class="textLatoBold--14">Lieu d'exécution : </span>
      <span class="jqShave lieuExec" id='lieuxxxxCSL_2026_48eQGEibtE' role="link" tabindex="0">

          Gard

      </span>
    </li>
  </ul>
</li>
<li id="li_consult_CSL_2026_Oqt4Bl1MGt" class="jqTriggableCard sdmCardConsult " tabindex="0" role="link">
  <h2 class="sdmCardGeneric__title">
    <a href="/sdm/ent2/gen/ficheCsl.action?PCSLID=CSL_2026_Oqt4Bl1MGt&ongletActif=2" class="jqCardLink sdmCardGeneric__topLink" tabindex="0">
      Étude de plan de mobilité simplifié</a>
  </h2>
  <div class="sdmCardConsult__blocTime">
    <span class="sdmCardConsult__numberTime textLatoBold--24">7</span>
    <span class="sdmCardConsult__ddyyyy textLatoReg--14">Oct. 2026</span>
    <span class="sdmCardConsult__preciseTime textLatoReg--14">12 : 00</span>
  </div>
  <ul class="sdmCardConsult__list">
    <li class="sdmCardConsult__listItem" >
      <span class="textLatoBold--14">Organisme :</span>
      <span class="jqShave same-content-title">Tours Métropole Val de Loire</span >
    </li>
    <li class="sdmCardConsult__listItem infobulle" aria-label="Lieu d'exécution" tabindex="0" role="link">
      <span class="textLatoBold--14">Lieu d'exécution : </span>
      <span class="jqShave lieuExec" id='lieuxxxxCSL_2026_Oqt4Bl1MGt' role="link" tabindex="0">
        75 - Paris 77 - Seine-et-Marne 78 - Yvelines
      </span>
    </li>
  </ul>
</li>
</ul>
<ul class=" jqSortByBloc sdmPagi__list" id="top_pagination">
  &nbsp;&nbsp; Page 2 / 4
</ul>`;

describe("achatpublic parseCards", () => {
  test("lit les champs d'une carte", () => {
    const cards = parseCards(CARD);
    expect(cards).toHaveLength(2);
    const c = cards[0]!;
    expect(c.pcslid).toBe("CSL_2026_48eQGEibtE");
    expect(c.objet).toBe("Prestations de nettoyage des locaux Régie de stationnement");
    expect(c.deadline).toBe("24/09/2026 à 12h00");
    expect(c.organisme).toBe("Ville d'Alès");
    expect(c.reference).toBe("2026-S-NETTPAR");
    expect(c.lots).toBe("2");
    expect(c.nature).toBe("Services");
    expect(c.procedure).toBe("Procédure adaptée ouverte");
    expect(c.typeContrat).toBe("Accord-cadre");
    expect(c.lieu).toBe("Gard");
  });

  test("tolère les champs absents et les lieux multiples", () => {
    const c = parseCards(CARD)[1]!;
    expect(c.objet).toBe("Étude de plan de mobilité simplifié");
    expect(c.deadline).toBe("07/10/2026 à 12h00");
    expect(c.reference).toBe("");
    expect(c.lieu).toBe("75 - Paris 77 - Seine-et-Marne 78 - Yvelines");
  });

  test("pagination", () => {
    expect(parsePagination(CARD)).toEqual({ page: 2, pages: 4 });
    expect(parsePagination("<p>1 consultation</p>")).toEqual({ page: 1, pages: 1 });
  });

  test("entités Windows-1252 et nommées", () => {
    const html = CARD.replace("Prestations de nettoyage des locaux R&eacute;gie de stationnement", "Ma&icirc;trise d'&#140;uvre &#8211; mise en &#156;uvre l&#146;an &Eacute;t&eacute; &euro;");
    expect(parseCards(html)[0]!.objet).toBe("Maîtrise d'Œuvre – mise en œuvre l'an Été €");
  });

  test("page vide = aucune carte", () => {
    expect(parseCards("<p>Aucune consultation ne correspond aux critères choisis.</p>")).toEqual([]);
  });
});

describe("achatpublic dates", () => {
  test("mois abrégés français", () => {
    expect(parseCardDeadline("3", "Janv. 2027", "10 : 30")).toBe("03/01/2027 à 10h30");
    expect(parseCardDeadline("15", "Févr. 2027", "9 : 05")).toBe("15/02/2027 à 09h05");
    expect(parseCardDeadline("1", "Juin 2027", "12 : 00")).toBe("01/06/2027 à 12h00");
    expect(parseCardDeadline("31", "Juil. 2027", "12 : 00")).toBe("31/07/2027 à 12h00");
    expect(parseCardDeadline("20", "Août 2027", "12 : 00")).toBe("20/08/2027 à 12h00");
    expect(parseCardDeadline("2", "Déc. 2026", "16 : 00")).toBe("02/12/2026 à 16h00");
  });
  test("format inattendu = null", () => {
    expect(parseCardDeadline("", "Sept. 2026", "12 : 00")).toBeNull();
    expect(parseCardDeadline("24", "2026", "12 : 00")).toBeNull();
    expect(parseCardDeadline("24", "Xyz. 2026", "12 : 00")).toBeNull();
  });
});

describe("achatpublic parseFiche", () => {
  const FICHE = `<html><body><script>var x = "Description : piège";</script>
    <div>Voir la description</div><p>Description : <b>Étude de circulation</b> et de stationnement du centre-ville</p>
    <p>Code CPV recherché : 71311200 - Services de conseil en systèmes de transport.</p>
    <p>Date d'ouverture de la salle : 27 juillet 2026 16:23 (heure de Paris)</p>
    <p>Date limite de remise des plis : 24 septembre 2026 12:00 (heure de Paris)</p></body></html>`;
  test("description, CPV, date d'ouverture", () => {
    expect(parseFiche(FICHE)).toEqual({
      description: "Étude de circulation et de stationnement du centre-ville",
      cpv: "71311200 - Services de conseil en systèmes de transport.",
      ouverture: "27 juillet 2026 16:23",
    });
  });
  test("fiche sans ces sections", () => {
    expect(parseFiche("<p>Consultation clôturée</p>")).toEqual({ description: "", cpv: "", ouverture: "" });
  });
});

describe("achatpublic toAnnouncement", () => {
  test("assemble un Announcement achatpublic", () => {
    const card = parseCards(CARD)[1]!;
    const a = toAnnouncement(card, { description: "Élaboration du PDMS", cpv: "71311200", ouverture: "1 septembre 2026 09:00" }, "mobilité");
    expect(a.idweb).toBe("CSL_2026_Oqt4Bl1MGt");
    expect(a.url).toContain("ficheCsl.action?PCSLID=CSL_2026_Oqt4Bl1MGt");
    expect(a.department).toBe("75, 77, 78");
    expect(a.source).toBe("achatpublic");
    expect(a.famille).toBe("mobilité");
    expect(a.publishedAt).toBe("1 septembre 2026 09:00");
    expect(a.raw).toContain("Élaboration du PDMS");
    expect(a.raw).toContain("CPV: 71311200");
    expect(a.typeAvis).toBe("Consultation achatpublic (?)");
  });
});

describe("departementCodes", () => {
  test("nom simple, variantes d'orthographe", () => {
    expect(departementCodes("Gard")).toEqual(["30"]);
    expect(departementCodes("Indre et Loire")).toEqual(["37"]);
    expect(departementCodes("Haute Loire")).toEqual(["43"]);
    expect(departementCodes("Côte-d'Or")).toEqual(["21"]);
    expect(departementCodes("Ile de la Réunion")).toEqual(["974"]);
  });
  test("liste codée, région, vide", () => {
    expect(departementCodes("59 - Nord 62 - Pas-de-Calais 80 - Somme")).toEqual(["59", "62", "80"]);
    expect(departementCodes("France Métropolitaine")).toEqual([]);
    expect(departementCodes("Auvergne-Rhône-Alpes")).toEqual([]);
    expect(departementCodes("")).toEqual([]);
  });
});

describe("familles keywords", () => {
  test("début de mot, pas sous-chaîne", () => {
    expect(keywordRegex("vélo").test("achat de velos")).toBe(true);
    expect(keywordRegex("vélo").test("developpement web")).toBe(false);
    expect(keywordRegex("cyclable").test("schema directeur cyclables")).toBe(true);
    expect(keywordRegex("model").test("modelisation du trafic")).toBe(true);
  });
  test("sigles et mots courts = mot entier", () => {
    expect(keywordRegex("AMC").test("etude amc du projet")).toBe(true);
    expect(keywordRegex("AMC").test("amcor emballages")).toBe(false);
    expect(keywordRegex("gare").test("pole gare")).toBe(true);
    expect(keywordRegex("gare").test("garenne")).toBe(false);
    expect(keywordRegex("PDM").test("elaboration du pdm")).toBe(true);
  });
  test("expressions et tirets", () => {
    expect(keywordRegex("voie verte").test("amenagement de la voie  verte")).toBe(true);
    expect(keywordRegex("multi-critère").test("analyse multi critere")).toBe(true);
    expect(keywordRegex("prévention des inondations").test("programme de prevention des inondations")).toBe(true);
  });
  test("matchKeywords renvoie les termes trouvés", () => {
    expect(matchKeywords("Étude de stationnement et plan vélo", ["vélo", "stationnement", "gare"])).toEqual([
      "vélo",
      "stationnement",
    ]);
  });
});

describe("classifyFamille", () => {
  const base = {
    idweb: "x", url: "", publishedAt: "", deadline: null, department: "", acheteur: "",
    typeAvis: "", procedure: "", source: "achatpublic" as const,
  };
  test("mobilité = classifieurs habituels", () => {
    expect(classifyFamille("mobilité", { ...base, objet: "Plan de mobilité", raw: "", famille: "mobilité" })).toBeNull();
  });
  test("kiomda : compteurs vélo/piéton gardés, autres fournitures exclues", () => {
    expect(classifyFamille("kiomda", { ...base, objet: "Fourniture de compteurs vélo", raw: "", famille: "kiomda" })?.category).toBe("relevant");
    expect(classifyFamille("kiomda", { ...base, objet: "Fourniture de capteurs de comptage piétons", raw: "", famille: "kiomda" })?.category).toBe("relevant");
    expect(classifyFamille("kiomda", { ...base, objet: "Fourniture de compteurs d'eau", raw: "", famille: "kiomda" })?.category).toBe("excluded");
    expect(classifyFamille("kiomda", { ...base, objet: "Acquisition de vélos électriques", raw: "", famille: "kiomda" })?.category).toBe("excluded");
  });
  test("les règles ne lisent que l'intitulé (le descriptif cite « marché », « travaux »…)", () => {
    const raw = "Le présent marché porte sur la fourniture… véhicules de service… travaux de pose";
    expect(classifyFamille("kiomda", { ...base, objet: "Fourniture de compteurs d'eau", raw, famille: "kiomda" })?.category).toBe("excluded");
    expect(classifyFamille("inondations", { ...base, objet: "Étude pour la mise en place d'un PAPI 2", raw, famille: "inondations" })?.category).toBe("relevant");
  });
  test("inondations : étude gardée, travaux écartés", () => {
    expect(classifyFamille("inondations", { ...base, objet: "AMC du PAPI de la Vézère", raw: "", famille: "inondations" })?.category).toBe("relevant");
    expect(classifyFamille("inondations", { ...base, objet: "Travaux de protection contre les inondations (PAPI)", raw: "", famille: "inondations" })?.category).toBe("travaux");
  });
});
