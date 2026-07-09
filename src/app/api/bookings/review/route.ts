import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cleanComment(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 1000) || null;
}

function cleanRating(value: unknown) {
  const rating = Math.round(Number(value || 0));
  return Math.max(1, Math.min(5, rating));
}

function serializeReview(review: any) {
  return review ? {
    ...review,
    rating: Number(review.rating || 0),
    staff: review.staff || undefined,
    booking: review.booking || undefined,
  } : null;
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bookingId = req.nextUrl.searchParams.get("bookingId");
  if (bookingId) {
    const review = await prisma.staffReview.findFirst({
      where: {
        bookingId,
        ...(isAdminRole(authUser.role) ? {} : { booking: { userId: authUser.id } }),
      },
      include: { staff: { select: { id: true, name: true, role: true, avatar: true } } },
    });
    return NextResponse.json({ review: serializeReview(review) });
  }

  if (!isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const reviews = await prisma.staffReview.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      staff: { select: { id: true, name: true, role: true, avatar: true } },
      booking: { select: { id: true, customerName: true, date: true, time: true } },
    },
  });
  return NextResponse.json({ reviews: reviews.map(serializeReview) });
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return NextResponse.json({ error: "Please sign in before leaving feedback" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const bookingId = String(body.bookingId || "").trim();
    const rating = cleanRating(body.rating);
    const comment = cleanComment(body.comment);
    const publicComment = body.publicComment === undefined ? true : Boolean(body.publicComment);

    if (!bookingId) return NextResponse.json({ error: "Booking id is required" }, { status: 400 });

    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        archivedAt: null,
        ...(isAdminRole(authUser.role) ? {} : { userId: authUser.id }),
      },
      include: { staff: true, services: { include: { service: true } }, review: true },
    });

    if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    if (booking.status !== "COMPLETED") {
      return NextResponse.json({ error: "Feedback is available after the appointment is completed" }, { status: 409 });
    }
    if (!booking.staffId) {
      return NextResponse.json({ error: "Feedback needs an assigned staff member" }, { status: 409 });
    }

    const review = await prisma.staffReview.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        staffId: booking.staffId,
        userId: booking.userId || authUser.id,
        rating,
        comment,
        publicComment,
        source: isAdminRole(authUser.role) ? "ADMIN" : "CUSTOMER",
      },
      update: {
        staffId: booking.staffId,
        rating,
        comment,
        publicComment,
        source: isAdminRole(authUser.role) ? "ADMIN" : "CUSTOMER",
      },
      include: { staff: { select: { id: true, name: true, role: true, avatar: true } } },
    });

    const aggregate = await prisma.staffReview.aggregate({
      where: { staffId: booking.staffId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    return NextResponse.json({
      review: serializeReview(review),
      staffRating: {
        staffId: booking.staffId,
        staffName: booking.staff?.name || "Staff",
        average: Number((aggregate._avg.rating || 0).toFixed(2)),
        count: aggregate._count.rating || 0,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save feedback" }, { status: 500 });
  }
}
