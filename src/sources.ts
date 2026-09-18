// Registre des sources de veille : ce que lit chaque source, où, et la variable
// d'environnement qui la coupe. Sert au pipeline (activation), au tableau de
// bord (filtre, badges) et à la page de configuration (liste des sources).
import type { Source } from "./scraper.ts";

export type SourceInfo = {
  id: Source;
  label: string;
  url: string;
  // Ce qui est lu, en une phrase, pour la page de configuration.
  description: string;
  // Variable d'environnement « =0 » qui désactive la source (BOAMP : aucune).
  env?: string;
};

export const SOURCES: readonly SourceInfo[] = [
  {
    id: "boamp",
    label: "BOAMP",
    url: "https://www.boamp.fr",
    description:
      "Source principale : API ouverte du Bulletin officiel des annonces de marchés publics, avis de services en cours contenant un des mots-clés ci-dessus.",
  },
  {
    id: "achatpublic",
    label: "achatpublic.com",
    url: "https://www.achatpublic.com/sdm/ent/gen/index.do",
    description:
      "Toutes les consultations ouvertes (services et fournitures) de la salle des marchés, filtrées par famille de mots-clés : mobilité, Kiomda (compteurs), inondations.",
    env: "ACHATPUBLIC",
  },
  {
    id: "afd",
    label: "AFD (dgMarket)",
    url: "https://afd.dgmarket.com/tenders/brandedNoticeList.do",
    description: "Avis financés par l'Agence française de développement, catégorie « Transports », à l'étranger.",
    env: "AFD",
  },
  {
    id: "maximilien",
    label: "Maximilien",
    url: "https://marches.maximilien.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons",
    description: "Consultations ouvertes des acheteurs publics d'Île-de-France, marchés de services, familles mobilité et inondations.",
    env: "MAXIMILIEN",
  },
  {
    id: "ampa",
    label: "Marchés publics d'Aquitaine",
    url: "https://demat-ampa.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons",
    description: "Consultations ouvertes de la plateforme AMPA (Nouvelle-Aquitaine), marchés de services, familles mobilité et inondations.",
    env: "AMPA",
  },
  {
    id: "marchesonline",
    label: "Marchés Online (Le Moniteur)",
    url: "https://www.marchesonline.com/appels-offres/en-cours",
    description:
      "Pages par mot-clé de l'agrégateur du Moniteur (services et études, Kiomda en fournitures, inondations), limitées aux pages les plus récentes des mots-clés très larges.",
    env: "MARCHESONLINE",
  },
];

export const SOURCE_LABELS: Record<Source, string> = Object.fromEntries(
  SOURCES.map((s) => [s.id, s.label]),
) as Record<Source, string>;

export function sourceLabel(id: string | null | undefined): string {
  return SOURCE_LABELS[(id ?? "boamp") as Source] ?? id ?? "?";
}

export function isSource(id: string | null | undefined): id is Source {
  return SOURCES.some((s) => s.id === id);
}

// Une source est active sauf si sa variable vaut « 0 » (env par défaut : Bun.env).
export function isSourceEnabled(id: Source, env: Record<string, string | undefined> = Bun.env): boolean {
  const info = SOURCES.find((s) => s.id === id);
  return !info?.env || env[info.env] !== "0";
}
