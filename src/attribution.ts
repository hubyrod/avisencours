// « Qui a défini le statut, et quand » — logique pure, partagée entre la page
// avis (ligne sous les boutons de statut) et le tableau de bord (info-bulle du
// badge), pour que les deux affichages ne divergent jamais. Testée dans
// attribution.test.ts ; l'échappement HTML reste à la charge de l'appelant.

export function frDateTime(d: Date): string {
  return d.toLocaleString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
}

export type StatusAttributionEvent = {
  user_id: number | null;
  author_name: string | null;
  author_email: string | null;
  created_at: Date;
};

// Même règle que le fil de commentaires : auteur supprimé (user_id null) →
// « utilisateur supprimé », sinon nom puis email.
export function statusAuthorLabel(evt: Pick<StatusAttributionEvent, "user_id" | "author_name" | "author_email">): string {
  if (evt.user_id === null) return "utilisateur supprimé";
  return evt.author_name || evt.author_email || "?";
}

// Ligne sous les boutons de statut de la page avis.
export function statusAttributionLine(evt: StatusAttributionEvent | null): string {
  if (!evt) return "Statut par défaut — encore aucun changement.";
  return `Défini par ${statusAuthorLabel(evt)} le ${frDateTime(evt.created_at)}`;
}

// Info-bulle du badge de statut du tableau de bord — null quand l'avis est au
// statut par défaut implicite (aucun changement à attribuer, donc pas de title).
export function statusTooltip(evt: StatusAttributionEvent | null): string | null {
  if (!evt) return null;
  return `défini par ${statusAuthorLabel(evt)} le ${frDateTime(evt.created_at)}`;
}
