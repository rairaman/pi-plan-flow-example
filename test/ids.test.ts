import { describe, expect, it } from "vitest";
import { ID_PATTERN, branchFor, idFromArg, newId, planDirName, slugify } from "../.pi/extensions/plan-flow/ids";

describe("newId", () => {
  it("returns 4 base36 characters", () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(ID_PATTERN);
  });

  it("re-rolls when an id is taken", () => {
    const seen: string[] = [];
    const id = newId((candidate) => {
      seen.push(candidate);
      return seen.length < 3;
    });
    expect(seen).toHaveLength(3);
    expect(id).toBe(seen[2]);
  });

  it("gives up when every id is taken", () => {
    expect(() => newId(() => true)).toThrow(/free plan id/);
  });
});

describe("slugify", () => {
  it("drops stopwords and keeps the first four words", () => {
    expect(slugify("Add scheduled emails to contacts")).toBe("scheduled-emails-contacts");
    expect(slugify("Add a CSV export button to the reports page")).toBe("csv-export-button-reports");
  });

  it("strips punctuation", () => {
    expect(slugify("Fix: login (OAuth) redirect!")).toBe("fix-login-oauth-redirect");
  });

  it("caps the length at whole words", () => {
    const slug = slugify("internationalisation localisation configuration administration");
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug).toBe("internationalisation");
  });

  it("falls back to stopwords, then to 'plan'", () => {
    expect(slugify("add it")).toBe("add-it");
    expect(slugify("!!!")).toBe("plan");
  });
});

describe("folder helpers", () => {
  it("builds dir and branch names", () => {
    expect(planDirName("k3f9", "sched-email")).toBe("k3f9-sched-email");
    expect(branchFor("k3f9-sched-email")).toBe("factory/k3f9-sched-email");
  });

  it("reads an id from the forms people type", () => {
    expect(idFromArg("k3f9")).toBe("k3f9");
    expect(idFromArg("k3f9-sched-email")).toBe("k3f9");
    expect(idFromArg(".plan/k3f9-sched-email/")).toBe("k3f9");
    expect(idFromArg("sched-email")).toBeUndefined();
    expect(idFromArg("k3f9x")).toBeUndefined();
  });
});
