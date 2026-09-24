import { describe, expect, test } from "bun:test";
import {
  assembleSlot,
  dietFromText,
  heuristicPlan,
  partySize,
  splitChunks,
} from "../src/services/menu.slots.service.ts";
import { applyHardRules } from "../src/domain/diet.hardrules.ts";
import { contentWords, scoreItem } from "../src/services/menu.rank.ts";
import type { Slot } from "../src/schemas/menu.schema.ts";

describe("splitting a request into its parts", () => {
  test("the party-size phrase is stripped before splitting", () => {
    // Otherwise "for 5 people. 2 veg" reads the 5 as the first chunk's count.
    const chunks = splitChunks("for 5 people, 2 veg, 1 non veg spicy");
    expect(chunks).not.toContain("for 5 people");
    expect(chunks.some((c) => c.includes("2 veg"))).toBe(true);
  });

  test("party size is read from digits and from words", () => {
    expect(partySize("recommendations for 5 people")).toBe(5);
    expect(partySize("table for four guests")).toBe(4);
    expect(partySize("an indian non-veg item")).toBe(0);
  });

  test("five stated constraints become five chunks", () => {
    expect(splitChunks("for 5 people, 2 veg, 1 non veg spicy, 1 italian and 1 jain").length)
      .toBeGreaterThanOrEqual(4);
  });
});

describe("diet from an explicit token outranks everything", () => {
  test("reads the tokens a guest actually types", () => {
    expect(dietFromText("1 non veg spicy")).toBe("nonveg");
    expect(dietFromText("2 veg")).toBe("veg");
    expect(dietFromText("one jain")).toBe("jain");
    expect(dietFromText("something with fish")).toBe("fish");
  });

  test("'non veg' is not read as 'veg'", () => {
    // The substring trap: "non veg" contains "veg".
    expect(dietFromText("non-vegetarian")).toBe("nonveg");
    expect(dietFromText("nonveg")).toBe("nonveg");
  });

  test("returns null when nothing was stated, rather than guessing", () => {
    expect(dietFromText("something spicy")).toBeNull();
  });
});

describe("assembleSlot without a classifier", () => {
  test("a chunk stating nothing is not a slot", () => {
    expect(assembleSlot("i need recommendations", null)).toBeNull();
  });

  test("a stated constraint produces a slot with a readable label", () => {
    const slot = assembleSlot("1 non veg spicy", null)!;
    expect(slot.diet).toBe("nonveg");
    expect(slot.spice).toBe("spicy");
    expect(slot.label).toContain("non-veg");
  });

  test("counts come from the text, never from a model", () => {
    expect(assembleSlot("2 veg", null)!.count).toBe(2);
    expect(assembleSlot("three vegetarian", null)!.count).toBe(3);
  });

  test("a drink chunk is marked as one", () => {
    const slot = assembleSlot("a couple of cocktails", null)!;
    expect(slot.courseGroup).toBe("drink");
  });

  test("'not spicy' is mild, not spicy -- the negation must survive", () => {
    expect(assembleSlot("1 non veg not spicy", null)!.spice).toBe("none");
  });
});

describe("the full heuristic plan", () => {
  test("the five-person example decomposes into separate slots", () => {
    const plan = heuristicPlan("for 5 people, 2 veg, 1 non veg spicy, 1 italian and 1 jain");
    expect(plan.partySize).toBe(5);
    expect(plan.slots.length).toBeGreaterThanOrEqual(4);
    expect(plan.slots.map((s) => s.diet)).toContain("veg");
    expect(plan.slots.map((s) => s.diet)).toContain("nonveg");
    expect(plan.slots.map((s) => s.diet)).toContain("jain");
  });
});

describe("hard rules -- the dishes that made them necessary", () => {
  const base = {
    cuisine: "Indian" as const,
    course: "MainCourse" as const,
    diet: "Vegetarian" as const,
    protein: "None" as const,
    spice: 2,
    spiceConfidence: 0.8,
  };

  test("Hot Garlic Fish is not vegetarian", () => {
    const out = applyHardRules(base, { name: "Hot Garlic Fish", desc: null, tags: [] });
    expect(out.diet).toBe("OnlyFish");
  });

  test("Fish Finger is not vegetarian", () => {
    const out = applyHardRules(base, { name: "Fish Finger", desc: null, tags: [] });
    expect(out.diet).toBe("OnlyFish");
  });

  test("Tandoori Royal Veg Platter is not non-vegetarian", () => {
    // Its description mentions a "mushroom veg seekh kebab"; reading `seekh` as
    // meat once turned a veg platter non-vegetarian.
    const out = applyHardRules(
      { ...base, diet: "NonVegetarian" },
      { name: "Tandoori Royal Veg Platter", desc: "mushroom veg seekh kebab", tags: [] },
    );
    expect(out.diet).toBe("Vegetarian");
  });

  test("Paneer Tikka Masala is vegetarian, whatever a model says", () => {
    // The model returned NonVegetarian with protein Prawns for this one.
    const out = applyHardRules(
      { ...base, diet: "NonVegetarian", protein: "Prawns" },
      { name: "Paneer Tikka Masala", desc: "curry made with paneer", tags: ["veg"] },
    );
    expect(out.diet).toBe("Vegetarian");
    expect(out.protein).toBe("Paneer");
  });

  test("a POS 'veg' tag is trusted only when no meat is named", () => {
    const out = applyHardRules(
      { ...base, diet: "Vegetarian" },
      { name: "Chicken Popcorn", desc: null, tags: ["veg"] },
    );
    expect(out.diet).toBe("NonVegetarian");
  });

  test("devilled eggs stay eggetarian rather than being called vegetarian", () => {
    const out = applyHardRules(
      { ...base, diet: "Vegetarian" },
      { name: "Gochujang Devilled Eggs", desc: null, tags: ["veg"] },
    );
    expect(out.diet).toBe("Eggetarian");
  });

  test("a boozy tag settles what the thing is", () => {
    const out = applyHardRules(base, { name: "Samsara", desc: null, tags: ["boozy", "bar"] });
    expect(out.course).toBe("Alcohol");
    expect(out.spice).toBe(0);
  });

  test("a naan is bread even when a model files it as a main", () => {
    const out = applyHardRules(base, { name: "Butter Naan", desc: null, tags: [] });
    expect(out.course).toBe("Bread");
  });
});

describe("ranking", () => {
  const item = {
    name: "Chilli Chicken Dry",
    desc: "tossed with peppers",
    cuisine: "Indian",
    protein: "Chicken",
    spice: 4,
    spiceConfidence: 0.9,
    tasteTags: ["spicy"],
    tags: ["bestseller"],
    popularity: 1,
  };

  const slot = (over: Partial<Slot> = {}): Slot => ({
    label: "t", count: 1, diet: "any", spice: "any", cuisine: "any",
    course: "any", courseGroup: "food", searchText: "chilli chicken", ...over,
  });

  test("an unconstrained searchText carries no content words", () => {
    // This is the guard that stops trigram noise ranking by letter overlap.
    expect(contentWords("popular dish to share")).toHaveLength(0);
    expect(contentWords("chilli chicken")).toEqual(["chilli", "chicken"]);
  });

  test("a dish nobody assessed is not penalised for a heat it never had", () => {
    const signals = { nameSim: 0.5, descSim: 0, tsRank: 0 };
    const assessed = scoreItem(item, slot({ spice: "spicy" }), signals);
    const unassessed = scoreItem(
      { ...item, spiceConfidence: null },
      slot({ spice: "spicy" }),
      signals,
    );
    // Neutral, not zero: it scores below a confirmed match but above a mismatch.
    const mismatch = scoreItem({ ...item, spice: 0 }, slot({ spice: "spicy" }), signals);
    expect(unassessed).toBeLessThan(assessed);
    expect(unassessed).toBeGreaterThan(mismatch);
  });

  test("a softened cuisine still scores above an unrelated one", () => {
    const signals = { nameSim: 0, descSim: 0, tsRank: 0 };
    const preferred = scoreItem(item, slot({ softenedCuisine: "Indian" }), signals);
    const other = scoreItem(item, slot({ softenedCuisine: "Italian" }), signals);
    expect(preferred).toBeGreaterThan(other);
  });

  test("identical inputs score identically -- the vector path never did", () => {
    const signals = { nameSim: 0.4, descSim: 0.1, tsRank: 0.05 };
    expect(scoreItem(item, slot(), signals)).toBe(scoreItem(item, slot(), signals));
  });
});

describe("'and' only splits when the sentence reads like a list", () => {
  test("a conjunction describing ONE dish stays one slot", () => {
    // Splitting this produced a spicy slot with no diet, which then returned
    // chicken to someone who had said vegetarian in the same breath.
    const plan = heuristicPlan("something spicy and vegetarian");
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0]!.diet).toBe("veg");
    expect(plan.slots[0]!.spice).toBe("spicy");
  });

  test("a list with counts still splits", () => {
    expect(heuristicPlan("2 veg and 1 non veg").slots).toHaveLength(2);
  });

  test("a list with commas still splits", () => {
    expect(heuristicPlan("something veg, and something italian").slots).toHaveLength(2);
  });
});
