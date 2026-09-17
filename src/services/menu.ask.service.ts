import { prisma } from "../../db/index.ts";
import { env } from "../lib/env.ts";
import { chatText, embed } from "../lib/mistral.ts";
import { queryItems } from "../lib/pinecone.ts";
import { toPublicItem, type PublicItem } from "./menu.items.service.ts";

/**
 * Retrieval-augmented answering for menu questions that are not party
 * recommendations -- "what is in the biryani", "anything without dairy".
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
- For allergen questions, answer from the listed tags only, and add that the
  kitchen should confirm before ordering.`;

function renderContext(items: PublicItem[]): string {
  return items
    .map((i) => {
      const bits = [
        i.desc?.trim() || "no description recorded",
        i.diet,
        i.cuisine,
        i.course,
        i.spiceConfidence != null && i.spiceConfidence >= 0.5
          ? `spice ${i.spice}/5`
          : "spice unconfirmed",
      ];
      if (i.tasteTags.length) bits.push(`tastes ${i.tasteTags.join(", ")}`);
      if (i.allergens) bits.push(`tags: ${i.allergens}`);
      return `- ${i.name} (${bits.join("; ")})`;
    })
    .join("\n");
}

export async function ask(question: string): Promise<{
  answer: string;
  dishes: PublicItem[];
  chips: string[];
}> {
  const [vector] = await embed([question]);
  const matches = await queryItems(vector!, undefined, 8);

  if (matches.length === 0) {
    return {
      answer: "I could not find anything on tonight's menu that matches. Try naming a dish, or tell me what you feel like eating.",
      dishes: [],
      chips: ["What is vegetarian?", "Something spicy", "What should we order for four?"],
    };
  }

  const rows = await prisma.item.findMany({ where: { id: { in: matches.map((m) => m.id) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Keep Pinecone's ranking; findMany returns arbitrary order.
  const dishes = matches
    .map((m) => byId.get(m.id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map(toPublicItem);

  const answer = await chatText([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Dishes on the menu that may be relevant:\n${renderContext(dishes)}\n\nGuest asks: ${question}`,
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
  if (dishes.some((d) => d.diet === "Vegeterian")) chips.push("What else is vegetarian?");
  chips.push("What should we order for four?");
  return chips.slice(0, 3);
}

export const ASK_MODEL = env.MISTRAL_CHAT_MODEL;
