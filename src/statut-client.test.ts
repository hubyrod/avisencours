import { describe, expect, test } from "bun:test";
import { brancherStatut } from "./statut-client.ts";

// Formulaire factice qui suit la règle du navigateur : FormData ne contient
// que les champs activés au moment où on le construit. C'est cette règle qui
// rendait tout changement de statut depuis la liste impossible (le select
// était désactivé avant la lecture du formulaire → statut vide → 400).
function page(valeur = "1") {
  let onChange: () => unknown = () => {};
  const select = {
    value: valeur,
    disabled: false,
    title: "",
    selectedIndex: 0,
    options: [{ dataset: { color: "#111111" } }, { dataset: { color: "#222222" } }],
    style: { borderLeftColor: "" },
    addEventListener: (_type: string, fn: () => unknown) => {
      onChange = fn;
    },
  };
  const ok = { hidden: false };
  const form = {
    action: "/avis/B1/statut",
    retour: "/?source=boamp",
    querySelector: (sel: string) => (sel === "select" ? select : sel === "button.ok" ? ok : null),
  };
  class FakeFormData {
    champs: Record<string, string> = {};
    constructor(f: typeof form) {
      this.champs.retour = f.retour;
      if (!select.disabled) this.champs.statut = select.value;
    }
  }
  const envois: Array<{ url: string; champs: Record<string, string>; accept: string | undefined }> = [];
  const messages: Array<string | null> = [];
  let reponse = { ok: true, status: 200, json: async (): Promise<unknown> => ({ ok: true }) };
  const env = {
    FormData: FakeFormData as unknown as new (f: unknown) => unknown,
    fetch: async (url: string, init: { body: unknown; headers: Record<string, string> }) => {
      envois.push({ url, champs: (init.body as FakeFormData).champs, accept: init.headers.Accept });
      return reponse;
    },
    montrer: (msg: string | null) => {
      messages.push(msg);
    },
  };
  brancherStatut(form, env);
  return {
    select,
    ok,
    envois,
    messages,
    changer: async (v: string, index: number) => {
      select.value = v;
      select.selectedIndex = index;
      await onChange();
    },
    repondre: (r: typeof reponse) => {
      reponse = r;
    },
  };
}

describe("brancherStatut (select de statut du tableau de bord)", () => {
  test("le statut choisi part bien dans la requête", async () => {
    const p = page("1");
    await p.changer("4", 1);
    expect(p.envois).toEqual([{ url: "/avis/B1/statut", champs: { retour: "/?source=boamp", statut: "4" }, accept: "application/json" }]);
  });

  test("succès : couleur de l'option, select réactivé, erreur effacée, bouton OK masqué", async () => {
    const p = page("1");
    expect(p.ok.hidden).toBe(true);
    await p.changer("4", 1);
    expect(p.select.style.borderLeftColor).toBe("#222222");
    expect(p.select.disabled).toBe(false);
    expect(p.select.title).toBe("Défini par vous à l'instant");
    expect(p.messages).toEqual([null]);
  });

  test("refus du serveur : valeur restaurée, message affiché, select réactivé", async () => {
    const p = page("1");
    p.repondre({ ok: false, status: 400, json: async () => ({ error: "Statut inconnu ou archivé." }) });
    await p.changer("4", 1);
    expect(p.select.value).toBe("1");
    expect(p.select.disabled).toBe(false);
    expect(p.messages).toEqual(["Le statut n'a pas pu être enregistré : Statut inconnu ou archivé.."]);
    // Le changement suivant repart de la bonne valeur précédente.
    p.repondre({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await p.changer("4", 1);
    expect(p.envois[1]!.champs.statut).toBe("4");
    expect(p.select.value).toBe("4");
  });

  test("le code injecté dans la page est du JavaScript autonome", () => {
    const source = brancherStatut.toString();
    // Ni annotation TypeScript ni référence à un module : la page l'évalue telle quelle.
    const fn = new Function(`return (${source});`)();
    expect(typeof fn).toBe("function");
    expect(source).not.toContain("import");
  });
});
