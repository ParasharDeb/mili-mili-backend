import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../db/index.ts";
import type { Slot } from "../schemas/menu.schema.ts";
import { DRINK_COURSES, FOOD_COURSES } from "../domain/menu.constants.ts";
import { abvAllows, buildWhere } from "./menu.filter.ts";
import { abvRange } from "../domain/abv.ts";
import { contentWords, rankBy, scoreItem, type RankSignals } from "./menu.rank.ts";
import { toPublicItem, type PublicItem } from "./menu.items.service.ts";

/**
 * All menu retrieval. Replaces src/lib/pinecone.ts.
 *
 * Hard constraints are a Prisma `where` built by menu.filter.ts. The lexical
 * signals come from Postgres -- pg_trgm's `similarity`/`word_similarity` and
 * `ts_rank_cd` over the generated `search_vector` column -- because Postgres
 * already implements them and an index exists for them. The weighted
 * combination happens in menu.rank.ts, which stays a pure function.
 */

/** Row shape the raw queries return: snake_case columns plus the signals. */
type RawRow = {
  id: string;
  name: string;
  desc: string | null;
  price: Prisma.Decimal;
  cuisine: string;
  course: string;
  diet: string;
  protein: string;
  spice: number;
  spice_confidence: number | null;
  taste_tags: string[];
  tags: string[];
  popularity: number;
  allergens: string[];
  allergens_verified: boolean;
  serves_min: number;
  serves_max: number;
  image_url: string | null;
  name_sim?: number;
  desc_sim?: number;
  ts_rank?: number;
  sim?: number;
  kind?: string;
};

export type CandidateRow = PublicItem & {
  popularity: number;
  price: number;
  score: number;
  signals: RankSignals;
};

const SELECT_COLUMNS = Prisma.sql`
  i.id, i.name, i."desc", i.price, i.cuisine::text, i.course::text, i.diet::text,
  i.protein::text, i.spice, i.spice_confidence, i.taste_tags, i.tags,
  i.popularity, i.allergens, i.allergens_verified, i.serves_min, i.serves_max,
  i.image_url
`;

function toPublic(row: RawRow): PublicItem {
  return toPublicItem({
    id: row.id,
    name: row.name,
    desc: row.desc,
    price: row.price,
    cuisine: row.cuisine,
    course: row.course,
    diet: row.diet,
    protein: row.protein,
    spice: row.spice,
    spiceConfidence: row.spice_confidence,
    tasteTags: row.taste_tags,
    tags: row.tags,
    popularity: row.popularity,
    allergens: row.allergens,
    allergensVerified: row.allergens_verified,
    servesMin: row.serves_min,
    servesMax: row.serves_max,
    imageUrl: row.image_url,
  });
}

/**
 * Translates the Prisma `where` menu.filter.ts produces into a SQL fragment.
 *
 * Deliberately narrow: it only understands the handful of clause shapes
 * `buildWhere` can emit. Anything unexpected throws rather than being silently
 * dropped -- a diet clause that quietly disappears is how a vegetarian gets
 * served chicken.
 */
function whereToSql(where: Prisma.ItemWhereInput): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  for (const [column, value] of Object.entries(where)) {
    switch (column) {
      case "isActive":
        clauses.push(Prisma.sql`i.is_active = ${value as boolean}`);
        break;
      case "isAvailable":
        clauses.push(Prisma.sql`i.is_available = ${value as boolean}`);
        break;
      case "soldOut":
        clauses.push(Prisma.sql`i.sold_out = ${value as boolean}`);
        break;
      case "cuisine":
        clauses.push(Prisma.sql`i.cuisine::text = ${value as string}`);
        break;
      case "diet": {
        const list = (value as { in: string[] }).in;
        clauses.push(Prisma.sql`i.diet::text IN (${Prisma.join(list)})`);
        break;
      }
      case "course": {
        const list = (value as { in: string[] }).in;
        clauses.push(Prisma.sql`i.course::text IN (${Prisma.join(list)})`);
        break;
      }
      case "spice": {
        const range = value as { gte?: number; lte?: number };
        if (range.gte != null) clauses.push(Prisma.sql`i.spice >= ${range.gte}`);
        if (range.lte != null) clauses.push(Prisma.sql`i.spice <= ${range.lte}`);
        break;
      }
      default:
        throw new Error(`whereToSql: unhandled column "${column}"`);
    }
  }

  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

/**
 * Candidates for one slot, ranked.
 *
 * `limit` is generous on purpose. The whole table is a few hundred rows, so a
 * tight SQL-side cap buys nothing and risks cutting a dish the full scoring
 * formula would have ranked first -- the ORDER BY here only exists to make the
 * LIMIT sane, it is not the authoritative ranking.
 */
export async function findCandidates(
  slot: Slot,
  opts: {
    includeDrinks: boolean;
    limit?: number;
    orderableOnly?: boolean;
    excludeIds?: string[];
  },
): Promise<CandidateRow[]> {
  const where = buildWhere(slot, {
    includeDrinks: opts.includeDrinks,
    orderableOnly: opts.orderableOnly,
  });

  const filters: Prisma.Sql[] = [whereToSql(where)];
  if (opts.excludeIds?.length) {
    filters.push(Prisma.sql`i.id NOT IN (${Prisma.join(opts.excludeIds)})`);
  }

  const q = slot.searchText;
  const limit = opts.limit ?? 100;
  // ABV and drink style are filtered after SQL (they are derived, not columns),
  // so a SQL LIMIT would cut the bar -- ~250 rows -- before the filter ever saw
  // the Old Fashioned. Fetch the whole eligible set and trim after ranking.
  const postFiltered =
    slot.course === "Alcohol" || slot.course === "Beverage" ||
    slot.drinkStyle != null || abvRange(slot) != null;
  const sqlLimit = postFiltered ? 1000 : limit;
  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS},
           similarity(i.name, ${q})                           AS name_sim,
           similarity(coalesce(i."desc", ''), ${q})           AS desc_sim,
           ts_rank_cd(i.search_vector,
                      websearch_to_tsquery('english', ${q}))  AS ts_rank
    FROM items i
    WHERE ${Prisma.join(filters, " AND ")}
    ORDER BY GREATEST(similarity(i.name, ${q}),
                      similarity(coalesce(i."desc", ''), ${q})) DESC,
             i.popularity DESC,
             i.name ASC
    LIMIT ${sqlLimit}
  `);

  // ABV is derived, not a column, so strength is filtered here rather than in
  // SQL. The table is a few hundred rows and the limit exceeds it, so nothing
  // eligible was cut before this runs.
  const eligible = rows
    .map((row) => ({ row, item: toPublic(row) }))
    .filter(({ item }) => abvAllows(slot, item.abv, item.drinkStyle));

  const scored = eligible.map(({ row, item }) => {
    const signals: RankSignals = {
      nameSim: Number(row.name_sim ?? 0),
      descSim: Number(row.desc_sim ?? 0),
      tsRank: Number(row.ts_rank ?? 0),
    };
    return {
      ...item,
      popularity: row.popularity,
      price: item.price ?? 0,
      signals,
      score: scoreItem(
        {
          name: row.name,
          desc: row.desc,
          cuisine: row.cuisine,
          protein: row.protein,
          spice: row.spice,
          spiceConfidence: row.spice_confidence,
          tasteTags: row.taste_tags,
          tags: row.tags,
          popularity: row.popularity,
          abv: item.abv,
        },
        slot,
        signals,
      ),
    };
  });

  return rankBy(scored).slice(0, limit);
}

export type NameMatch = {
  item: PublicItem;
  similarity: number;
  matchKind: "exact" | "prefix" | "fuzzy";
};

/**
 * Typo-tolerant single-dish lookup: "butter nan", "chiken popcorn".
 *
 * Two stages, so an exact hit never loses to a fuzzy one. `word_similarity` is
 * what makes "chicken popcorn" find "Popcorn Chicken with Sriracha Mayo" --
 * plain `similarity` divides by the whole string length and punishes long names.
 * `%` and `<%` are the operators the GIN trigram index can serve; `similarity()`
 * in a WHERE clause would force a sequential scan.
 */
export async function findByName(
  text: string,
  opts: { limit?: number; minSimilarity?: number; orderableOnly?: boolean } = {},
): Promise<NameMatch[]> {
  const q = text.trim();
  if (!q) return [];

  const limit = opts.limit ?? 5;
  const orderable =
    opts.orderableOnly === false
      ? Prisma.sql`TRUE`
      : Prisma.sql`i.is_active AND i.is_available AND NOT i.sold_out`;

  const exact = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS}, 1.0::float8 AS sim, 'exact' AS kind
    FROM items i WHERE ${orderable} AND lower(i.name) = lower(${q})
    UNION ALL
    SELECT ${SELECT_COLUMNS}, 0.95::float8 AS sim, 'prefix' AS kind
    FROM items i WHERE ${orderable} AND i.name ILIKE ${q + "%"}
                   AND lower(i.name) <> lower(${q})
    LIMIT ${limit}
  `);

  if (exact.length > 0) {
    return exact.map((row) => ({
      item: toPublic(row),
      similarity: Number(row.sim),
      matchKind: row.kind as NameMatch["matchKind"],
    }));
  }

  const fuzzy = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS},
           GREATEST(similarity(i.name, ${q}), word_similarity(${q}, i.name))::float8 AS sim
    FROM items i
    WHERE ${orderable} AND (i.name % ${q} OR ${q} <% i.name)
    ORDER BY sim DESC, i.popularity DESC, i.name ASC
    LIMIT ${limit}
  `);

  const floor = opts.minSimilarity ?? 0.25;
  return fuzzy
    .filter((row) => Number(row.sim) >= floor)
    .map((row) => ({
      item: toPublic(row),
      similarity: Number(row.sim),
      matchKind: "fuzzy" as const,
    }));
}

export type DishResolution =
  | { status: "resolved"; item: PublicItem }
  | { status: "ambiguous"; candidates: PublicItem[] }
  | { status: "none" };

/**
 * A verdict rather than a list, for the order-confirmation path.
 *
 * Two near-equal candidates return `ambiguous` instead of a winner. Guessing
 * between "Butter Chicken" and "Butter Chicken Biryani" when someone said "yes,
 * order it" puts the wrong dish on a real bill.
 */
export async function resolveDish(text: string): Promise<DishResolution> {
  const matches = await findByName(text, { limit: 5 });
  if (matches.length === 0) return { status: "none" };

  const [best, second] = matches;
  if (!second || best!.similarity - second.similarity > 0.08) {
    return { status: "resolved", item: best!.item };
  }

  const tied = matches.filter((m) => best!.similarity - m.similarity <= 0.08);
  return { status: "ambiguous", candidates: tied.map((m) => m.item) };
}

/**
 * Grounding set for menu Q&A. Replaces the unfiltered top-8 vector query, which
 * had no way to respect "without dairy" or "on the food menu".
 */
export async function searchItems(
  question: string,
  opts: { limit?: number; includeDrinks?: boolean } = {},
): Promise<PublicItem[]> {
  const words = contentWords(question);
  const q = words.join(" ") || question.trim();
  const courses = opts.includeDrinks
    ? [...FOOD_COURSES, ...DRINK_COURSES]
    : [...FOOD_COURSES];

  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS},
           GREATEST(
             similarity(i.name, ${q}),
             word_similarity(${q}, i.name),
             ts_rank_cd(i.search_vector, websearch_to_tsquery('english', ${q})) * 4
           )::float8 AS sim
    FROM items i
    WHERE i.is_active AND i.is_available AND NOT i.sold_out
      AND i.course::text IN (${Prisma.join(courses)})
    ORDER BY sim DESC, i.popularity DESC, i.name ASC
    LIMIT ${opts.limit ?? 8}
  `);

  return rows.map(toPublic);
}

/** Every orderable dish in the given courses, for the pairing affinity ranker. */
export async function findPairingCandidates(
  targetCourses: readonly string[],
  excludeId: string,
): Promise<PublicItem[]> {
  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS}
    FROM items i
    WHERE i.is_active AND i.is_available AND NOT i.sold_out
      AND i.course::text IN (${Prisma.join([...targetCourses])})
      AND i.id <> ${excludeId}
  `);
  return rows.map(toPublic);
}

/**
 * The menu as the advisory path sees it.
 *
 * There are only ~81 food rows, so the whole food menu fits in a prompt with
 * room to spare and no pre-filtering is needed to make it fit. A diet or course
 * filter is still applied when the guest stated one -- not for the token budget,
 * but because a filter makes it structurally impossible for the model to suggest
 * paneer for "a good non-veg combo".
 */
export async function getMenuForAdvice(opts: {
  diet?: string;
  includeDrinks?: boolean;
  limit?: number;
}): Promise<PublicItem[]> {
  const slot = {
    label: "advice", count: 1,
    diet: (opts.diet ?? "any") as Slot["diet"],
    spice: "any" as const,
    cuisine: "any" as const,
    course: "any" as const,
    courseGroup: (opts.includeDrinks ? "drink" : "food") as Slot["courseGroup"],
    searchText: "menu",
  } satisfies Slot;

  const where = buildWhere(slot, { includeDrinks: false });

  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS}
    FROM items i
    WHERE ${whereToSql(where)}
    -- Deterministic priority, so a cap never silently deletes a whole course:
    -- described dishes first, then assessed heat, then the menu's own order.
    ORDER BY (i."desc" IS NOT NULL AND i."desc" <> '') DESC,
             (i.spice_confidence >= 0.5) DESC,
             i.course, i.popularity DESC, i.name
    LIMIT ${opts.limit ?? 200}
  `);

  return rows.map(toPublic);
}

/**
 * Every orderable dish, for the combo composer.
 *
 * No cap and no course pre-filter: the point of the combo path is that the
 * model sees the whole kitchen and pairs real names ("Murgh Makhani" with a
 * kulcha) rather than a keyword-matched slice. Diet is still a hard SQL filter,
 * for the same reason getMenuForAdvice keeps it.
 */
export async function getFullMenu(opts: { diet?: string; includeDrinks?: boolean }): Promise<PublicItem[]> {
  const slot = {
    label: "combo", count: 1,
    diet: (opts.diet ?? "any") as Slot["diet"],
    spice: "any" as const,
    cuisine: "any" as const,
    course: "any" as const,
    courseGroup: "any" as const,
    searchText: "menu",
  } satisfies Slot;

  // Diet restricts food only. Every drink is stored as Vegetarian, so a
  // `nonveg` filter -- which asks FOR meat -- would otherwise empty the bar.
  const foodWhere = whereToSql(buildWhere(slot, { includeDrinks: true }));
  const drinkWhere = whereToSql(buildWhere({ ...slot, diet: "any" }, { includeDrinks: true }));

  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${SELECT_COLUMNS}
    FROM items i
    WHERE (${foodWhere} AND i.course::text IN (${Prisma.join([...FOOD_COURSES])}))
       OR (${opts.includeDrinks ? Prisma.sql`TRUE` : Prisma.sql`FALSE`}
           AND ${drinkWhere} AND i.course::text IN ('Beverage', 'Alcohol'))
    ORDER BY i.course, i.cuisine, i.popularity DESC, i.name
  `);

  return rows.map(toPublic);
}
