// Avis déjà connus (base de la veille, ou cache du CLI) : les sources
// secondaires ne relisent pas la fiche d'une consultation dont la carte n'a
// pas changé — même URL (Marchés Online y met le numéro de version), même
// intitulé, même date limite — et vue il y a moins de KNOWN_MAX_AGE_MS
// (relecture périodique, filet de sécurité). Logique pure.
import type { Announcement } from "./scraper.ts";

export type KnownAnnouncement = Announcement & { lastSeenAt: Date | null };
export type KnownLookup = (idweb: string) => KnownAnnouncement | undefined;

export const KNOWN_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export type CardFacts = { url?: string; objet?: string; deadline?: string | null };

// Les champs fournis doivent être identiques à ceux mémorisés ; un champ
// omis n'est pas comparé (AFD : l'intitulé de la fiche diffère de la liste).
export function reusable(known: KnownAnnouncement, card: CardFacts, now: number = Date.now()): boolean {
  if (!known.lastSeenAt || now - known.lastSeenAt.getTime() > KNOWN_MAX_AGE_MS) return false;
  if (card.url !== undefined && card.url !== known.url) return false;
  if (card.objet !== undefined && card.objet !== known.objet) return false;
  if (card.deadline !== undefined && (card.deadline ?? null) !== (known.deadline ?? null)) return false;
  return true;
}

export function toAnnouncement(known: KnownAnnouncement): Announcement {
  const { lastSeenAt: _seen, ...a } = known;
  return a;
}

// Index d'un lot d'avis (cache du CLI, base) par idweb.
export function knownIndex(items: readonly Announcement[], lastSeenAt: Date | null): KnownLookup {
  const map = new Map<string, KnownAnnouncement>();
  for (const it of items) if (it.idweb) map.set(it.idweb, { ...it, lastSeenAt });
  return (idweb) => map.get(idweb);
}
