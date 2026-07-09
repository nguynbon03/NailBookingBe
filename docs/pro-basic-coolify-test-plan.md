# NailBooking Pro/Basic Coolify test plan

## Coolify resources

Pro:
- Frontend app: `nailbooking-fe` on branch `pro`, domain `https://bookingnail.overpowers.agency`
- Backend app: `nailbooking-be` on branch `pro`, route/domain `https://bookingnail.overpowers.agency/api`
- Database: `nailbooking-db`
- Qdrant service: `nailbooking-qdrant`
- Chatbot: enabled
- Social bubbles: enabled in FE

Basic:
- Frontend app: `nailbooking-basic-fe` on branch `basic`, domain `https://bookingnail.basic.overpowers.agency`
- Backend app: `nailbooking-basic-be` on branch `basic`, route/domain `https://bookingnail.basic.overpowers.agency/api`
- Database: `nailbooking-basic-db`
- Chatbot: disabled
- Social bubbles: disabled in FE

## Required environment variables

Backend Pro:
- `DATABASE_URL`: internal URL for `nailbooking-db`
- `APP_EDITION=pro`
- `CHATBOT_ENABLED=true`
- `SHOP_LANGUAGE=en` or `SHOP_LANGUAGE=vi`
- `QDRANT_URL=http://qdrant-jv59uxsokhiq1c5fuo7yncot:6333`
- `QDRANT_COLLECTION=nailbooking-knowledge-pro`
- `QDRANT_APP_TAG=nailbooking-chatbot-pro`
- `CHATBOT_TOP_K=8`
- `CHATBOT_CHUNK_SIZE=512`
- `CHATBOT_CHUNK_OVERLAP=50`
- `AI_CHAT_BASE_URL=https://ollama.com/v1`
- `AI_CHAT_MODEL=kimi-k2.6`
- `AI_CHAT_API_KEY`: stored only in Coolify secret env

Backend Basic:
- `DATABASE_URL`: internal URL for `nailbooking-basic-db`
- `APP_EDITION=basic`
- `CHATBOT_ENABLED=false`
- `SHOP_LANGUAGE=en` or `SHOP_LANGUAGE=vi`
- `QDRANT_URL` empty
- `QDRANT_COLLECTION=nailbooking-knowledge-basic`

Frontend Pro:
- `NEXT_PUBLIC_API_URL=https://bookingnail.overpowers.agency`
- `NEXT_PUBLIC_APP_EDITION=pro`
- `NEXT_PUBLIC_ENABLE_CHATBOT=true`
- `NEXT_PUBLIC_ENABLE_SOCIAL_BUBBLES=true`
- `NEXT_PUBLIC_SHOP_LANGUAGE=en`

Frontend Basic:
- `NEXT_PUBLIC_API_URL=https://bookingnail.basic.overpowers.agency`
- `NEXT_PUBLIC_APP_EDITION=basic`
- `NEXT_PUBLIC_ENABLE_CHATBOT=false`
- `NEXT_PUBLIC_ENABLE_SOCIAL_BUBBLES=false`
- `NEXT_PUBLIC_SHOP_LANGUAGE=en`

## Pre-deploy checks

Run in backend repo:

```bash
npm run build
QDRANT_URL=http://10.0.1.14:6333 \
QDRANT_COLLECTION=nailbooking-knowledge-pro \
QDRANT_APP_TAG=nailbooking-chatbot-pro \
CHATBOT_TOP_K=8 \
CHATBOT_CHUNK_SIZE=512 \
CHATBOT_CHUNK_OVERLAP=50 \
npm run chatbot:index
```

Run in frontend repo:

```bash
npm run build
```

## Coolify deploy order

1. Ensure databases are healthy:
   - `nailbooking-db`
   - `nailbooking-basic-db`
2. Ensure Qdrant service is healthy:
   - `nailbooking-qdrant`
3. Deploy backend Pro and Basic.
4. Deploy frontend Pro and Basic.
5. Verify domains.

## Live smoke tests

Pro:

```bash
curl -I https://bookingnail.overpowers.agency
curl -fsS https://bookingnail.overpowers.agency/api/services
curl -fsS -X POST https://bookingnail.overpowers.agency/api/chatbot \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What are your opening hours and how do I book?"}],"mode":"customer","language":"en"}'
```

Expected Pro UI:
- Booking page loads on phone width.
- Chatbot AI bubble is visible.
- Social bubbles are visible.
- Chatbot answer contains sources from Qdrant/RAG knowledge.
- If shop language is `vi`, chatbot answers Vietnamese.

Basic:

```bash
curl -I https://bookingnail.basic.overpowers.agency
curl -fsS https://bookingnail.basic.overpowers.agency/api/services
curl -fsS -X POST https://bookingnail.basic.overpowers.agency/api/chatbot \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What are your opening hours?"}],"mode":"customer","language":"en"}'
```

Expected Basic UI/API:
- Booking page loads on phone width.
- Chatbot AI bubble is not visible.
- Social bubbles are not visible.
- Chatbot endpoint should return disabled/not available behavior when `CHATBOT_ENABLED=false`.

## Database separation verification

- Create or update a test booking on Pro and confirm it appears only in `nailbooking-db`.
- Create or update a test booking on Basic and confirm it appears only in `nailbooking-basic-db`.
- Never point both backend apps to the same `DATABASE_URL`.

## Qdrant/RAG design source

This follows the Qdrant + LangChain/CrewAI example pattern from `benitomartin/crewai-rag-langchain-qdrant`:
- chunk knowledge with `chunk_size=512` and `chunk_overlap=50`
- store chunk text and metadata in Qdrant payload
- search top-k chunks from Qdrant
- pass retrieved chunks into the chatbot system prompt

Qdrant itself is deployed as a Coolify-managed service using the official `qdrant/qdrant` image with a persistent volume.
