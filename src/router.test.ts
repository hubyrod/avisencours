import { describe, expect, test } from "bun:test";
import { matchPath } from "./router.ts";

describe("matchPath", () => {
  test("chemins statiques : correspondance exacte uniquement", () => {
    expect(matchPath("/admin", "/admin")).toEqual({});
    expect(matchPath("/admin", "/admin/x")).toBeNull();
    expect(matchPath("/admin", "/profil")).toBeNull();
  });

  test("segments :param capturés et décodés", () => {
    expect(matchPath("/avis/:idweb", "/avis/26-70006")).toEqual({ idweb: "26-70006" });
    expect(matchPath("/avis/:idweb", "/avis/a%20b")).toEqual({ idweb: "a b" });
    expect(matchPath("/avis/:idweb/commenter", "/avis/26-1/commenter")).toEqual({ idweb: "26-1" });
  });

  test("segment vide ou arité différente → null", () => {
    expect(matchPath("/avis/:idweb", "/avis/")).toBeNull();
    expect(matchPath("/avis/:idweb", "/avis")).toBeNull();
    expect(matchPath("/avis/:idweb", "/avis/1/extra")).toBeNull();
  });

  test("un %-encodage invalide ne matche pas au lieu de jeter", () => {
    expect(matchPath("/avis/:idweb", "/avis/%zz")).toBeNull();
  });
});
