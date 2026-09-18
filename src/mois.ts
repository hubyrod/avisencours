// Nom de mois (français ou anglais, abrégé ou complet, avec ou sans accent)
// -> « 01 »…« 12 ». Partagé par les sources dont les dates sont en toutes
// lettres (achatpublic, AFD/dgMarket, Maximilien).
const MOIS: Array<[RegExp, string]> = [
  [/^jan/, "01"], [/^f[ev]/, "02"], [/^mar/, "03"], [/^a[vp]r/, "04"], [/^ma[iy]/, "05"],
  [/^juin|^jun/, "06"], [/^juil|^jul/, "07"], [/^ao|^aug/, "08"], [/^sep/, "09"],
  [/^oct/, "10"], [/^nov/, "11"], [/^dec/, "12"],
];

export function moisCode(name: string): string | null {
  const key = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return MOIS.find(([re]) => re.test(key))?.[1] ?? null;
}
