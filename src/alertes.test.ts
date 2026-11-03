import { describe, expect, test } from "bun:test";
import { alertDecision, failedSourcesFromWarning, hasLlmIssue } from "./alertes.ts";

const MO = "Marchés Online (Le Moniteur) indisponible — Error: Marchés Online 403 Forbidden sur https://… — ses avis ne sont pas mis à jour ce run";
const CSL = "achatpublic.com indisponible — Error: parseCards : page vide — ses avis ne sont pas mis à jour ce run";
const LLM = "coupe-circuit LLM ouvert : 5 échecs consécutifs — les avis restants ont été classés par regex";

describe("failedSourcesFromWarning", () => {
  test("reconnaît les sources par libellé, plusieurs à la fois", () => {
    expect(failedSourcesFromWarning(MO)).toEqual(["marchesonline"]);
    expect(failedSourcesFromWarning(`${CSL} ; ${MO}`)).toEqual(["achatpublic", "marchesonline"]);
    expect(failedSourcesFromWarning(null)).toEqual([]);
    expect(failedSourcesFromWarning(LLM)).toEqual([]);
  });
  test("hasLlmIssue", () => {
    expect(hasLlmIssue(LLM)).toBe(true);
    expect(hasLlmIssue("classifieur « hybrid » demandé mais OPENROUTER_API_KEY absente")).toBe(true);
    expect(hasLlmIssue(MO)).toBe(false);
  });
});

describe("alertDecision", () => {
  test("pas d'avertissement : pas d'alerte", () => {
    expect(alertDecision(MO, null).send).toBe(false);
    expect(alertDecision(null, undefined).send).toBe(false);
  });
  test("une source tombe : alerte, et elle est nommée", () => {
    expect(alertDecision(null, MO)).toEqual({ send: true, nouvelles: ["marchesonline"], llm: false });
  });
  test("la même source toujours en panne : pas de nouvel email, même si le détail de l'erreur change", () => {
    const hier = MO.replace("velo", "transport");
    expect(alertDecision(hier, MO).send).toBe(false);
  });
  test("une seconde source tombe pendant que la première dure : alerte pour la nouvelle seulement", () => {
    expect(alertDecision(MO, `${MO} ; ${CSL}`)).toEqual({ send: true, nouvelles: ["achatpublic"], llm: false });
  });
  test("une source revient, l'autre reste : rien de nouveau", () => {
    expect(alertDecision(`${MO} ; ${CSL}`, MO).send).toBe(false);
  });
  test("problème LLM nouveau : alerte ; déjà présent hier : silence", () => {
    expect(alertDecision(MO, `${MO} ; ${LLM}`)).toEqual({ send: true, nouvelles: [], llm: true });
    expect(alertDecision(LLM, LLM).send).toBe(false);
  });
  test("avertissement inconnu (ni source ni LLM) : alerte s'il change", () => {
    expect(alertDecision(null, "quelque chose d'inattendu").send).toBe(true);
    expect(alertDecision("quelque chose d'inattendu", "quelque chose d'inattendu").send).toBe(false);
  });
});
