import { prisma } from "../../db/index.ts";
import { conflict, notFound } from "../lib/errors.ts";
import type { CreateCategoryInput, UpdateCategoryInput } from "../schemas/menu.schema.ts";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const publicCategory = (c: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  _count?: { items: number };
}) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  description: c.description,
  imageUrl: c.imageUrl,
  sortOrder: c.sortOrder,
  isActive: c.isActive,
  ...(c._count ? { itemCount: c._count.items } : {}),
});

/** Public listing hides inactive categories unless explicitly asked. */
export async function listCategories({ includeInactive = false } = {}) {
  const categories = await prisma.category.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { items: true } } },
  });

  return { categories: categories.map(publicCategory) };
}

export async function getCategory(id: string) {
  const category = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { items: true } } },
  });

  if (!category) throw notFound("Category not found", "CATEGORY_NOT_FOUND");
  return { category: publicCategory(category) };
}

export async function createCategory(input: CreateCategoryInput) {
  const slug = slugify(input.name);
  if (!slug) throw conflict("Category name must contain at least one letter or digit", "INVALID_NAME");

  const category = await prisma.category.create({
    data: {
      name: input.name,
      slug,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    },
  });

  return { category: publicCategory(category) };
}

export async function updateCategory(id: string, input: UpdateCategoryInput) {
  const category = await prisma.category.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name, slug: slugify(input.name) } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  return { category: publicCategory(category) };
}

export async function deleteCategory(id: string) {
  const itemCount = await prisma.menuItem.count({ where: { categoryId: id } });

  if (itemCount > 0) {
    throw conflict(
      `Category still has ${itemCount} menu item(s). Move or delete them first.`,
      "CATEGORY_NOT_EMPTY",
    );
  }

  await prisma.category.delete({ where: { id } });
}
