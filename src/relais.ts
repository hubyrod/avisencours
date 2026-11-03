// Lecture relayée d'une source, depuis une autre adresse que le serveur :
//
//   POSTGRESQL_ADDON_URI=… bun run src/relais.ts marchesonline
//
// Marchés Online (Cloudflare) renvoie 403 à l'adresse de l'hébergeur depuis
// le 10/10/2026. Ce script tourne sur GitHub Actions
// (.github/workflows/relais-marchesonline.yml, 03:00 UTC), lit la source
// avec la configuration de la base (mots-clés actifs de la liste, plafond de
// pages, avis déjà connus pour ne pas relire les fiches) et dépose la liste
// dans la table `relais`. Le run quotidien (04:30 UTC) la reprend si elle a
// moins de 20 h (PipelineOptions.relais), sinon il lit le site directement.
// Ne doit pas importer live.ts (pas de moteur Skip hors du serveur).
import { migrate, listKeywords, listSettings, loadKnownAnnouncements, saveRelais } from "./db.ts";
import { searchesByListe } from "./rules.ts";
import { scrapeMarchesOnline } from "./marchesonline.ts";
import { DEFAULT_LISTES } from "./defaults.ts";
import { isSource, sourceLabel } from "./sources.ts";
import { errMessage } from "./http.ts";
import type { Announcement, Source } from "./scraper.ts";

type Lecteur = (log: (m: string) => void) => Promise<Announcement[]>;

async function lecteur(source: Source): Promise<Lecteur> {
  const [keywords, settings, known] = await Promise.all([
    listKeywords().then((rows) => rows.filter((k) => k.enabled)),
    listSettings(),
    loadKnownAnnouncements(),
  ]);
  const searches = searchesByListe(keywords);
  switch (source) {
    case "marchesonline": {
      const raw = settings.marchesonline_max_pages;
      const maxPagesPerKeyword = raw && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined;
      return (log) =>
        scrapeMarchesOnline({ searches: searches.marchesonline ?? DEFAULT_LISTES.marchesonline, maxPagesPerKeyword, log, known });
    }
    default:
      throw new Error(`aucun relais défini pour la source « ${source} »`);
  }
}

async function main(): Promise<void> {
  const arg = Bun.argv[2];
  if (!isSource(arg) || arg === "boamp") {
    throw new Error(`usage : bun run src/relais.ts <source secondaire> (reçu : ${arg ?? "rien"})`);
  }
  await migrate();
  const lire = await lecteur(arg);
  const t0 = Date.now();
  const items = await lire((m) => console.error(m));
  const detail = `${items.length} avis en ${Math.round((Date.now() - t0) / 1000)} s`;
  await saveRelais(arg, items, detail);
  console.error(`${sourceLabel(arg)} : ${detail} — déposés dans relais`);
}

main()
  .catch((err) => {
    console.error(`relais : ${errMessage(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
