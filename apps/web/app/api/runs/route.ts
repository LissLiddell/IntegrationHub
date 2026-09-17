import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";
import { sampleRunsResponse } from "@/lib/sample-data";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!controlApiConnected()) return NextResponse.json(sampleRunsResponse);
  try {
    const response = await controlApiRequest("/runs?limit=25");
    const body = await jsonFromUpstream(response);
    return NextResponse.json(
      typeof body === "object" && body !== null ? { ...body, mode: "connected" } : body,
      { status: response.status }
    );
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible consultar las ejecuciones." } },
      { status: 502 }
    );
  }
}
