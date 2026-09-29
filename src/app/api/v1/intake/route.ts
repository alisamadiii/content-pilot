// RETIRED 2026-09: the batch AI-edit-jobs pipeline is decommissioned — chat
// sessions (src/preview/) are the only AI editing path now. This endpoint
// stays up because deployed client sites still ship the cms-bridge overlay,
// which POSTs here; auth + CORS are kept so nothing leaks, and the 410 body's
// `error` text is what the overlay surfaces to the visitor.
import { verifyApiKey } from "@/lib/api-key";
import { verifyEditToken } from "@/lib/edit-token";

const bearer = (request: Request) => {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

const corsHeaders = (origin: string | null) => ({
  // Token is the security boundary, not the origin — echo the caller so the
  // browser fetch from the client site is allowed.
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
};

export const POST = async (request: Request) => {
  const headers = corsHeaders(request.headers.get("origin"));
  const token = bearer(request);
  const key = await verifyApiKey(token);
  const edit = key ? null : verifyEditToken(token);
  if (!key && !edit) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  return Response.json(
    {
      error:
        "Direct change requests have been retired — please use the site editor's chat instead.",
      deprecated: true,
    },
    { status: 410, headers },
  );
};
