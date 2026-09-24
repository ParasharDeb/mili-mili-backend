import { describe, expect, test } from "bun:test";
import { quantityIn, resolve } from "../src/services/menu.reference.ts";
import type { OfferedDish } from "../src/lib/session.ts";

/**
 * "Yes, order dish A" is the feature these back. The rule they encode is that
 * the resolver never guesses: adding the wrong dish to an order is discovered at
 * the table, and doing nothing silently is worse than asking.
 */

const dish = (n: number, name: string, over: Partial<OfferedDish> = {}): OfferedDish => ({
  ordinal: n,
  id: `id-${n}`,
  name,
  nameKey: name.toLowerCase(),
  diet: "Vegetarian",
  protein: "None",
  spice: 0,
  spiceConfidence: 1,
  price: 100 * n,
  ...over,
});

const offer = (dishes: OfferedDish[]) => ({ at: Date.now(), turnIndex: 1, dishes });

const THREE = [
  dish(1, "Tandoori Royal Non Veg Platter", { diet: "NonVegetarian", protein: "Mutton" }),
  dish(2, "Chicken Teriyaki Bao", { diet: "NonVegetarian", protein: "Chicken" }),
  dish(3, "Paneer Tikka Masala", { protein: "Paneer", spice: 4 }),
];

describe("bare yes", () => {
  test("resolves when exactly one dish was offered", () => {
    const r = resolve("yes", offer([THREE[0]!]), 2, "bare_yes");
    expect(r.status).toBe("resolved");
  });

  test("does NOT guess when several were offered", () => {
    const r = resolve("yes", offer(THREE), 2, "bare_yes");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates).toHaveLength(3);
  });

  test("'ok' and 'sure' behave the same as 'yes'", () => {
    for (const word of ["ok", "sure", "go ahead", "order it"]) {
      expect(resolve(word, offer(THREE), 2).status).toBe("ambiguous");
    }
  });
});

describe("ordinals", () => {
  test("the first / the second / the last", () => {
    const first = resolve("the first one", offer(THREE), 2, "ordinal");
    expect(first.status === "resolved" && first.dishes[0]!.ordinal).toBe(1);

    const second = resolve("order the second", offer(THREE), 2, "ordinal");
    expect(second.status === "resolved" && second.dishes[0]!.ordinal).toBe(2);

    const last = resolve("the last one", offer(THREE), 2, "ordinal");
    expect(last.status === "resolved" && last.dishes[0]!.ordinal).toBe(3);
  });

  test("an out-of-range ordinal asks rather than silently clamping", () => {
    const r = resolve("the 9th one", offer(THREE), 2, "ordinal");
    expect(r.status).toBe("ambiguous");
  });
});

describe("by name and by attribute", () => {
  test("an exact name wins", () => {
    const r = resolve("add the Paneer Tikka Masala", offer(THREE), 2, "by_name");
    expect(r.status === "resolved" && r.dishes[0]!.name).toBe("Paneer Tikka Masala");
  });

  test("a distinctive word is enough when only one dish has it", () => {
    const r = resolve("the teriyaki", offer(THREE), 2, "by_name");
    expect(r.status === "resolved" && r.dishes[0]!.name).toBe("Chicken Teriyaki Bao");
  });

  test("'the chicken one' picks by protein", () => {
    const r = resolve("the chicken one", offer(THREE), 2, "by_attribute");
    expect(r.status === "resolved" && r.dishes[0]!.protein).toBe("Chicken");
  });

  test("'the veg one' respects the diet table, not a string match", () => {
    const r = resolve("the veg one", offer(THREE), 2, "by_attribute");
    expect(r.status === "resolved" && r.dishes[0]!.name).toBe("Paneer Tikka Masala");
  });

  test("'the spicy one' ignores dishes whose heat was never assessed", () => {
    const unassessed = [
      dish(1, "Mystery Curry", { spice: 5, spiceConfidence: null }),
      dish(2, "Chilli Chicken", { spice: 4, spiceConfidence: 0.9, protein: "Chicken" }),
    ];
    const r = resolve("the spicy one", offer(unassessed), 2, "by_attribute");
    expect(r.status === "resolved" && r.dishes[0]!.name).toBe("Chilli Chicken");
  });

  test("a word matching two dishes equally asks which", () => {
    const twoChicken = [
      dish(1, "Chicken Kurchan Tart", { diet: "NonVegetarian", protein: "Chicken" }),
      dish(2, "Chicken Teriyaki Bao", { diet: "NonVegetarian", protein: "Chicken" }),
    ];
    const r = resolve("the chicken", offer(twoChicken), 2, "by_name");
    expect(r.status).toBe("ambiguous");
  });

  test("an attribute word never matches a dish NAME containing it", () => {
    // "the veg one" once resolved to "Tandoori Royal Non Veg Platter", because
    // "veg" is a token of that name. The wrong direction to fail in.
    const r = resolve("the veg one", offer(THREE), 2, "by_attribute");
    expect(r.status === "resolved" && r.dishes[0]!.diet).toBe("Vegetarian");
  });
});

describe("quantifiers", () => {
  test("'both' resolves only when exactly two were offered", () => {
    const two = THREE.slice(0, 2);
    expect(resolve("both", offer(two), 2).status).toBe("resolved");
    expect(resolve("both", offer(THREE), 2).status).toBe("ambiguous");
  });

  test("'all of them' takes everything offered", () => {
    const r = resolve("all of them", offer(THREE), 2);
    expect(r.status === "resolved" && r.dishes).toHaveLength(3);
  });
});

describe("staleness", () => {
  test("an offer from twenty minutes ago is not what 'that one' points at", () => {
    const old = { at: Date.now() - 20 * 60_000, turnIndex: 1, dishes: THREE };
    expect(resolve("yes", old, 2, "bare_yes").status).not.toBe("resolved");
  });

  test("an offer four turns back has been superseded", () => {
    expect(resolve("yes", offer(THREE), 9, "bare_yes").status).not.toBe("resolved");
  });

  test("with nothing offered at all there is no context", () => {
    expect(resolve("yes", null, 1).status).toBe("no_context");
  });
});

describe("quantityIn", () => {
  test("reads digits and words", () => {
    expect(quantityIn("add 3 naan")).toBe(3);
    expect(quantityIn("add two butter naan")).toBe(2);
    expect(quantityIn("add a naan")).toBe(1);
  });

  test("'one' means 'the first one' far more often than a quantity", () => {
    expect(quantityIn("the first one")).toBe(1);
  });

  test("clamps to something a kitchen would accept", () => {
    expect(quantityIn("add 500 naan")).toBeLessThanOrEqual(20);
  });
});
