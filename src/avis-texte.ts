// Texte brut d'un avis (fragments joints par « — » par les scrapers) : les
// fragments non étiquetés forment la description (l'objet répété est écarté),
// les fragments « Libellé: valeur » deviennent des précisions (CPV, lieu, lots…).
export function decouperRaw(raw: string | null | undefined, objet: string): { description: string[]; precisions: Array<[string, string]> } {
  const description: string[] = [];
  const precisions: Array<[string, string]> = [];
  const vus = new Set<string>([objet.trim()]);
  for (const brut of (raw ?? "").split(/\s+—\s+/)) {
    const frag = brut.trim();
    if (!frag) continue;
    const m = frag.match(/^([A-Za-zÀ-ÿ' ]{2,20}):\s+(.+)$/s);
    if (m) {
      if (!/^(acheteur|departement|département|type d'avis|procedure|procédure|nature|pays|langue|type d'annonce)$/i.test(m[1]!)) {
        precisions.push([m[1]!, m[2]!.trim()]);
      }
      continue;
    }
    if (vus.has(frag)) continue;
    vus.add(frag);
    description.push(frag);
  }
  return { description, precisions };
}

