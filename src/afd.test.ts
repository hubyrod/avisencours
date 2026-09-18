import { describe, expect, test } from "bun:test";
import { CookieJar, parseAfdDate, parseListRows, parseNextLink, parseNotice, parseTotal, toAnnouncement } from "./afd.ts";

// Extrait réel de la liste « Transports » (septembre 2026), réduit aux balises lues.
const LIST = `<td> 1-6 de 6<br/>
<a href="/tenders/brandedNoticeList.do?sub=15&amp;d-446978-p=2&amp;selPageNumber=2">2</a>&nbsp;<a href="/tenders/brandedNoticeList.do?sub=15&amp;d-446978-p=2&amp;selPageNumber=2">Suivant</a>&nbsp;
<table cellspacing="0" id="notice" class="simple" cellpadding="2">
<thead><tr><th class="col_head sortable"><a href="…">Pays</a></th><th class="col_head">Titre de l'Avis</th></tr></thead>
<tbody>
<tr class="odd">
<td class="country">
            Éthiopie
          </td>
<td>
            <a href="/tender/114844179" rel="nofollow">Procurement of Tyre</a>
          </td>
<td class="published" style="white-space: nowrap;">
              Sept 17, 2026
          </td>
<td class="deadline" style="white-space: nowrap;">
            <img src="/TEMPLATE/dgMarket/images/onedot.gif" height="1" width="1" border="0" alt="" />
              Oct 1, 2026
          </td></tr>
<tr class="even">
<td class="country">
            Comores
          </td>
<td>
            <a href="/tender/113966016">Avis d'appel public &agrave; la concurrence</a>
          </td>
<td class="published" style="white-space: nowrap;">
              Aou 31, 2026
          </td>
<td class="deadline" style="white-space: nowrap;">
              Oct 23, 2026
          </td></tr></tbody></table>`;

const NOTICE = `<div class="notice-title">
 <h1>Selection of Consultants
 </h1>
 <h4>
 Appel à Manifestation d'Intérêt
 </h4>
 </div>
<script>var x = "Pays:</td><td>piège</td>";</script>
<form name="form1" method="post">
<table cellspacing="0" border="0">
  <tr><td colspan="2" align="left"><h3>Informations générales</h3></td></tr>
  <tr>
    <td valign="top" align="right">
      Pays:&nbsp;&nbsp;</td>
    <td valign="top" align="left" width="70%">
     <a href="https://www.dgmarket.com/tenders/CountryDetail.do?locationISO=kh">Cambodge</a>
      </td>
  </tr>
    <tr>
      <td valign="top" align="right" style="white-space: nowrap;">
        Ville/Localité:&nbsp;&nbsp;
      </td>
      <td align="left">
         Phnom Penh
       </td>
    </tr>
<tr>
    <td valign="top" align="right">
      Date de publication:&nbsp;&nbsp;</td>
    <td valign="top" align="left">
      Sept 18, 2026
    </td>
  </tr>
  <tr>
    <td valign="top" align="right">
    Date limite (heure locale):&nbsp;&nbsp;</td>
    <td valign="top" align="left">
      Octobre 2, 2026 - 12:00
   </td>
  </tr>
<tr>
   <td valign="top" align="right">
    Acheteur:&nbsp;&nbsp;</td>
    <td valign="center" align="left">
      <a href="https://afd.dgmarket.com/tenders/adminShowBuyer.do?buyerId=7824586">CAMBODIA - Ministry of Post and Telecommunications</a><br/>
  </td>
</tr>
  <tr>
    <td valign="top" align="right" style="white-space: nowrap;">
      Langue d'origine:&nbsp;&nbsp;</td>
    <td valign="top" align="left">
      Anglais
  </td>
  </tr>
  <tr><td class="header" align="left" colspan="2"><h3>Texte original</h3></td></tr>
  <tr><td colspan="2" align="left"><table cellpadding="0"><tr><td >
        <div class="fixwhitespace-wrapper">
          CONSULTING SERVICES
<br/>
Expressions of Interest
<br/>
<br/>
The Ministry of Post and Telecommunications (“MPTC”) will receive a financing from AFD.
        </div>
  </td></tr></table></td></tr>
</table></form>`;

describe("AFD parseListRows", () => {
  test("lit pays, id, titre, dates", () => {
    const rows = parseListRows(LIST);
    expect(rows).toEqual([
      { id: "114844179", pays: "Éthiopie", objet: "Procurement of Tyre", publie: "Sept 17, 2026", deadline: "Oct 1, 2026" },
      { id: "113966016", pays: "Comores", objet: "Avis d'appel public à la concurrence", publie: "Aou 31, 2026", deadline: "Oct 23, 2026" },
    ]);
  });
  test("total et lien suivant", () => {
    expect(parseTotal(LIST)).toBe(6);
    expect(parseNextLink(LIST)).toBe("/tenders/brandedNoticeList.do?sub=15&d-446978-p=2&selPageNumber=2");
    expect(parseNextLink("<p>Aucun avis trouvé</p>")).toBeNull();
    expect(parseTotal("<p>Aucun avis trouvé</p>")).toBeNull();
    expect(parseListRows("<p>Aucun avis trouvé</p>")).toEqual([]);
  });
});

describe("AFD dates", () => {
  test("anglais et français, avec ou sans heure", () => {
    expect(parseAfdDate("Sept 17, 2026")).toBe("17/09/2026");
    expect(parseAfdDate("Aou 31, 2026")).toBe("31/08/2026");
    expect(parseAfdDate("Octobre 2, 2026 - 12:00")).toBe("02/10/2026 à 12h00");
    expect(parseAfdDate("Février 3, 2027 - 9:30")).toBe("03/02/2027 à 09h30");
    expect(parseAfdDate("Feb 3, 2027")).toBe("03/02/2027");
    expect(parseAfdDate("Juil 1, 2027")).toBe("01/07/2027");
    expect(parseAfdDate("Décembre 24, 2026")).toBe("24/12/2026");
  });
  test("inconnu = null", () => {
    expect(parseAfdDate("")).toBeNull();
    expect(parseAfdDate("2026-10-01")).toBeNull();
    expect(parseAfdDate("Xyz 1, 2026")).toBeNull();
  });
});

describe("AFD parseNotice", () => {
  test("champs de la fiche et texte original", () => {
    const n = parseNotice(NOTICE);
    expect(n.objet).toBe("Selection of Consultants");
    expect(n.typeAvis).toBe("Appel à Manifestation d'Intérêt");
    expect(n.pays).toBe("Cambodge");
    expect(n.ville).toBe("Phnom Penh");
    expect(n.publie).toBe("Sept 18, 2026");
    expect(n.deadline).toBe("Octobre 2, 2026 - 12:00");
    expect(n.acheteur).toBe("CAMBODIA - Ministry of Post and Telecommunications");
    expect(n.langue).toBe("Anglais");
    expect(n.texte).toBe("CONSULTING SERVICES\nExpressions of Interest\nThe Ministry of Post and Telecommunications (“MPTC”) will receive a financing from AFD.");
  });
  test("fiche vide", () => {
    expect(parseNotice("<p>rien</p>")).toEqual({
      objet: "", typeAvis: "", pays: "", ville: "", publie: "", deadline: "", acheteur: "", langue: "", texte: "",
    });
  });
});

describe("AFD toAnnouncement", () => {
  test("fiche lue : dates de la fiche, pays en département", () => {
    const a = toAnnouncement(parseListRows(LIST)[0]!, parseNotice(NOTICE));
    expect(a.idweb).toBe("AFD-114844179");
    expect(a.url).toBe("https://afd.dgmarket.com/tender/114844179");
    expect(a.objet).toBe("Selection of Consultants");
    expect(a.deadline).toBe("02/10/2026 à 12h00");
    expect(a.publishedAt).toBe("18/09/2026");
    expect(a.department).toBe("Cambodge");
    expect(a.typeAvis).toBe("AFD — Appel à Manifestation d'Intérêt");
    expect(a.source).toBe("afd");
    expect(a.famille).toBe("mobilité");
    expect(a.raw).toContain("Expressions of Interest");
    expect(a.raw).toContain("Pays: Cambodge (Phnom Penh)");
  });
  test("fiche illisible : repli sur la ligne de liste", () => {
    const a = toAnnouncement(parseListRows(LIST)[1]!, null);
    expect(a.objet).toBe("Avis d'appel public à la concurrence");
    expect(a.deadline).toBe("23/10/2026");
    expect(a.publishedAt).toBe("31/08/2026");
    expect(a.department).toBe("Comores");
    expect(a.typeAvis).toBe("AFD");
  });
});

describe("CookieJar", () => {
  test("domaine explicite, hôte par défaut, envoi aux sous-domaines", () => {
    const jar = new CookieJar();
    jar.store("web3-login.dgmarket.com", [
      "JSESSIONID=abc; Path=/; HttpOnly",
      "digi_session_id=s1; Domain=web3-login.dgmarket.com; Path=/",
      "locale_abbrev_pref=f; Domain=.dgmarket.com; Path=/",
    ]);
    jar.store("afd.dgmarket.com", ["digi_session_id=s2; Domain=afd.dgmarket.com; Path=/", "user_id=anonymous"]);
    expect(jar.header("afd.dgmarket.com").split("; ").sort()).toEqual(["digi_session_id=s2", "locale_abbrev_pref=f", "user_id=anonymous"]);
    expect(jar.header("web3-login.dgmarket.com").split("; ").sort()).toEqual(["JSESSIONID=abc", "digi_session_id=s1", "locale_abbrev_pref=f"]);
    expect(jar.header("example.com")).toBe("");
  });
  test("une valeur remplace la précédente", () => {
    const jar = new CookieJar();
    jar.store("a.b", ["k=1"]);
    jar.store("a.b", ["k=2"]);
    expect(jar.header("a.b")).toBe("k=2");
  });
});
