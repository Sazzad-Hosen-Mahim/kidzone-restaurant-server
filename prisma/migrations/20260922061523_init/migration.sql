-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'KIDZONE_MANAGER', 'RESTAURANT_CASHIER');

-- CreateEnum
CREATE TYPE "Section" AS ENUM ('KIDZONE', 'RESTAURANT');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('MEMBERSHIP', 'SESSION');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('OTP', 'QR', 'GATEPASS', 'MANUAL_OVERRIDE');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('CHECK_IN', 'PHONE_VERIFY');

-- CreateEnum
CREATE TYPE "SmsType" AS ENUM ('OTP', 'GATEPASS', 'EXPIRY_REMINDER', 'RECEIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BKASH', 'NAGAD', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "children" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "gender" "Gender",
    "medicalNotes" TEXT,
    "emergencyContactName" TEXT NOT NULL,
    "emergencyContactPhone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "children_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kidzone_plans" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PlanType" NOT NULL,
    "price" INTEGER NOT NULL,
    "durationDays" INTEGER,
    "sessionMinutes" INTEGER,
    "includesSnackBox" BOOLEAN NOT NULL DEFAULT false,
    "requiresVerification" BOOLEAN NOT NULL DEFAULT false,
    "overtimeBlockMinutes" INTEGER,
    "overtimeRatePerBlock" INTEGER,
    "gracePeriodMinutes" INTEGER NOT NULL DEFAULT 10,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kidzone_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_price_history" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "oldPrice" INTEGER NOT NULL,
    "newPrice" INTEGER NOT NULL,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kidzone_sales" (
    "id" UUID NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "customerId" UUID NOT NULL,
    "childId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "planNameSnapshot" TEXT NOT NULL,
    "unitPriceSnapshot" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "totalAmount" INTEGER NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "soldById" UUID NOT NULL,
    "voidedById" UUID,
    "voidReason" TEXT,
    "voidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kidzone_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "childId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "qrToken" TEXT NOT NULL,
    "renewedFromId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "customerId" UUID NOT NULL,
    "childId" UUID NOT NULL,
    "membershipId" UUID,
    "saleId" UUID,
    "gatepassNo" TEXT NOT NULL,
    "checkInAt" TIMESTAMPTZ(6) NOT NULL,
    "expectedCheckOutAt" TIMESTAMPTZ(6),
    "checkOutAt" TIMESTAMPTZ(6),
    "verificationMethod" "VerificationMethod" NOT NULL,
    "overrideReason" TEXT,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeCharge" INTEGER NOT NULL DEFAULT 0,
    "status" "VisitStatus" NOT NULL DEFAULT 'ACTIVE',
    "checkedInById" UUID NOT NULL,
    "checkedOutById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "type" "SmsType" NOT NULL,
    "message" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expiry_reminder_logs" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "daysBefore" INTEGER NOT NULL,
    "sentOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiry_reminder_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "sku" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_price_history" (
    "id" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "oldPrice" INTEGER NOT NULL,
    "newPrice" INTEGER NOT NULL,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "customerId" UUID,
    "tableNo" TEXT,
    "subtotal" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "vatPercent" DECIMAL(5,2) NOT NULL,
    "vatAmount" INTEGER NOT NULL,
    "serviceChargePercent" DECIMAL(5,2) NOT NULL,
    "serviceChargeAmount" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PAID',
    "cashierId" UUID NOT NULL,
    "voidedById" UUID,
    "voidReason" TEXT,
    "voidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "itemNameSnapshot" TEXT NOT NULL,
    "unitPriceSnapshot" INTEGER NOT NULL,
    "categoryNameSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT,
    "kidZoneSaleId" UUID,
    "orderId" UUID,
    "visitId" UUID,
    "receivedById" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_closings" (
    "id" UUID NOT NULL,
    "section" "Section" NOT NULL,
    "businessDate" DATE NOT NULL,
    "expectedCash" INTEGER NOT NULL,
    "countedCash" INTEGER NOT NULL,
    "difference" INTEGER NOT NULL,
    "expectedByMethod" JSONB NOT NULL,
    "totalSales" INTEGER NOT NULL,
    "totalVoids" INTEGER NOT NULL,
    "totalDiscounts" INTEGER NOT NULL,
    "transactionCount" INTEGER NOT NULL,
    "notes" TEXT,
    "closedById" UUID NOT NULL,
    "closedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedAt" TIMESTAMPTZ(6),
    "reopenedById" UUID,
    "reopenReason" TEXT,

    CONSTRAINT "day_closings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "receipt_counters" (
    "section" "Section" NOT NULL,
    "businessDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("section","businessDate")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_createdAt_idx" ON "refresh_tokens"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- CreateIndex
CREATE INDEX "customers_isActive_idx" ON "customers"("isActive");

-- CreateIndex
CREATE INDEX "customers_createdAt_idx" ON "customers"("createdAt");

-- CreateIndex
CREATE INDEX "children_customerId_idx" ON "children"("customerId");

-- CreateIndex
CREATE INDEX "children_name_idx" ON "children"("name");

-- CreateIndex
CREATE INDEX "children_createdAt_idx" ON "children"("createdAt");

-- CreateIndex
CREATE INDEX "kidzone_plans_type_idx" ON "kidzone_plans"("type");

-- CreateIndex
CREATE INDEX "kidzone_plans_isActive_idx" ON "kidzone_plans"("isActive");

-- CreateIndex
CREATE INDEX "kidzone_plans_createdAt_idx" ON "kidzone_plans"("createdAt");

-- CreateIndex
CREATE INDEX "plan_price_history_planId_idx" ON "plan_price_history"("planId");

-- CreateIndex
CREATE INDEX "plan_price_history_changedById_idx" ON "plan_price_history"("changedById");

-- CreateIndex
CREATE INDEX "plan_price_history_changedAt_idx" ON "plan_price_history"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "kidzone_sales_receiptNo_key" ON "kidzone_sales"("receiptNo");

-- CreateIndex
CREATE INDEX "kidzone_sales_businessDate_idx" ON "kidzone_sales"("businessDate");

-- CreateIndex
CREATE INDEX "kidzone_sales_customerId_idx" ON "kidzone_sales"("customerId");

-- CreateIndex
CREATE INDEX "kidzone_sales_childId_idx" ON "kidzone_sales"("childId");

-- CreateIndex
CREATE INDEX "kidzone_sales_planId_idx" ON "kidzone_sales"("planId");

-- CreateIndex
CREATE INDEX "kidzone_sales_soldById_idx" ON "kidzone_sales"("soldById");

-- CreateIndex
CREATE INDEX "kidzone_sales_voidedById_idx" ON "kidzone_sales"("voidedById");

-- CreateIndex
CREATE INDEX "kidzone_sales_status_idx" ON "kidzone_sales"("status");

-- CreateIndex
CREATE INDEX "kidzone_sales_createdAt_idx" ON "kidzone_sales"("createdAt");

-- CreateIndex
CREATE INDEX "kidzone_sales_businessDate_status_idx" ON "kidzone_sales"("businessDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_saleId_key" ON "memberships"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_qrToken_key" ON "memberships"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_renewedFromId_key" ON "memberships"("renewedFromId");

-- CreateIndex
CREATE INDEX "memberships_customerId_idx" ON "memberships"("customerId");

-- CreateIndex
CREATE INDEX "memberships_childId_idx" ON "memberships"("childId");

-- CreateIndex
CREATE INDEX "memberships_planId_idx" ON "memberships"("planId");

-- CreateIndex
CREATE INDEX "memberships_status_idx" ON "memberships"("status");

-- CreateIndex
CREATE INDEX "memberships_endDate_idx" ON "memberships"("endDate");

-- CreateIndex
CREATE INDEX "memberships_createdAt_idx" ON "memberships"("createdAt");

-- CreateIndex
CREATE INDEX "memberships_status_endDate_idx" ON "memberships"("status", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "visits_gatepassNo_key" ON "visits"("gatepassNo");

-- CreateIndex
CREATE INDEX "visits_businessDate_idx" ON "visits"("businessDate");

-- CreateIndex
CREATE INDEX "visits_customerId_idx" ON "visits"("customerId");

-- CreateIndex
CREATE INDEX "visits_childId_idx" ON "visits"("childId");

-- CreateIndex
CREATE INDEX "visits_membershipId_idx" ON "visits"("membershipId");

-- CreateIndex
CREATE INDEX "visits_saleId_idx" ON "visits"("saleId");

-- CreateIndex
CREATE INDEX "visits_checkedInById_idx" ON "visits"("checkedInById");

-- CreateIndex
CREATE INDEX "visits_checkedOutById_idx" ON "visits"("checkedOutById");

-- CreateIndex
CREATE INDEX "visits_status_idx" ON "visits"("status");

-- CreateIndex
CREATE INDEX "visits_checkInAt_idx" ON "visits"("checkInAt");

-- CreateIndex
CREATE INDEX "visits_createdAt_idx" ON "visits"("createdAt");

-- CreateIndex
CREATE INDEX "visits_status_checkInAt_idx" ON "visits"("status", "checkInAt");

-- CreateIndex
CREATE INDEX "otp_codes_phone_idx" ON "otp_codes"("phone");

-- CreateIndex
CREATE INDEX "otp_codes_phone_purpose_idx" ON "otp_codes"("phone", "purpose");

-- CreateIndex
CREATE INDEX "otp_codes_expiresAt_idx" ON "otp_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "otp_codes_createdAt_idx" ON "otp_codes"("createdAt");

-- CreateIndex
CREATE INDEX "sms_logs_phone_idx" ON "sms_logs"("phone");

-- CreateIndex
CREATE INDEX "sms_logs_type_idx" ON "sms_logs"("type");

-- CreateIndex
CREATE INDEX "sms_logs_status_idx" ON "sms_logs"("status");

-- CreateIndex
CREATE INDEX "sms_logs_createdAt_idx" ON "sms_logs"("createdAt");

-- CreateIndex
CREATE INDEX "expiry_reminder_logs_membershipId_idx" ON "expiry_reminder_logs"("membershipId");

-- CreateIndex
CREATE INDEX "expiry_reminder_logs_sentOn_idx" ON "expiry_reminder_logs"("sentOn");

-- CreateIndex
CREATE UNIQUE INDEX "expiry_reminder_logs_membershipId_daysBefore_sentOn_key" ON "expiry_reminder_logs"("membershipId", "daysBefore", "sentOn");

-- CreateIndex
CREATE UNIQUE INDEX "menu_categories_name_key" ON "menu_categories"("name");

-- CreateIndex
CREATE INDEX "menu_categories_isActive_idx" ON "menu_categories"("isActive");

-- CreateIndex
CREATE INDEX "menu_categories_sortOrder_idx" ON "menu_categories"("sortOrder");

-- CreateIndex
CREATE INDEX "menu_categories_createdAt_idx" ON "menu_categories"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_sku_key" ON "menu_items"("sku");

-- CreateIndex
CREATE INDEX "menu_items_categoryId_idx" ON "menu_items"("categoryId");

-- CreateIndex
CREATE INDEX "menu_items_isActive_idx" ON "menu_items"("isActive");

-- CreateIndex
CREATE INDEX "menu_items_isAvailable_idx" ON "menu_items"("isAvailable");

-- CreateIndex
CREATE INDEX "menu_items_name_idx" ON "menu_items"("name");

-- CreateIndex
CREATE INDEX "menu_items_createdAt_idx" ON "menu_items"("createdAt");

-- CreateIndex
CREATE INDEX "menu_item_price_history_menuItemId_idx" ON "menu_item_price_history"("menuItemId");

-- CreateIndex
CREATE INDEX "menu_item_price_history_changedById_idx" ON "menu_item_price_history"("changedById");

-- CreateIndex
CREATE INDEX "menu_item_price_history_changedAt_idx" ON "menu_item_price_history"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_receiptNo_key" ON "orders"("receiptNo");

-- CreateIndex
CREATE INDEX "orders_businessDate_idx" ON "orders"("businessDate");

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_cashierId_idx" ON "orders"("cashierId");

-- CreateIndex
CREATE INDEX "orders_voidedById_idx" ON "orders"("voidedById");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX "orders_businessDate_status_idx" ON "orders"("businessDate", "status");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_menuItemId_idx" ON "order_items"("menuItemId");

-- CreateIndex
CREATE INDEX "order_items_itemNameSnapshot_idx" ON "order_items"("itemNameSnapshot");

-- CreateIndex
CREATE INDEX "payments_kidZoneSaleId_idx" ON "payments"("kidZoneSaleId");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_visitId_idx" ON "payments"("visitId");

-- CreateIndex
CREATE INDEX "payments_receivedById_idx" ON "payments"("receivedById");

-- CreateIndex
CREATE INDEX "payments_businessDate_idx" ON "payments"("businessDate");

-- CreateIndex
CREATE INDEX "payments_method_idx" ON "payments"("method");

-- CreateIndex
CREATE INDEX "payments_createdAt_idx" ON "payments"("createdAt");

-- CreateIndex
CREATE INDEX "day_closings_section_idx" ON "day_closings"("section");

-- CreateIndex
CREATE INDEX "day_closings_businessDate_idx" ON "day_closings"("businessDate");

-- CreateIndex
CREATE INDEX "day_closings_closedById_idx" ON "day_closings"("closedById");

-- CreateIndex
CREATE INDEX "day_closings_closedAt_idx" ON "day_closings"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "day_closings_section_businessDate_key" ON "day_closings"("section", "businessDate");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_idx" ON "audit_logs"("entityType");

-- CreateIndex
CREATE INDEX "audit_logs_entityId_idx" ON "audit_logs"("entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "children" ADD CONSTRAINT "children_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_price_history" ADD CONSTRAINT "plan_price_history_planId_fkey" FOREIGN KEY ("planId") REFERENCES "kidzone_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_price_history" ADD CONSTRAINT "plan_price_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kidzone_sales" ADD CONSTRAINT "kidzone_sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kidzone_sales" ADD CONSTRAINT "kidzone_sales_childId_fkey" FOREIGN KEY ("childId") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kidzone_sales" ADD CONSTRAINT "kidzone_sales_planId_fkey" FOREIGN KEY ("planId") REFERENCES "kidzone_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kidzone_sales" ADD CONSTRAINT "kidzone_sales_soldById_fkey" FOREIGN KEY ("soldById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kidzone_sales" ADD CONSTRAINT "kidzone_sales_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_childId_fkey" FOREIGN KEY ("childId") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_planId_fkey" FOREIGN KEY ("planId") REFERENCES "kidzone_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "kidzone_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_childId_fkey" FOREIGN KEY ("childId") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "kidzone_sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_checkedOutById_fkey" FOREIGN KEY ("checkedOutById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_reminder_logs" ADD CONSTRAINT "expiry_reminder_logs_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_price_history" ADD CONSTRAINT "menu_item_price_history_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_price_history" ADD CONSTRAINT "menu_item_price_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_kidZoneSaleId_fkey" FOREIGN KEY ("kidZoneSaleId") REFERENCES "kidzone_sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_closings" ADD CONSTRAINT "day_closings_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A payment belongs to exactly one parent: a Kid Zone sale, a restaurant order,
-- or a visit (overtime settled at check-out). Enforced in the database so no
-- code path can create an orphaned or double-parented payment row.
-- ---------------------------------------------------------------------------
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_exactly_one_parent"
  CHECK (
    (CASE WHEN "kidZoneSaleId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "orderId"       IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "visitId"       IS NULL THEN 0 ELSE 1 END)
  = 1
  );

-- Money is always a non-negative integer number of poisha.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "kidzone_sales" ADD CONSTRAINT "kidzone_sales_amounts_non_negative"
  CHECK ("unitPriceSnapshot" >= 0 AND "discountAmount" >= 0 AND "totalAmount" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK ("subtotal" >= 0 AND "discountAmount" >= 0 AND "vatAmount" >= 0
     AND "serviceChargeAmount" >= 0 AND "totalAmount" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "visits" ADD CONSTRAINT "visits_overtime_non_negative"
  CHECK ("overtimeMinutes" >= 0 AND "overtimeCharge" >= 0);
ALTER TABLE "kidzone_plans" ADD CONSTRAINT "kidzone_plans_price_non_negative" CHECK ("price" >= 0);
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_price_non_negative" CHECK ("price" >= 0);

-- A membership cannot end before it starts.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_dates_ordered" CHECK ("endDate" >= "startDate");

-- A child may hold only one ACTIVE visit at a time. Enforced here as well as in
-- the check-in service, so a double tap on the POS cannot create two.
CREATE UNIQUE INDEX "visits_one_active_per_child"
  ON "visits" ("childId") WHERE "status" = 'ACTIVE';
