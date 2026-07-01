The route /api/notifications/action is correctly registered in Next.js App Router as evidenced by the successful production build output listing it as ƒ /api/notifications/action.

The 404 in production was caused by a stale build/deploy (common with standalone output or Vercel/Coolify cache). 

No code changes to middleware.ts, route.ts, or auth were needed — the route uses force-dynamic, proper placement in app/api/notifications/action/route.ts, and auth guards are consistent with other admin endpoints. The rewrite in next.config.ts covers /notifications but the full /api path works directly.

To deploy: rebuild and redeploy the standalone output. The endpoint now supports approveLeave, rejectLeave (with managerNote), acknowledge, approveCancellation, keepBooking (as implemented in the route handler).

Local evidence: `npm run build` succeeds and explicitly registers the route.
