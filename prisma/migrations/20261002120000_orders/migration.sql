-- CreateEnum
CREATE TYPE "OrderStatusEnum" AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "table_number" TEXT,
    "phone" TEXT,
    "guest_name" TEXT,
    "note" TEXT,
    "lines" JSONB NOT NULL,
    "item_count" INTEGER NOT NULL,
    "subtotal" DECIMAL(10,2),
    "status" "OrderStatusEnum" NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "kcpl_status" TEXT NOT NULL DEFAULT 'skipped',
    "kcpl_ref" TEXT,
    "kcpl_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_code_key" ON "orders"("code");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "orders_session_id_idx" ON "orders"("session_id");
