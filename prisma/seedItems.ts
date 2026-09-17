import { readFile } from "node:fs/promises";
import { prisma } from "../db/index.ts";
import { classifyItem, type SourceItem } from "./classifyItem.ts";

const raw = await readFile(new URL("../data.json", import.meta.url), "utf8");
const sourceItems: SourceItem[] = JSON.parse(raw);

let count = 0;
for (const source of sourceItems) {
  const item = classifyItem(source);
  await prisma.item.upsert({
    where: { id: item.id },
    create: item,
    update: item,
  });
  count++;
}

console.log(`Seeded ${count} items from data.json`);
await prisma.$disconnect();
