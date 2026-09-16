import { prisma } from "../../db/index.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import type { CreateMenuItemInput, UpdateMenuItemInput } from "../schemas/menu.schema.ts";

interface MenuItemRow {
  id: string;
  name: string;
  description: string | null;
  price: { toFixed(dp: number): string };
  imageUrl: string | null;
  isAvailable: boolean;
  categoryId: string;
  category?: { id: string; name: string; slug: string } | null;
}

// Decimal -> fixed 2dp string, so no precision is lost crossing JSON.
const publicMenuItem = (item: MenuItemRow) => ({
  id: item.id,
  name: item.name,
  description: item.description,
  price: item.price.toFixed(2),
  imageUrl: item.imageUrl,
  isAvailable: item.isAvailable,
  categoryId: item.categoryId,
  ...(item.category ? { category: item.category } : {}),
});

const categorySelect = { select: { id: true, name: true, slug: true } };

export async function listMenuItems({
  categoryId,
  includeUnavailable = false,
}: { categoryId?: string; includeUnavailable?: boolean } = {}) {
  const items = await prisma.menuItem.findMany({
    where: {
      ...(categoryId ? { categoryId } : {}),
      ...(includeUnavailable ? {} : { isAvailable: true }),
    },
    orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    include: { category: categorySelect },
  });

  return { items: items.map(publicMenuItem) };
}

export async function getMenuItem(id: string) {
  const item = await prisma.menuItem.findUnique({
    where: { id },
    include: { category: categorySelect },
  });

  if (!item) throw notFound("Menu item not found", "MENU_ITEM_NOT_FOUND");
  return { item: publicMenuItem(item) };
}

export async function createMenuItem(input: CreateMenuItemInput) {
  const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
  if (!category) throw badRequest("No category with that id", "CATEGORY_NOT_FOUND");

  const item = await prisma.menuItem.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      imageUrl: input.imageUrl ?? null,
      isAvailable: input.isAvailable ?? true,
      categoryId: input.categoryId,
    },
    include: { category: categorySelect },
  });

  return { item: publicMenuItem(item) };
}

/**
 * Admin edit: name, price, image, description. `null` clears an optional field,
 * `undefined` (omitted) leaves it untouched.
 */
export async function updateMenuItem(id: string, input: UpdateMenuItemInput) {
  if (input.categoryId !== undefined) {
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category) throw badRequest("No category with that id", "CATEGORY_NOT_FOUND");
  }

  const item = await prisma.menuItem.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    },
    include: { category: categorySelect },
  });

  return { item: publicMenuItem(item) };
}

export async function deleteMenuItem(id: string) {
  await prisma.menuItem.delete({ where: { id } });
}
