FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG DATABASE_URL=postgresql://postgres@localhost:5432/postgres
ARG NEXTAUTH_URL=http://localhost:3000
ARG GOOGLE_CLIENT_ID=
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ENV DATABASE_URL=$DATABASE_URL
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=base /app/package*.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/.next ./.next
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/src ./src
COPY --from=base /app/tsconfig.json ./
COPY --from=base /app/next.config.ts ./
COPY --from=base /app/prisma.config.ts ./
EXPOSE 3000
CMD ["sh", "-c", "npx tsx prisma/ensure-schema.ts || echo 'WARN: non-destructive schema ensure failed'; npx prisma db push || echo 'WARN: prisma db push failed; starting app without destructive reset'; npx tsx prisma/seed.ts || echo 'WARN: seed failed; preserving existing data and starting app'; node .next/standalone/server.js"]
