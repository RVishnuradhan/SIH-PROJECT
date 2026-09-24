import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requestInfoFrom } from "@/lib/request-info";
import { readPrivateFile } from "@/lib/storage";
import { readSession } from "@/modules/auth/session";
import { openDocument } from "@/modules/documents/open-document";

/**
 * The only way to a customer document's file (ARCHITECTURE.md §10): checked
 * against the session and the role on every request, never cached, never a
 * public or long-lived link.
 */
export async function GET(request: Request, context: RouteContext<"/api/documents/[documentId]">) {
  const { documentId } = await context.params;
  const result = await openDocument(
    { db: getDb(), readFile: (key) => readPrivateFile(key) },
    {
      user: await readSession(getAuth(), request.headers),
      documentId,
      request: requestInfoFrom(request.headers),
    },
  );

  if (result.status !== 200) {
    return Response.json(
      { error: result.message },
      { status: result.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const disposition = result.inline ? "inline" : "attachment";
  return new Response(new Uint8Array(result.file), {
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.file.byteLength),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // The file is shown on its own, never able to run scripts or be embedded elsewhere.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
}
