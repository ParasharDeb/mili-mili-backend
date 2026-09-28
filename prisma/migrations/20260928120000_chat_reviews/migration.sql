-- CreateEnum
CREATE TYPE "ReviewSentimentEnum" AS ENUM ('positive', 'negative', 'mixed');

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "message" TEXT NOT NULL,
    "sentiment" "ReviewSentimentEnum" NOT NULL,
    "item_id" TEXT,
    "item_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_created_at_idx" ON "reviews"("created_at");

-- CreateIndex
CREATE INDEX "reviews_sentiment_created_at_idx" ON "reviews"("sentiment", "created_at");
