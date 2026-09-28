/*
  Warnings:

  - You are about to drop the `receipt_counters` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "receipt_counters";

-- CreateTable
CREATE TABLE "counters" (
    "scope" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("scope","businessDate")
);
