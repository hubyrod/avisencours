import { describe, expect, test } from "bun:test";
import {
  commentToItem,
  eventToItem,
  sortThread,
  type DbComment,
  type DbStatusEvent,
  type DbStatus,
  type ThreadItem,
} from "./live.ts";

const users: Record<string, { id: string; email: string; name: string | null }> = {
  "1": { id: "1", email: "ana@example.com", name: "Ana" },
  "2": { id: "2", email: "bob@example.com", name: null },
};
const userOf = (id: string) => users[id];

const statuses: Record<string, DbStatus> = {
  "1": { id: "1", label: "à évaluer", color: "#626d66" },
  "4": { id: "4", label: "répondu", color: "#1d4ed8" },
};
const statusOf = (id: string) => statuses[id];

function comment(id: string, created_at: string, user_id: string | null, body = "…"): DbComment {
  return { id, idweb: "26-1", user_id, body, created_at };
}

function event(id: string, created_at: string, user_id: string | null, status_id = "4"): DbStatusEvent {
  return { id, idweb: "26-1", status_id, user_id, created_at };
}

describe("commentToItem", () => {
  test("joint le nom et l'email de l'auteur", () => {
    const c = commentToItem(comment("1", "2026-07-01 09:00:00+02", "1"), userOf);
    expect(c.kind).toBe("comment");
    expect(c.author_name).toBe("Ana");
    expect(c.author_email).toBe("ana@example.com");
  });

  test("nom absent → name null, email conservé", () => {
    const c = commentToItem(comment("1", "2026-07-01 09:00:00+02", "2"), userOf);
    expect(c.author_name).toBeNull();
    expect(c.author_email).toBe("bob@example.com");
  });

  test("utilisateur supprimé (user_id null) → auteur entièrement null", () => {
    const c = commentToItem(comment("1", "2026-07-01 09:00:00+02", null), userOf);
    expect(c.user_id).toBeNull();
    expect(c.author_name).toBeNull();
    expect(c.author_email).toBeNull();
  });

  test("user_id orphelin (utilisateur inconnu) → auteur null mais user_id conservé", () => {
    const c = commentToItem(comment("1", "2026-07-01 09:00:00+02", "99"), userOf);
    expect(c.user_id).toBe("99");
    expect(c.author_name).toBeNull();
    expect(c.author_email).toBeNull();
  });
});

describe("eventToItem", () => {
  test("joint le libellé et la couleur du statut, et l'auteur", () => {
    const e = eventToItem(event("1", "2026-07-01 09:00:00+02", "1", "4"), userOf, statusOf);
    expect(e.kind).toBe("statut");
    if (e.kind !== "statut") throw new Error("unreachable");
    expect(e.status_id).toBe("4");
    expect(e.status_label).toBe("répondu");
    expect(e.status_color).toBe("#1d4ed8");
    expect(e.author_name).toBe("Ana");
  });

  test("statut inconnu → libellé et couleur null, status_id conservé", () => {
    const e = eventToItem(event("1", "2026-07-01 09:00:00+02", "1", "99"), userOf, statusOf);
    if (e.kind !== "statut") throw new Error("unreachable");
    expect(e.status_id).toBe("99");
    expect(e.status_label).toBeNull();
    expect(e.status_color).toBeNull();
  });

  test("utilisateur supprimé (user_id null) → auteur entièrement null", () => {
    const e = eventToItem(event("1", "2026-07-01 09:00:00+02", null), userOf, statusOf);
    expect(e.user_id).toBeNull();
    expect(e.author_name).toBeNull();
    expect(e.author_email).toBeNull();
  });
});

describe("sortThread", () => {
  const item = (kind: "comment" | "statut", id: string, created_at: string): ThreadItem =>
    kind === "comment"
      ? commentToItem(comment(id, created_at, "1"), userOf)
      : eventToItem(event(id, created_at, "1"), userOf, statusOf);

  test("trie par created_at puis id numérique (le SELECT de l'adaptateur n'ordonne pas)", () => {
    const thread = sortThread([
      item("comment", "10", "2026-07-02 09:00:00+02"),
      item("comment", "9", "2026-07-01 09:00:00+02"),
      item("comment", "2", "2026-07-01 09:00:00+02"),
    ]);
    expect(thread.map((c) => c.id)).toEqual(["2", "9", "10"]);
  });

  test("interclasse commentaires et statuts par date", () => {
    const thread = sortThread([
      item("comment", "1", "2026-07-03 09:00:00+02"),
      item("statut", "1", "2026-07-01 09:00:00+02"),
      item("comment", "2", "2026-07-02 09:00:00+02"),
    ]);
    expect(thread.map((c) => `${c.kind}:${c.id}`)).toEqual(["statut:1", "comment:2", "comment:1"]);
  });

  test("à date égale, départage déterministe par kind puis id (deux séquences distinctes)", () => {
    const a = [
      item("statut", "5", "2026-07-01 09:00:00+02"),
      item("comment", "5", "2026-07-01 09:00:00+02"),
    ];
    const expected = ["comment:5", "statut:5"];
    expect(sortThread(a).map((c) => `${c.kind}:${c.id}`)).toEqual(expected);
    expect(sortThread([...a].reverse()).map((c) => `${c.kind}:${c.id}`)).toEqual(expected);
  });

  test("fil sans commentaire (statuts seuls) — le cas merge", () => {
    const thread = sortThread([
      item("statut", "2", "2026-07-02 09:00:00+02"),
      item("statut", "1", "2026-07-01 09:00:00+02"),
    ]);
    expect(thread.map((c) => c.id)).toEqual(["1", "2"]);
    expect(thread.every((c) => c.kind === "statut")).toBe(true);
  });
});
