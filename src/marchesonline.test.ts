import { describe, expect, test } from "bun:test";
import { keywordSlug, listUrl, parseCards, parseCount, parseFiche, toAnnouncement } from "./marchesonline.ts";

// Deux cartes réelles (septembre 2026), réduites ; la première est aussi
// répétée dans un commentaire HTML (ancienne mise en page) comme sur le site.
const CARD1 = `<div class="mt-6 box-shadow-neutral-2 border-default px-4 py-6 lg:p-6 flex justify-between">
 <div class="w-9/12 lg:w-10/12">
 <div class="text-m font-medium text-neutral-base pr-6">
 <a href="/appels-offres/acheteurs/centre-diocesain-pape-francois-C556561">
 CENTRE DIOCESAIN PAPE FRANCOIS
 </a>
 </div>
 <h2 class="mt-4 lg:mt-2 text-xm lg:text-l lg:w-4/5 pr-6 font-bold" itemprop="about">
 <a href="/appels-offres/avis/rehabilitation-du-grand-podium-de-notre-dame-du-laus-en/ao-4326776-1" class="jqUpdateLink text-secondary-base">
 REHABILITATION DU GRAND PODIUM de NOTRE DAME DU LAUS en un espace Cultuel et Culturel.
 </a>
 </h2>
 <div class="hidden lg:block mt-2 text-s font-medium text-neutral-base">
 AO-2639-5253</div>
 <div class="lg:flex mt-6 lg:items-center text-neutral-base text-s lg:text-m font-medium">
 <a href="/appels-offres/lieu/auvergne-rhone-alpes-R82/loire-D43"> <div class="flex items-center mt-4 lg:mt-0 lg:mr-8">
 <svg/>
 <span class="ml-2">
 42 -
 Saint-Étienne
 </span>
 </div>
 </a> <div class="flex items-center mt-4 lg:mt-0 lg:mr-8" v-if="item.domainOfActivity">
 <svg/>
 <span class="ml-2">Travaux de bâtiment</span>
 </div>
 <div class="flex items-center mt-4 lg:mt-0 lg:mr-8" v-if="item.procedure">
 <svg/>
 <span class="ml-2">Procédure adaptée</span>
 </div>
 </div>
 <div class="mt-4 lg:mt-6 lg:flex text-s lg:text-m font-medium text-neutral-base lg:divide-x lg:divide-neutral-light">
 <div class="lg:pr-4">Mise en ligne : 18/09/2026</div>
 <div class="mt-4 lg:mt-0 lg:pl-4" v-if="item.limitDate">Limite de réponse : <span class="font-bold text-primary-dark"> 09/10/2026 </span></div>
 </div>
 </div>
 </div>`;
const CARD2 = `<div class="mt-6 box-shadow-neutral-2 border-default px-4 py-6 lg:p-6 flex justify-between">
 <a href="/appels-offres/acheteurs/sncf-campus-etoiles-siege-C480239">
 SNCF Campus Etoiles (si&egrave;ge)
 </a>
 <h2 itemprop="about">
 <a href="/appels-offres/avis/etude-de-plan-de-mobilite/ao-4325932-2" class="jqUpdateLink text-secondary-base">
 Étude de plan de mobilité employeur.
 </a>
 </h2>
 <div class="hidden lg:block mt-2 text-s font-medium text-neutral-base">
 AO-2639-4409</div>
 <a href="/appels-offres/lieu/ile-de-france-R11/seine-saint-denis-D94"> <div class="flex items-center mt-4 lg:mt-0 lg:mr-8">
 <svg/>
 <span class="ml-2">
 93 -
 SNCF
 </span>
 </div>
 </a> <div class="flex items-center mt-4 lg:mt-0 lg:mr-8" v-if="item.domainOfActivity">
 <svg/>
 <span class="ml-2">Etudes, Maîtrise d'oeuvre, Contrôle</span>
 </div>
 <div class="lg:pr-4">Mise en ligne : 18/09/2026</div>
 </div>`;
const PAGE = `<html><body><div>Recherche : 176 avis</div>
<!-- ${CARD1} -->
${CARD1}
${CARD2}
<div class="pagination-container">1 2 3</div></body></html>`;

describe("Marchés Online parseCards", () => {
  test("lit deux cartes, ignore la copie en commentaire", () => {
    const cards = parseCards(PAGE);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({
      id: "4326776",
      path: "/appels-offres/avis/rehabilitation-du-grand-podium-de-notre-dame-du-laus-en/ao-4326776-1",
      numero: "AO-2639-5253",
      objet: "REHABILITATION DU GRAND PODIUM de NOTRE DAME DU LAUS en un espace Cultuel et Culturel.",
      acheteur: "CENTRE DIOCESAIN PAPE FRANCOIS",
      departement: "42",
      ville: "Saint-Étienne",
      activite: "Travaux de bâtiment",
      procedure: "Procédure adaptée",
      publie: "18/09/2026",
      deadline: "09/10/2026",
    });
  });
  test("carte sans procédure ni date limite", () => {
    const c = parseCards(PAGE)[1]!;
    expect(c.id).toBe("4325932");
    expect(c.objet).toBe("Étude de plan de mobilité employeur.");
    expect(c.acheteur).toBe("SNCF Campus Etoiles (siège)");
    expect(c.departement).toBe("93");
    expect(c.activite).toBe("Etudes, Maîtrise d'oeuvre, Contrôle");
    expect(c.procedure).toBe("");
    expect(c.deadline).toBeNull();
  });
  test("compte et page vide", () => {
    expect(parseCount(PAGE)).toBe(176);
    expect(parseCount("<div>en cours : 17 012 avis</div>")).toBe(17012);
    expect(parseCount("<p>Aucun avis pour cette recherche.</p>")).toBeNull();
    expect(parseCards("<p>Aucun avis pour cette recherche.</p>")).toEqual([]);
  });
});

describe("Marchés Online URLs", () => {
  test("slug et pagination", () => {
    expect(keywordSlug("mobilité")).toBe("mobilite");
    expect(keywordSlug("voie verte")).toBe("voie-verte");
    expect(keywordSlug("prévention des inondations")).toBe("prevention-des-inondations");
    expect(keywordSlug("ZFE")).toBe("zfe");
    expect(listUrl("vélo", 1)).toBe("https://www.marchesonline.com/appels-offres/top-recherches/velo");
    expect(listUrl("vélo", 3)).toBe("https://www.marchesonline.com/appels-offres/top-recherches/velo?page=3");
  });
});

describe("Marchés Online parseFiche", () => {
  const FICHE = `<html><body><div id="print_area_title"><h1>Titre</h1></div>
  <div id="print_area"><div class="siAvisArchive"></div><div class="text-l">Descriptif</div>
  <span class="sourceSansImg"> Source : WEB </span>
  <div>France: Services d'ingénierie <b>Étude</b> de circulation Avis de marché 2.1.1 Objet Nature principale du marché: Services Nomenclature principale (cpv): 71311200 Services de conseil en systèmes de transport 2.1.2 Lieu</div>
  <script>var x = "Descriptif piège";</script>
  <div>Ces recherches peuvent vous intéresser</div><ul><li>autre</li></ul></div></body></html>`;
  test("descriptif nettoyé et CPV", () => {
    const f = parseFiche(FICHE);
    expect(f.descriptif).toBe("France: Services d'ingénierie Étude de circulation Avis de marché 2.1.1 Objet Nature principale du marché: Services Nomenclature principale (cpv): 71311200 Services de conseil en systèmes de transport 2.1.2 Lieu");
    expect(f.cpv).toBe("71311200 Services de conseil en systèmes de transport");
  });
  test("descriptif long coupé à la fin d'une phrase", () => {
    const phrase = "Une phrase de test qui fait un peu de longueur. ";
    const long = `<div id="print_area">Descriptif ${phrase.repeat(400)}</div>`;
    const { descriptif } = parseFiche(long);
    expect(descriptif.length).toBeLessThanOrEqual(12_000);
    expect(descriptif.endsWith(".")).toBe(true);
  });
  test("fiche sans zone imprimable", () => {
    expect(parseFiche("<p>rien</p>")).toEqual({ descriptif: "", cpv: "" });
  });
});

describe("Marchés Online toAnnouncement", () => {
  test("assemble un Announcement", () => {
    const a = toAnnouncement(parseCards(PAGE)[1]!, { descriptif: "Plan de mobilité employeur du site.", cpv: "71311200" }, "mobilité");
    expect(a.idweb).toBe("MO-4325932");
    expect(a.url).toBe("https://www.marchesonline.com/appels-offres/avis/etude-de-plan-de-mobilite/ao-4325932-2");
    expect(a.department).toBe("93");
    expect(a.acheteur).toBe("SNCF Campus Etoiles (siège)");
    expect(a.typeAvis).toBe("Avis Marchés Online (Études)");
    expect(a.raw).toContain("Nature: Études");
    expect(a.raw).not.toContain("Maîtrise d'oeuvre");
    expect(a.source).toBe("marchesonline");
    expect(a.deadline).toBeNull();
    expect(a.raw).toContain("Plan de mobilité employeur du site.");
    expect(a.raw).toContain("Lieu: 93 - SNCF");
  });
});
