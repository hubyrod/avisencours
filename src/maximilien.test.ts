import { describe, expect, test } from "bun:test";
import { departementsFromLieux, parseFiche, parsePageState, parsePagination, parseRows, toAnnouncement } from "./maximilien.ts";

// Extrait réel de la liste « AllCons » (septembre 2026), réduit aux balises lues.
const LIST = `
<span id="ctl0_CONTENU_PAGE_resultSearch_nombreElement">439</span>
<input name="ctl0$CONTENU_PAGE$resultSearch$numPageTop" type="text" value="2" id="ctl0_CONTENU_PAGE_resultSearch_numPageTop" class="form-control w-50 text-center" />
<label class="nb-total ">/ <span id="ctl0_CONTENU_PAGE_resultSearch_nombrePageTop">44</span></label>
<div class="item_consultation list-group-item kt-callout left kt-vertical-align   ">
  <input type="hidden" name="ctl0$CONTENU_PAGE$resultSearch$tableauResultSearch$ctl1$refCons" id="x" value="932590" />
  <input type="hidden" name="ctl0$CONTENU_PAGE$resultSearch$tableauResultSearch$ctl1$orgCons" id="y" value="a2w" />
  <div class="cons_procedure">
    <abbr data-toggle="tooltip" data-placement="top" title="Système d'Acquisition Dynamique"><span>SAD-A</span></abbr>
  </div>
  <div id="p" class="cons_categorie">
    <span>Services</span>
  </div>
  <div class="date date-min clearfix">
    <div class="day"><span>27</span></div>
    <div class="month-year"><div class="month"><span>Mars</span></div><div class="year"><span>2026</span></div></div>
  </div>
  <!-- BEGIN REFERENCE | INTITULE -->
  <div class="m-b-1 clearfix">
    <div class="small pull-left">
      26U044
    </div>
    <span class="pull-left m-l-1 m-r-1">|</span>
    <div class="small pull-left truncate">
      <span data-toggle="tooltip"
        title="Prestations de conversion de motorisation de v&eacute;hicules  ">
        Prestations de conversion…
      </span>
    </div>
  </div>
  <!--END REFERENCE | INTITULE-->
  <!-- BEGIN OBJET -->
  <div id="o" class="m-b-1 clearfix">
    <div data-toggle="tooltip" class="truncate-700"
       title="Prestations de conversion de motorisation de véhicules et de reconditionnement ">
      <span class="h5"><strong>Objet : </strong></span>
    </div>
  </div>
  <!-- END OBJET -->
  <!-- BEGIN ORGANISME -->
  <div id="d" class="m-b-1">
    <div data-toggle="tooltip" class="truncate-700"
       title="UGAP (77420 - CHAMPS-SUR-MARNE)">
      <span class="h5"><strong>Organisme : </strong></span>
    </div>
  </div>
  <!-- END ORGANISME -->
  <li><div class="lots"><a href="#"><i class="fa fa-cubes"></i><span>11&nbsp;lots</span></a></div></li>
  <!-- BEGIN LIEUX EXE -->
  <div id="l" class="lieux-exe">
    <span>
      <i class="fa fa-map-marker text-danger" aria-hidden="true"></i>
      <span> (67) Bas-Rhin,  (68) Haut-Rhin</span>
<span data-toggle="popover" class="btn-link" title="" data-content="(67) Bas-Rhin, (68) Haut-Rhin, (75) Paris">...</span>
    </span>
  </div>
  <!-- END LIEUX EXE -->
  <div class="col-md-1 top cons_dateEnd col-60">
    <div class="cloture-line">
      <div class="date clearfix ">
        <div class="day "><span>30</span></div>
        <div class="month-year "><div class="month"><span>Avril</span></div><div class="year"><span>2036</span></div></div>
      </div>
      <div class="time clearfix text-center m-t-1"><i class="fa fa-clock-o"></i><label title="Durée" alt="Durée">17:00</label></div>
    </div>
  </div>
</div>
<div class="item_consultation list-group-item kt-callout left kt-vertical-align   ">
  <input type="hidden" name="r" value="1" />
  <input type="hidden" name="ctl0$CONTENU_PAGE$resultSearch$tableauResultSearch$ctl2$refCons" id="x2" value="940001" />
  <input type="hidden" name="ctl0$CONTENU_PAGE$resultSearch$tableauResultSearch$ctl2$orgCons" id="y2" value="ville-de-x" />
  <div class="cons_procedure"><abbr title="Procédure adaptée"><span>MAPA</span></abbr></div>
  <div class="cons_categorie"><span>Services</span></div>
  <div class="date date-min clearfix">
    <div class="day"><span>3</span></div>
    <div class="month-year"><div class="month"><span>Septembre</span></div><div class="year"><span>2026</span></div></div>
  </div>
  <!-- BEGIN REFERENCE | INTITULE -->
  <div class="small pull-left">26-PDM</div>
  <span data-toggle="tooltip" title="Élaboration du plan de mobilité simplifié">…</span>
  <!--END REFERENCE | INTITULE-->
  <!-- BEGIN OBJET -->
  <div class="truncate-700" title="Étude pour l'élaboration du plan de mobilité simplifié de la communauté">x</div>
  <!-- END OBJET -->
  <!-- BEGIN ORGANISME -->
  <div class="truncate-700" title="CC du Val (78000 - VERSAILLES)">x</div>
  <!-- END ORGANISME -->
  <!-- BEGIN LIEUX EXE -->
  <div class="lieux-exe"><span><i class="fa"></i><span> (78) Yvelines</span></span></div>
  <!-- END LIEUX EXE -->
  <div class="cloture-line">
    <div class="date clearfix "><div class="day "><span>9</span></div>
    <div class="month-year "><div class="month"><span>Octobre</span></div><div class="year"><span>2026</span></div></div></div>
    <div class="time"><label title="Durée" alt="Durée">12:00</label></div>
  </div>
</div>
<input type="text" style="display:none" autocomplete="off" name="PRADO_PAGESTATE" id="PRADO_PAGESTATE" value="eJztfUtz40iS" />`;

describe("Maximilien parseRows", () => {
  test("lit une consultation complète", () => {
    const rows = parseRows(LIST);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "932590",
      org: "a2w",
      procedure: "Système d'Acquisition Dynamique",
      categorie: "Services",
      publie: "27/03/2026",
      reference: "26U044",
      intitule: "Prestations de conversion de motorisation de véhicules",
      objet: "Prestations de conversion de motorisation de véhicules et de reconditionnement",
      organisme: "UGAP (77420 - CHAMPS-SUR-MARNE)",
      lieux: "(67) Bas-Rhin, (68) Haut-Rhin, (75) Paris",
      lots: "11",
      deadline: "30/04/2036 à 17h00",
    });
  });
  test("lieu court, sans lots, jour à un chiffre", () => {
    const r = parseRows(LIST)[1]!;
    expect(r.id).toBe("940001");
    expect(r.org).toBe("ville-de-x");
    expect(r.procedure).toBe("Procédure adaptée");
    expect(r.publie).toBe("03/09/2026");
    expect(r.intitule).toBe("Élaboration du plan de mobilité simplifié");
    expect(r.lieux).toBe("(78) Yvelines");
    expect(r.lots).toBe("");
    expect(r.deadline).toBe("09/10/2026 à 12h00");
  });
  test("pagination et état PRADO", () => {
    expect(parsePagination(LIST)).toEqual({ page: 2, pages: 44, total: 439 });
    expect(parsePagination("<p>rien</p>")).toEqual({ page: 1, pages: 1, total: null });
    expect(parsePageState(LIST)).toBe("eJztfUtz40iS");
    expect(parsePageState("<p>rien</p>")).toBeNull();
    expect(parseRows("<p>Aucun résultat</p>")).toEqual([]);
  });
});

describe("Maximilien parseFiche", () => {
  const FICHE = `<html><body><script>var s = "Objet : piège";</script>
    <div>Détail de la consultation</div>
    <p>Référence : 26U044</p><p>Intitulé : Prestations</p>
    <p>Objet : Prestations de <b>conversion</b> complètes</p>
    <p>Organisme : UGAP</p><p>Entité publique : UGAP</p>
    <p>Type d'annonce : Avis d'appel public à la concurrence</p><p>Procédure : </p>
    <p>Catégorie principale : Services</p>
    <p>Code CPV : 50117100 (Code principal) 50117300 34210000</p>
    <p>Temps restant pour répondre : 12 jours</p></body></html>`;
  test("type d'annonce, CPV, objet complet", () => {
    expect(parseFiche(FICHE)).toEqual({
      typeAnnonce: "Avis d'appel public à la concurrence",
      cpv: "50117100 (principal) 50117300 34210000",
      objet: "Prestations de conversion complètes",
    });
  });
  test("fiche vide", () => {
    expect(parseFiche("<p>rien</p>")).toEqual({ typeAnnonce: "", cpv: "", objet: "" });
  });
});

describe("Maximilien departementsFromLieux", () => {
  test("codes, Corse, France entière", () => {
    expect(departementsFromLieux("(75) Paris, (77) Seine-et-Marne")).toBe("75, 77");
    expect(departementsFromLieux("(2A) Corse-du-Sud, (974) La Réunion")).toBe("2A, 974");
    expect(departementsFromLieux("")).toBe("");
    const all = Array.from({ length: 20 }, (_, i) => `(${String(i + 1).padStart(2, "0")}) X`).join(", ");
    expect(departementsFromLieux(all)).toBe("France entière");
  });
});

describe("Maximilien toAnnouncement", () => {
  test("assemble un Announcement", () => {
    const row = parseRows(LIST)[1]!;
    const a = toAnnouncement(row, { typeAnnonce: "Avis d'appel public à la concurrence", cpv: "71311200", objet: "" }, "mobilité");
    expect(a.idweb).toBe("MX-940001");
    expect(a.url).toBe("https://marches.maximilien.fr/entreprise/consultation/940001?orgAcronyme=ville-de-x");
    expect(a.objet).toBe("Élaboration du plan de mobilité simplifié");
    expect(a.deadline).toBe("09/10/2026 à 12h00");
    expect(a.publishedAt).toBe("03/09/2026");
    expect(a.department).toBe("78");
    expect(a.acheteur).toBe("CC du Val (78000 - VERSAILLES)");
    expect(a.typeAvis).toBe("Consultation Maximilien — Avis d'appel public à la concurrence (Services)");
    expect(a.source).toBe("maximilien");
    expect(a.raw).toContain("Étude pour l'élaboration du plan de mobilité simplifié");
    expect(a.raw).toContain("CPV: 71311200");
  });
});
