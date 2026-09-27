-- CreateEnum
CREATE TYPE "GuestRequestTypeEnum" AS ENUM ('hard_stop', 'issue', 'call_manager', 'call_captain', 'reservation', 'music');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_review_ask_at" TIMESTAMP(3),
ADD COLUMN     "last_visit_at" TIMESTAMP(3),
ADD COLUMN     "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketing_opt_in_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "guest_requests" (
    "id" TEXT NOT NULL,
    "type" "GuestRequestTypeEnum" NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "overall" INTEGER NOT NULL,
    "food" INTEGER NOT NULL,
    "service" INTEGER NOT NULL,
    "ambience" INTEGER NOT NULL,
    "cleanliness" INTEGER NOT NULL,
    "comment" TEXT,
    "quick" BOOLEAN NOT NULL DEFAULT false,
    "escalate" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_requests_type_created_at_idx" ON "guest_requests"("type", "created_at");

-- CreateIndex
CREATE INDEX "guest_requests_session_id_idx" ON "guest_requests"("session_id");

-- CreateIndex
CREATE INDEX "feedback_session_id_idx" ON "feedback"("session_id");

-- CreateIndex
CREATE INDEX "feedback_escalate_created_at_idx" ON "feedback"("escalate", "created_at");

