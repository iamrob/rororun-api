import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

type StravaExploreResponse = {
  segments: Array<{
    id: number;
    name: string;
    distance: number; // meters
    average_grade: number;
    maximum_grade: number;
    elevation_high: number;
    elevation_low: number;
    climb_category?: number;
    city?: string;
    state?: string;
    country?: string;
    points?: string; // polyline
    start_latlng?: [number, number];
    end_latlng?: [number, number];
  }>;
};

function toBounds(lat: number, lng: number, radiusKm: number): string {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const south = lat - dLat;
  const west = lng - dLng;
  const north = lat + dLat;
  const east = lng + dLng;
  return `${south},${west},${north},${east}`;
}

async function refreshStravaToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Strava refresh_token failed: ${txt}`);
  }
  return res.json();
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { ok: false, error: "Missing Supabase env vars" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { ok: false, error: "Missing Strava client env vars" },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radiusKm = Number(url.searchParams.get("radiusKm") ?? "10");

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid lat/lng" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const tokenRes = await supabase
    .from("strava_tokens")
    .select("athlete_id, access_token, refresh_token, expires_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tokenRes.error || !tokenRes.data) {
    return NextResponse.json(
      { ok: false, error: "No Strava tokens found in DB" },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  let { access_token, refresh_token, expires_at } = tokenRes.data;
  const now = Math.floor(Date.now() / 1000);

  if (expires_at <= now + 60) {
    try {
      const refreshed = await refreshStravaToken({
        clientId,
        clientSecret,
        refreshToken: refresh_token,
      });

      access_token = refreshed.access_token;
      refresh_token = refreshed.refresh_token;
      expires_at = refreshed.expires_at;

      await supabase.from("strava_tokens").upsert(
        {
          athlete_id: tokenRes.data.athlete_id,
          access_token,
          refresh_token,
          expires_at,
          scope: refreshed.scope ?? null,
        },
        { onConflict: "athlete_id" }
      );
    } catch (e: any) {
      return NextResponse.json(
        {
          ok: false,
          error: "Token refresh failed",
          details: String(e?.message ?? e),
        },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }

  const bounds = toBounds(lat, lng, radiusKm);

  const exploreUrl = new URL("https://www.strava.com/api/v3/segments/explore");
  exploreUrl.searchParams.set("bounds", bounds);
  exploreUrl.searchParams.set("activity_type", "running");

  const exploreRes = await fetch(exploreUrl.toString(), {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!exploreRes.ok) {
    const txt = await exploreRes.text();
    return NextResponse.json(
      { ok: false, error: "Strava explore failed", details: txt },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const data = (await exploreRes.json()) as StravaExploreResponse;

  const segments = (data.segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    distance_m: s.distance,
    avg_grade: s.average_grade,
    max_grade: s.maximum_grade,
    elevation_high: s.elevation_high,
    elevation_low: s.elevation_low,
    points: s.points,
    start_latlng: s.start_latlng,
    end_latlng: s.end_latlng,
    location: [s.city, s.state, s.country].filter(Boolean).join(", "),
  }));

  return NextResponse.json(
    {
      ok: true,
      center: { lat, lng },
      radiusKm,
      count: segments.length,
      segments,
    },
    { headers: CORS_HEADERS }
  );
}