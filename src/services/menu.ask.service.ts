import { env } from "../lib/env.ts";
import { chatText } from "../lib/mistral.ts";
import { SPICE_MIN_CONFIDENCE } from "../domain/menu.constants.ts";
import { findByName, searchItems } from "./menu.sql.service.ts";
import type { PublicItem } from "./menu.items.service.ts";

/**
 * Grounded answering for menu questions -- "what is in the biryani", "anything
 * without dairy".
 *
 * The model only ever sees dishes we retrieved, and is told to say so when the
 * answer is not among them. Inventing a dish on a restaurant menu is worse than
 * admitting ignorance: a guest could order something that does not exist, or be
 * told a dish is nut-free when nobody checked.
 */

const SYSTEM_PROMPT = `You are the pass at Milli, a restaurant. A guest is asking about the menu.

Answer ONLY from the dishes listed in the context. Rules:
- Never invent a dish, price, ingredient or allergen. If the context does not cover
  the question, say plainly that you cannot see it on tonight's menu.
- Be warm and brief: 2 to 4 sentences, no headings, no bullet lists.
- Refer to dishes by their exact name from the context.
- Spice is on a 0 to 5 scale. Where a dish shows "spice unconfirmed", do not state
  a heat level -- say it is not recorded.
- You may quote a price when the context gives one, exactly as written.
- For allergen questions: the tags shown are merchandising labels, not a verified
  allergen list. Say what the menu records, and add that the kitchen should
  confirm before ordering.`;

function renderContext(items: PublicItem[]): string {
  return items
    .map((i) => {
      const bits = [
        i.desc?.trim() || "no description recorded",
        i.diet,
        i.cuisine,
        i.course,
        i.spiceConfidence != null && i.spiceConfidence >= SPICE_MIN_CONFIDENCE
          ? `spice ${i.spice}/5`
          : "spice unconfirmed",
      ];
      if (i.price != null) bits.push(`₹${Math.round(i.price)}`);
      if (i.servesMax > 1) bits.push(`serves ${i.servesMin}-${i.servesMax}`);
      if (i.tasteTags.length) bits.push(`tastes ${i.tasteTags.join(", ")}`);
      if (i.tags.length) bits.push(`menu tags: ${i.tags.join(", ")}`);
      return `- ${i.name} (${bits.join("; ")})`;
    })
    .join("\n");
}

/**
 * `named` is the dish the router believes the guest mentioned by name.
 *
 * Retrieval used to be an unfiltered top-8 vector query, which meant "what is in
 * the butter naan" was answered from eight dishes that merely read similarly.
 * An exact name match now leads the context, so the dish the guest asked about
 * is always in it.
 */
export async function ask(
  question: string,
  opts: { named?: boolean; includeDrinks?: boolean } = {},
): Promise<{ answer: string; dishes: PublicItem[]; chips: string[] }> {
  const dishes: PublicItem[] = [];
  const seen = new Set<string>();

  if (opts.named !== false) {
    for (const match of await findByName(question, { limit: 3 })) {
      if (!seen.has(match.item.id)) {
        seen.add(match.item.id);
        dishes.push(match.item);
      }
    }
  }

  for (const item of await searchItems(question, {
    limit: 8,
    includeDrinks: opts.includeDrinks,
  })) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      dishes.push(item);
    }
  }

  if (dishes.length === 0) {
    return {
      answer:
        "I could not find anything on tonight's menu that matches. Try naming a dish, or tell me what you feel like eating.",
      dishes: [],
      chips: ["What is vegetarian?", "Something spicy", "What should we order for four?"],
    };
  }

  const answer = await chatText([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Dishes on the menu that may be relevant:\n${renderContext(dishes.slice(0, 10))}\n\nGuest asks: ${question}`,
    },
  ]);

  return {
    answer,
    // The few the answer most likely leans on, for the UI to show as cards.
    dishes: dishes.slice(0, 3),
    chips: buildChips(dishes),
  };
}

function buildChips(dishes: PublicItem[]): string[] {
  const chips: string[] = [];
  const first = dishes[0];
  if (first) chips.push(`Is ${first.name} spicy?`);
  if (dishes.some((d) => d.diet === "Vegetarian")) chips.push("What else is vegetarian?");
  chips.push("What should we order for four?");
  return chips.slice(0, 3);
}

export const ASK_MODEL = env.MISTRAL_CHAT_MODEL;
