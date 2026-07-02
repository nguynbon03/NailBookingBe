import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const prisma = new PrismaClient();

const services = [
  // extensions_hands (7)
  { name: "Acrylic & Gel Polish - New Set", category: "extensions_hands", price: 39.0, duration: 45, description: "Full acrylic set with gel polish", active: true },
  { name: "Acrylic & Gel Polish - Infill", category: "extensions_hands", price: 31.0, duration: 45, description: "Acrylic infill with gel polish", active: true },
  { name: "Ombre - New Set", category: "extensions_hands", price: 40.0, duration: 45, description: "Ombre gradient new set", active: true },
  { name: "Ombre - Infill", category: "extensions_hands", price: 35.0, duration: 45, description: "Ombre gradient infill", active: true },
  { name: "Builder Gel on Natural Nail - New Set", category: "extensions_hands", price: 38.0, duration: 45, description: "Builder gel overlay on natural nails", active: true },
  { name: "Builder Gel on Natural Nail - Infill", category: "extensions_hands", price: 33.0, duration: 45, description: "Builder gel infill", active: true },
  { name: "Removal (Before New Set) Extra", category: "extensions_hands", price: 5.0, duration: 15, description: "Removal of existing set before new application", active: true },
  // extensions_feet (2)
  { name: "Acrylic & Gel Polish - New Set (Feet)", category: "extensions_feet", price: 39.0, duration: 45, description: "Full acrylic set on feet with gel polish", active: true },
  { name: "Acrylic & Gel Polish - Infill (Feet)", category: "extensions_feet", price: 31.0, duration: 45, description: "Acrylic infill on feet with gel polish", active: true },
  // gel_polish (3)
  { name: "Gel Polish - Hands", category: "gel_polish", price: 25.0, duration: 30, description: "Gel polish on hands", active: true },
  { name: "Gel Polish - Feet", category: "gel_polish", price: 25.0, duration: 30, description: "Gel polish on feet", active: true },
  { name: "Gel Polish Removal", category: "gel_polish", price: 10.0, duration: 15, description: "Gel polish removal", active: true },
  // mani_pedi (3)
  { name: "Manicure & Gel Polish", category: "mani_pedi", price: 32.0, duration: 45, description: "Manicure with gel polish finish", active: true },
  { name: "Manicure for Men", category: "mani_pedi", price: 23.0, duration: 30, description: "Professional manicure for men", active: true },
  { name: "Deluxe Pedicure & Gel Polish", category: "mani_pedi", price: 50.0, duration: 60, description: "Deluxe pedicure with gel polish", active: true },
  // extras (2)
  { name: "Nail Art", category: "extras", price: 3.0, duration: 15, description: "Custom nail art per nail", active: true },
  { name: "Gel Polish Removal (Extras)", category: "extras", price: 10.0, duration: 15, description: "Gel polish removal service", active: true },
  // waxing (5)
  { name: "Eyebrows Wax", category: "waxing", price: 8.0, duration: 15, description: "Eyebrow waxing and shaping", active: true },
  { name: "Eyebrows Tint", category: "waxing", price: 8.0, duration: 15, description: "Eyebrow tinting", active: true },
  { name: "Upper Lip Wax", category: "waxing", price: 5.0, duration: 15, description: "Upper lip waxing", active: true },
  { name: "Chin Wax", category: "waxing", price: 10.0, duration: 15, description: "Chin waxing", active: true },
  { name: "Under Arm Wax", category: "waxing", price: 10.0, duration: 15, description: "Under arm waxing", active: true },
];

const staff = [
  { name: "Sarah Nguyen", email: "sarah@nailbooking.com", phone: "+447****1111", role: "MANICURIST", bio: "Nail extension specialist with 5 years experience", avatar: "/images/gallery-1.jpg", active: true },
  { name: "Emma Linh", email: "emma@nailbooking.com", phone: "+447****2222", role: "WAXING_SPECIALIST", bio: "Waxing and beauty treatment expert", avatar: "/images/gallery-2.jpg", active: true },
  { name: "Lily Tran", email: "lily@nailbooking.com", phone: "+447****3333", role: "MANICURIST", bio: "Gel polish and nail art specialist", avatar: "/images/gallery-3.jpg", active: true },
];

const servicesWithImages = services.map((service, index) => ({
  ...service,
  image: `/images/gallery-${(index % 10) + 1}.jpg`,
}));

async function main() {
  // 1. Create admin user
  const adminPassword = hashSync("admin123", 10);
  const admin = await prisma.user.upsert({
    where: { email: "admin" },
    update: {},
    create: { email: "admin", password: adminPassword, name: "Admin", role: "ADMIN" },
  });
  console.log(`Admin user: ${admin.email}`);

  const manager = await prisma.user.upsert({
    where: { email: "manager@nailbooking.com" },
    update: { name: "Manager", role: "MANAGER", phone: "+447****0000", emailVerifiedAt: new Date() },
    create: { email: "manager@nailbooking.com", password: hashSync("manager123", 10), name: "Manager", phone: "+447****0000", role: "MANAGER", emailVerifiedAt: new Date() },
  });
  console.log(`Manager user: ${manager.email}`);

  // 2. Seed services (skip if already exist to avoid duplicates)
  for (const s of servicesWithImages) {
    const existing = await prisma.service.findFirst({ where: { name: s.name } });
    if (!existing) {
      await prisma.service.create({ data: s });
      console.log(`Created service: ${s.name}`);
    } else {
      if (!existing.image) {
        await prisma.service.update({ where: { id: existing.id }, data: { image: s.image } });
        console.log(`Updated service image: ${s.name}`);
      } else {
        console.log(`Skipped service: ${s.name}`);
      }
    }
  }

  // 3. Seed staff
  for (const st of staff) {
    const existing = await prisma.staff.findFirst({ where: { email: st.email } });
    const staffRecord = !existing
      ? await prisma.staff.create({ data: st })
      : await prisma.staff.update({ where: { id: existing.id }, data: { name: st.name, phone: st.phone, role: st.role, bio: st.bio, avatar: existing.avatar || st.avatar, active: true } });
    await prisma.user.upsert({
      where: { email: st.email },
      update: { name: st.name, phone: st.phone, role: "STAFF" },
      create: { email: st.email, password: hashSync("staff123", 10), name: st.name, phone: st.phone, role: "STAFF" },
    });
    // Do not seed working hours. Staff must add their own availability from Staff Portal.
    if (!existing) {
      console.log(`Created staff: ${st.name}`);
    } else if (!existing.avatar) {
      console.log(`Updated staff avatar: ${st.name}`);
    } else {
      console.log(`Skipped staff: ${st.name}`);
    }
  }

  await prisma.promoCode.upsert({
    where: { code: "NAIL20" },
    update: { discountPercent: 20, active: true, name: "20% Welcome Discount" },
    create: { code: "NAIL20", name: "20% Welcome Discount", discountPercent: 20, active: true, usageLimit: 500 },
  });
  console.log("Promo code ready: NAIL20");

  console.log("Seed complete!");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
