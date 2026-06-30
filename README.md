# NailBookingBe

Backend API cho Nail Booking System.

## Tech Stack
- Next.js 16 API Routes
- Prisma ORM + PostgreSQL
- PostgreSQL-backed booking slot checks
- JWT Authentication

## API Routes
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/bookings`
- `GET /api/bookings`
- `GET /api/admin/stats`
- `CRUD /api/admin/services`

## Docker
```bash
docker-compose up -d
```

## Environment
| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection |
| NEXTAUTH_SECRET | JWT secret |
| NEXTAUTH_URL | Backend URL |
