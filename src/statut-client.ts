// Changement de statut depuis la liste du tableau de bord (un <select> par
// ligne). Cette fonction s'exécute DANS LE NAVIGATEUR : server.ts l'injecte
// dans DASHBOARD_JS par toString(), elle doit donc rester autonome (aucun
// import, aucune variable extérieure) et s'en tenir au JavaScript des pages.
// Elle vit ici pour être testée (statut-client.test.ts) avec un formulaire
// factice qui suit la règle du navigateur : un champ désactivé n'est pas envoyé.

type Champ = { value: string; disabled: boolean; title: string; selectedIndex: number; options: ArrayLike<{ dataset: { color?: string } }>; style: { borderLeftColor: string }; addEventListener(type: string, fn: () => unknown): void };
type Formulaire = { action: string; querySelector(sel: string): unknown };
type Env = {
  fetch: (url: string, init: { method: string; body: unknown; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  FormData: new (f: Formulaire) => unknown;
  // Message d'erreur à afficher, ou null pour l'effacer.
  montrer: (msg: string | null) => void;
};

export function brancherStatut(f: Formulaire, env: Env): void {
  const select = f.querySelector("select") as Champ | null;
  const ok = f.querySelector("button.ok") as { hidden: boolean } | null;
  if (!select) return;
  if (ok) ok.hidden = true;
  let precedent = select.value;
  const couleur = () => {
    const opt = select.options[select.selectedIndex];
    select.style.borderLeftColor = (opt && opt.dataset.color) || "#626d66";
  };
  select.addEventListener("change", async () => {
    // Les données sont lues AVANT de désactiver le select : un champ désactivé
    // est exclu de FormData, et le serveur recevait alors un statut vide
    // (« Statut inconnu ou archivé. » à chaque changement).
    const body = new env.FormData(f);
    select.disabled = true;
    try {
      const res = await env.fetch(f.action, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Erreur " + res.status);
      precedent = select.value;
      couleur();
      select.title = "Défini par vous à l'instant";
      env.montrer(null);
    } catch (err) {
      select.value = precedent;
      const raison = err instanceof Error && err.message ? err.message : "erreur réseau";
      env.montrer("Le statut n'a pas pu être enregistré : " + raison + ".");
    } finally {
      select.disabled = false;
    }
  });
}
