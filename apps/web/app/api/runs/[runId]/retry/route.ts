import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { role?: unknown };
  const role = typeof body.role === "string" ? body.role : "";
  if (!controlApiConnected()) {
    return NextResponse.json({ outcome: "QUEUED", runId, nextAttempt: 2, mode: "preview" }, { status: 202 });
  }
  try {
    const response = await controlApiRequest(`/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST",
      headers: { "x-integrationhub-role": role }
    });
    return NextResponse.json(await jsonFromUpstream(response), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible programar el reintento." } },
      { status: 502 }
    );
  }
}
