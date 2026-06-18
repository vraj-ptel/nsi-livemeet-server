/**
 * seed-admin.ts — Creates default admin account.
 * Run with: npx tsx scripts/seed-admin.ts
 */
import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const prisma = new PrismaClient();

const SALT = process.env.PASSWORD_SALT ?? "nsi-zoom-salt";

function hashPassword(password: string): string {
  return crypto.scryptSync(password, SALT, 64).toString("hex");
}

const ADMIN_EMAIL = "nsi-livemeet@admin.com";
const ADMIN_PASSWORD = "admin123";

async function main() {
  const hashed = hashPassword(ADMIN_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      password: hashed,
      name: "Admin",
      role: "ADMIN",
    },
    update: {
      password: hashed,
      name: "Admin",
      role: "ADMIN",
    },
  });

  console.log(`✅ Admin user ready: ${user.email}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error("❌ Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
