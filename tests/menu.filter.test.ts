import { describe, expect, test } from "bun:test";
import {
  allowedCourses,
  buildWhere,
  dietAllows,
  relaxSlot,
  RELAXATIONS,
} from "../src/services/menu.filter.ts";
import type { Slot } from "../src/schemas/menu.schema.ts";

/**
 * menu.filter.ts opens by calling itself "the highest-risk logic in the feature:
 * a mistake here serves a vegetarian a chicken dish", and says it has no I/O so
 * it can be tested on its own. It never was. These are those tests.
 */

const slot = (over: Partial<Slot> = {}): Slot => ({
  label: "t",
  count: 1,
  diet: "any",
  spice: "any",
  cuisine: "any",
  course: "any",
  courseGroup: "food",
  searchText: "dish",
  ...over,
});

describe("diet semantics", () => {
  test("a veg slot admits vegetarian and jain, and nothing else", () => {
    expect(dietAllows("veg", "Vegetarian")).toBe(true);
    expect(dietAllows("veg", "Jain")).toBe(true);
    expect(dietAllows("veg", "NonVegetarian")).toBe(false);
    expect(dietAllows("veg", "OnlyFish")).toBe(false);
  });

  test("egg is NOT vegetarian -- Indian usage, and the whole point of the enum", () => {
    expect(dietAllows("veg", "Eggetarian")).toBe(false);
    expect(dietAllows("egg", "Eggetarian")).toBe(true);
  });

  test("jain is stricter than veg, so veg dishes do not satisfy a jain slot", () => {
    expect(dietAllows("jain", "Vegetarian")).toBe(false);
    expect(dietAllows("jain", "Jain")).toBe(true);
  });

  test("nonveg NARROWS -- it asks for meat rather than tolerating it", () => {
    expect(dietAllows("nonveg", "NonVegetarian")).toBe(true);
    expect(dietAllows("nonveg", "OnlyFish")).toBe(true);
    // The bug this prevents: "1 non veg" coming back with paneer tikka.
    expect(dietAllows("nonveg", "Vegetarian")).toBe(false);
    expect(dietAllows("nonveg", "Jain")).toBe(false);
    expect(dietAllows("nonveg", "Eggetarian")).toBe(false);
  });

  test("a pescatarian slot widens over veg but excludes other meat", () => {
    expect(dietAllows("fish", "OnlyFish")).toBe(true);
    expect(dietAllows("fish", "Vegetarian")).toBe(true);
    expect(dietAllows("fish", "NonVegetarian")).toBe(false);
  });

  test("any admits everything", () => {
    for (const d of ["Vegetarian", "NonVegetarian", "Eggetarian", "OnlyFish", "Jain"]) {
      expect(dietAllows("any", d)).toBe(true);
    }
  });
});

describe("buildWhere", () => {
  test("only orderable dishes reach a guest", () => {
    const where = buildWhere(slot(), { includeDrinks: true });
    expect(where.isActive).toBe(true);
    expect(where.isAvailable).toBe(true);
    expect(where.soldOut).toBe(false);
  });

  test("the dashboard can opt out of the orderable filter", () => {
    const where = buildWhere(slot(), { includeDrinks: true, orderableOnly: false });
    expect(where.isActive).toBeUndefined();
  });

  test("a diet constraint becomes an explicit allowlist", () => {
    const where = buildWhere(slot({ diet: "nonveg" }), { includeDrinks: true });
    expect(where.diet).toEqual({ in: ["NonVegetarian", "OnlyFish"] });
  });

  test("'any' emits no diet clause at all", () => {
    expect(buildWhere(slot(), { includeDrinks: true }).diet).toBeUndefined();
  });

  test("spice bands overlap on purpose, so slots are not stranded", () => {
    expect(buildWhere(slot({ spice: "medium" }), { includeDrinks: true }).spice)
      .toEqual({ gte: 2, lte: 3 });
    expect(buildWhere(slot({ spice: "spicy" }), { includeDrinks: true }).spice)
      .toEqual({ gte: 3 });
  });

  test("food slots never leak drinks", () => {
    const where = buildWhere(slot({ courseGroup: "food" }), { includeDrinks: false });
    const courses = (where.course as { in: string[] }).in;
    expect(courses).not.toContain("Alcohol");
    expect(courses).toContain("MainCourse");
  });

  test("a named course wins over the coarse food/drink group", () => {
    const where = buildWhere(slot({ course: "Dessert", courseGroup: "drink" }), {
      includeDrinks: false,
    });
    expect((where.course as { in: string[] }).in).toEqual(["Dessert"]);
  });
});

describe("the relaxation ladder", () => {
  test("diet is never on it, at any rung", () => {
    const original = slot({ diet: "veg", spice: "spicy", cuisine: "Indian", course: "Starter" });
    for (const rung of RELAXATIONS) {
      const relaxed = relaxSlot(original, rung);
      if (relaxed) expect(relaxed.diet).toBe("veg");
    }
  });

  test("softening a cuisine keeps it as a preference for the ranker", () => {
    const relaxed = relaxSlot(slot({ cuisine: "Italian" }), "cuisine_softened");
    expect(relaxed?.cuisine).toBe("any");
    // Without this the preference would be lost entirely -- it used to survive
    // by staying in searchText, where the embedding picked it up.
    expect(relaxed?.softenedCuisine).toBe("Italian");
  });

  test("a rung that would change nothing returns null", () => {
    expect(relaxSlot(slot({ spice: "any" }), "spice_widened")).toBeNull();
    expect(relaxSlot(slot({ cuisine: "any" }), "cuisine_softened")).toBeNull();
    expect(relaxSlot(slot({ course: "any", courseGroup: "any" }), "course_dropped")).toBeNull();
  });

  test("widening moves toward the middle from either end", () => {
    expect(relaxSlot(slot({ spice: "none" }), "spice_widened")?.spice).toBe("mild");
    expect(relaxSlot(slot({ spice: "very_spicy" }), "spice_widened")?.spice).toBe("spicy");
  });
});

describe("allowedCourses", () => {
  test("includeDrinks removes the course restriction entirely", () => {
    expect(allowedCourses(slot(), true)).toBeNull();
  });

  test("a drink slot is restricted to drink courses", () => {
    expect(allowedCourses(slot({ courseGroup: "drink" }), false)).toEqual([
      "Beverage", "Alcohol", "Shisha",
    ]);
  });
});
