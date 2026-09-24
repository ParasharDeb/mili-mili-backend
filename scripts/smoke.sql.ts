import { findCandidates, findByName, resolveDish, searchItems, getMenuForAdvice } from "../src/services/menu.sql.service.ts";
import { prisma } from "../db/index.ts";

const slot = (o: any) => ({
  label: "t", count: 1, diet: "any", spice: "any", cuisine: "any",
  course: "any", courseGroup: "food", searchText: "dish", ...o,
});

console.log("=== 1. Indian non-veg ===");
const a = await findCandidates(slot({ diet: "nonveg", cuisine: "Indian", searchText: "indian non-vegetarian dish" }), { includeDrinks: false });
console.log(`${a.length} candidates`);
for (const r of a.slice(0, 5)) console.log(`  ${r.score.toFixed(3)} ${r.name} [${r.diet}/${r.cuisine}/${r.course}] spice ${r.spice} ₹${r.price}`);
console.log("  violations:", a.filter(r => !["NonVegetarian","OnlyFish"].includes(r.diet)).length);

console.log("\n=== 2. spicy veg starter ===");
const b = await findCandidates(slot({ diet: "veg", spice: "spicy", course: "Starter", searchText: "spicy vegetarian starter" }), { includeDrinks: false });
console.log(`${b.length} candidates`);
for (const r of b.slice(0, 4)) console.log(`  ${r.score.toFixed(3)} ${r.name} spice ${r.spice}`);
console.log("  violations:", b.filter(r => !["Vegetarian","Jain"].includes(r.diet)).length);

console.log("\n=== 3. unconstrained (stopword guard) ===");
const c = await findCandidates(slot({ searchText: "popular dish to share" }), { includeDrinks: false });
console.log(`${c.length} candidates, top:`);
for (const r of c.slice(0, 4)) console.log(`  ${r.score.toFixed(3)} ${r.name} pop=${r.popularity}`);

console.log("\n=== 4. findByName typos ===");
for (const q of ["buter nan", "chiken popcorn", "Butter Naan", "dal makh"]) {
  const m = await findByName(q);
  console.log(`  "${q}" -> ${m.slice(0,2).map(x => `${x.item.name} (${x.matchKind} ${x.similarity.toFixed(2)})`).join(", ") || "none"}`);
}

console.log("\n=== 5. resolveDish ===");
for (const q of ["butter naan", "chicken", "zzzz nonexistent"]) {
  const r = await resolveDish(q);
  console.log(`  "${q}" -> ${r.status}${r.status==="resolved"?": "+r.item.name:r.status==="ambiguous"?": "+r.candidates.map(c=>c.name).join(" | "):""}`);
}

console.log("\n=== 6. searchItems (Q&A grounding) ===");
const s = await searchItems("what is in the butter naan");
console.log("  " + s.slice(0,4).map(i=>i.name).join(", "));

console.log("\n=== 7. advisory menu size ===");
const all = await getMenuForAdvice({});
const nv = await getMenuForAdvice({ diet: "nonveg" });
const line = (i:any)=>`${i.name}|${i.diet}|${i.cuisine}|${i.course}|h${i.spice}|${i.tasteTags.join(",")}`;
const chars = all.map(line).join("\n").length;
console.log(`  all food: ${all.length} items, ~${chars} chars ~= ${Math.round(chars/4)} tokens`);
console.log(`  non-veg only: ${nv.length} items`);
console.log("  sample:", line(all[0]));

await prisma.$disconnect();
