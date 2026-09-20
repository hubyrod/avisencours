// Exécution concurrente bornée : `n` travailleurs consomment la liste dans
// l'ordre, chaque résultat reprend la place de son entrée (l'ordre de sortie
// ne dépend pas de l'ordre d'achèvement). Partagé par le pipeline (classement
// LLM), le scraper BOAMP (pages) et l'évaluation des modèles.
export async function mapConcurrent<T, R>(items: readonly T[], fn: (t: T, i: number) => Promise<R>, n: number): Promise<R[]> {
  // oxlint-disable-next-line no-new-array -- length-init; slots are filled by index below
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
