import { describe, expect, test } from "bun:test";
import { buildThread } from "./live.ts";

const users: Record<string, { id: string; email: string; name: string | null }> = {
  "1": { id: "1", email: "ana@example.com", name: "Ana" },
  "2": { id: "2", email: "bob@example.com", name: null },
};
const userOf = (id: string) => users[id];

function comment(id: string, created_at: string, user_id: string | null, body = "…") {
  return { id, idweb: "26-1", user_id, body, created_at };
}

describe("buildThread", () => {
  test("trie par created_at puis id numérique (le SELECT de l'adaptateur n'ordonne pas)", () => {
    const thread = buildThread(
      [
        comment("10", "2026-07-02 09:00:00+02", "1"),
        comment("9", "2026-07-01 09:00:00+02", "1"),
        comment("2", "2026-07-01 09:00:00+02", "1"),
      ],
      userOf,
    );
    expect(thread.map((c) => c.id)).toEqual(["2", "9", "10"]);
  });

  test("joint le nom et l'email de l'auteur", () => {
    const [c] = buildThread([comment("1", "2026-07-01 09:00:00+02", "1")], userOf);
    expect(c!.author_name).toBe("Ana");
    expect(c!.author_email).toBe("ana@example.com");
  });

  test("nom absent → name null, email conservé", () => {
    const [c] = buildThread([comment("1", "2026-07-01 09:00:00+02", "2")], userOf);
    expect(c!.author_name).toBeNull();
    expect(c!.author_email).toBe("bob@example.com");
  });

  test("utilisateur supprimé (user_id null) → auteur entièrement null", () => {
    const [c] = buildThread([comment("1", "2026-07-01 09:00:00+02", null)], userOf);
    expect(c!.user_id).toBeNull();
    expect(c!.author_name).toBeNull();
    expect(c!.author_email).toBeNull();
  });

  test("user_id orphelin (utilisateur inconnu) → auteur null mais user_id conservé", () => {
    const [c] = buildThread([comment("1", "2026-07-01 09:00:00+02", "99")], userOf);
    expect(c!.user_id).toBe("99");
    expect(c!.author_name).toBeNull();
    expect(c!.author_email).toBeNull();
  });
});
