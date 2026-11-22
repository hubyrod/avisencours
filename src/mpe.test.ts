import { describe, expect, test } from "bun:test";
import { MPE_SITES, MpeBlockedError, departementsFromLieux, estBlocage, parseFiche, parsePageState, parsePagination, parseRows, scrapeMpe, toAnnouncement } from "./mpe.ts";

const MAXIMILIEN = MPE_SITES.find((s) => s.source === "maximilien")!;
const AMPA = MPE_SITES.find((s) => s.source === "ampa")!;

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

describe("MPE parseRows", () => {
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

describe("MPE parseFiche", () => {
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

describe("MPE departementsFromLieux", () => {
  test("codes, Corse, France entière", () => {
    expect(departementsFromLieux("(75) Paris, (77) Seine-et-Marne")).toBe("75, 77");
    expect(departementsFromLieux("(2A) Corse-du-Sud, (974) La Réunion")).toBe("2A, 974");
    expect(departementsFromLieux("")).toBe("");
    const all = Array.from({ length: 20 }, (_, i) => `(${String(i + 1).padStart(2, "0")}) X`).join(", ");
    expect(departementsFromLieux(all)).toBe("France entière");
  });
});

describe("MPE toAnnouncement", () => {
  test("assemble un Announcement", () => {
    const row = parseRows(LIST)[1]!;
    const a = toAnnouncement(row, { typeAnnonce: "Avis d'appel public à la concurrence", cpv: "71311200", objet: "" }, "mobilité", MAXIMILIEN);
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
  test("autre site MPE : préfixe, URL et source propres", () => {
    const a = toAnnouncement(parseRows(LIST)[0]!, { typeAnnonce: "", cpv: "", objet: "" }, "mobilité", AMPA);
    expect(a.idweb).toBe("AMPA-932590");
    expect(a.url).toBe("https://demat-ampa.fr/entreprise/consultation/932590?orgAcronyme=a2w");
    expect(a.source).toBe("ampa");
    expect(a.typeAvis).toBe("Consultation AMPA (demat-ampa.fr) (Services)");
  });
});

// --- Parcours de la liste contre un site PRADO simulé -------------------------------
// Le faux site reproduit ce qui a cassé en production : la liste arrive par 10,
// chaque page porte un état différent (et différent d'un serveur à l'autre), et
// un pare-feu refuse certaines requêtes d'après l'état qu'elles renvoient, en
// servant sa page « Accès refusé » en 200 après redirection.
const SIZE = "ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop";
const GOTO = "ctl0$CONTENU_PAGE$resultSearch$DefaultButtonTop";
const NEXT = "ctl0$CONTENU_PAGE$resultSearch$PagerTop$ctl2";
const REFUS = `<html><h1>Accès refusé</h1><p>La requête a été bloquée</p><p>Le système de détection d'intrusion a bloqué votre requête.</p></html>`;

function fauxSite(opts: { rows: number; annonces?: number; bloque?: (etat: string, serveur: number) => boolean; serveurs?: number }) {
  const ids = Array.from({ length: opts.rows }, (_, i) => String(1000 + i));
  const etats: string[] = []; // états renvoyés par le scraper, dans l'ordre
  const cibles: string[] = [];
  let sessions = 0;
  const ligne = (id: string) => `
<div class="item_consultation list-group-item">
  <input type="hidden" name="ctl0$CONTENU_PAGE$resultSearch$tableauResultSearch$ctl1$refCons" value="${id}" />
  <input type="hidden" name="ctl0$CONTENU_PAGE$resultSearch$tableauResultSearch$ctl1$orgCons" value="org" />
  <div class="cons_categorie"><span>Services</span></div>
  <!-- BEGIN REFERENCE | INTITULE --><div><span data-toggle="tooltip" title="Plan de mobilité ${id}">x</span></div><!--END REFERENCE | INTITULE-->
</div>`;
  const pageHtml = (serveur: number, taille: number, page: number) => {
    const pages = Math.max(1, Math.ceil(ids.length / taille));
    return `<input type="hidden" name="PRADO_PAGESTATE" id="PRADO_PAGESTATE" value="s${serveur}-t${taille}-p${page}" />
<span id="ctl0_CONTENU_PAGE_resultSearch_nombreElement">${opts.annonces ?? ids.length}</span>
<input name="ctl0$CONTENU_PAGE$resultSearch$numPageTop" type="text" value="${page}" id="n" />
<span id="ctl0_CONTENU_PAGE_resultSearch_nombrePageTop">${pages}</span>
${ids.slice((page - 1) * taille, page * taille).map(ligne).join("")}`;
  };
  const client = {
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      if (url.includes("/entreprise/consultation/")) return new Response("Type d'annonce : Annonce de consultation Procédure : x");
      const cookie = (init.headers as Record<string, string>).cookie ?? "";
      if (init.method !== "POST") {
        const serveur = sessions++ % (opts.serveurs ?? 1);
        return new Response(pageHtml(serveur, 10, 1), { headers: { "set-cookie": `SERVERID=${serveur}; path=/` } });
      }
      // Sans cookie de session, le vrai site répond 400.
      const m = cookie.match(/SERVERID=(\d+)/);
      if (!m) return new Response("Bad Request", { status: 400 });
      const serveur = Number(m[1]);
      const f = new URLSearchParams(String(init.body));
      const etat = f.get("PRADO_PAGESTATE") ?? "";
      const cible = f.get("PRADO_POSTBACK_TARGET") ?? "";
      etats.push(etat);
      cibles.push(cible);
      if (opts.bloque?.(etat, serveur)) return new Response(REFUS);
      const e = etat.match(/^s(\d+)-t(\d+)-p(\d+)$/);
      // Un état d'un autre serveur est illisible pour celui-ci.
      if (!e || Number(e[1]) !== serveur) return new Response("Page state is corrupted.", { status: 400 });
      const taille = Number(f.get(SIZE));
      const num = Number(f.get("ctl0$CONTENU_PAGE$resultSearch$numPageTop"));
      const page = cible === SIZE ? 1 : cible === GOTO ? num : cible === NEXT ? Number(e[3]) + 1 : NaN;
      return new Response(pageHtml(serveur, taille, page));
    },
  };
  return { client, etats, cibles, ids, sessions: () => sessions };
}

const SEARCHES = [{ famille: "mobilité" as const, marche: "services" as const, keywords: ["mobilité"] }];
const lire = (site: ReturnType<typeof fauxSite>) => scrapeMpe({ site: MAXIMILIEN, searches: SEARCHES, client: site.client });

describe("MPE scrapeMpe : parcours de la liste", () => {
  test("toutes les consultations sont lues, y compris les rangs 11 à 20", async () => {
    const site = fauxSite({ rows: 403 });
    const items = await lire(site);
    expect(items.length).toBe(403);
    expect(items.map((i) => i.idweb)).toEqual(site.ids.map((id) => `MX-${id}`));
    // Rangs 11–20 : sautés quand le premier « suivant » passait de 10 à 20 par page.
    expect(items.slice(10, 20).map((i) => i.idweb)).toEqual(site.ids.slice(10, 20).map((id) => `MX-${id}`));
  });

  test("un seul état sert à demander toutes les pages (aucun enchaînement de « suivant »)", async () => {
    const site = fauxSite({ rows: 403 });
    await lire(site);
    expect(site.etats[0]).toBe("s0-t10-p1");
    expect(site.cibles[0]).toBe(SIZE);
    // 20 pages demandées depuis l'état de la page 1 à 20 lignes.
    expect(site.etats.slice(1)).toEqual(Array(20).fill("s0-t20-p1"));
    expect(new Set(site.cibles.slice(1))).toEqual(new Set([GOTO]));
    expect(site.cibles).not.toContain(NEXT);
  });

  test("liste tenant sur une page, liste vide", async () => {
    expect((await lire(fauxSite({ rows: 7 }))).length).toBe(7);
    expect(await lire(fauxSite({ rows: 0 }))).toEqual([]);
  });

  test("état de la page 1 refusé par le pare-feu sur un serveur : nouvelle session sur l'autre", async () => {
    const site = fauxSite({ rows: 403, serveurs: 2, bloque: (etat) => etat === "s0-t20-p1" });
    const logs: string[] = [];
    const items = await scrapeMpe({ site: MAXIMILIEN, searches: SEARCHES, client: site.client, log: (m) => logs.push(m) });
    expect(items.length).toBe(403);
    expect(site.sessions()).toBe(2);
    expect(logs.join("\n")).toContain("requête bloquée par le pare-feu du site — nouvelle session (2/3)");
  });

  test("refus sur une page en cours de route : l'état de la page précédente prend le relais", async () => {
    let refus = 0;
    const site = fauxSite({ rows: 403, bloque: (etat) => etat === "s0-t20-p1" && ++refus === 13 });
    const items = await lire(site);
    expect(items.length).toBe(403);
    expect(site.sessions()).toBe(1);
    expect(site.etats).toContain("s0-t20-p13");
  });

  test("pare-feu qui refuse tout : l'erreur le dit, sans parler de pagination", async () => {
    const site = fauxSite({ rows: 403, bloque: () => true });
    const err = await lire(site).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MpeBlockedError);
    expect((err as Error).message).toBe("requête bloquée par le pare-feu du site");
    expect((err as Error).message).not.toContain("pagination");
    // Trois sessions essayées, une requête refusée chacune : le refus n'est pas rejoué.
    expect(site.sessions()).toBe(3);
    expect(site.etats.length).toBe(3);
  });

  test("liste incomplète : échec explicite plutôt que des avis qui disparaissent en silence", async () => {
    const err = await lire(fauxSite({ rows: 393, annonces: 403 })).catch((e: unknown) => e);
    expect((err as Error).message).toBe("liste incomplète (393 consultations lues sur 403 annoncées)");
    // Quelques clôtures pendant la lecture restent tolérées.
    expect((await lire(fauxSite({ rows: 400, annonces: 403 }))).length).toBe(400);
  });

  test("estBlocage : URL de redirection ou page de refus, pas une page de liste", () => {
    expect(estBlocage("https://marches.maximilien.fr/forbidden/index.html?uid=abc", "")).toBe(true);
    expect(estBlocage("", REFUS)).toBe(true);
    expect(estBlocage("https://marches.maximilien.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons", LIST)).toBe(false);
  });
});
