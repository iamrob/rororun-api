import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/* -------------------------------------------------- */
/* Helpers */
/* -------------------------------------------------- */

function secondsToTime(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;

  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function paceFromSeconds(distanceM: number, seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || !Number.isFinite(distanceM) || distanceM <= 0)
    return null;
  const secPerKm = seconds / (distanceM / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

// Parse Strava xoms that can be "5:58" or number (rare)
function parseTimeToSeconds(t: unknown): number | null {
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t !== "string") return null;

  const parts = t.trim().split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;

  if (parts.length === 2) {
    const [m, s] = parts;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

// Simple explainable score based on gap
function computeWinability(gapSec: number): { winability: number; color: "green" | "orange" | "red" } {
  // gapSec = yourPR - KOM (positive = behind)
  let score = 15;
  if (gapSec <= 5) score = 95;
  else if (gapSec <= 15) score = 80;
  else if (gapSec <= 30) score = 60;
  else if (gapSec <= 60) score = 40;
  else score = 15;

  let color: "green" | "orange" | "red" = "red";
  if (score >= 70) color = "green";
  else if (score >= 40) color = "orange";

  return { winability: score, color };
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

/* -------------------------------------------------- */
/* GET /api/segment/score?id=123 */
/* -------------------------------------------------- */

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const idStr = searchParams.get("id");
    const segmentId = Number(idStr);

    if (!Number.isFinite(segmentId)) {
      return NextResponse.json(
        { ok: false, error: "Missing or invalid segment id" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

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

    const supabase = createClient(supabaseUrl, serviceKey);

    // Most recent token (single-user dev)
    const tokenRes = await supabase
      .from("strava_tokens")
      .select("athlete_id, access_token, refresh_token, expires_at, created_at, scope")
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

    // refresh if expired / near-expiry
    if (expires_at <= now + 60) {
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
    }

    const headers = { Authorization: `Bearer ${access_token}` };

    // Segment details (contains xoms)
    const segRes = await fetch(`https://www.strava.com/api/v3/segments/${segmentId}`, {
      headers,
    });

    if (!segRes.ok) {
      const txt = await segRes.text();
      return NextResponse.json(
        { ok: false, error: "Segment fetch failed", details: txt },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const seg = await segRes.json();

    const distanceM: number = seg?.distance ?? 0;

    // Your PR (best effort). all_efforts is allowed with read_all (works for your account)
    let prSeconds: number | null = null;
    try {
      const effortsRes = await fetch(
        `https://www.strava.com/api/v3/segments/${segmentId}/all_efforts?per_page=1`,
        { headers }
      );
      if (effortsRes.ok) {
        const efforts = await effortsRes.json();
        if (Array.isArray(efforts) && efforts.length > 0) {
          prSeconds = efforts[0]?.elapsed_time ?? null;
        }
      }
    } catch {
      // ignore: PR stays null
    }

    // KOM reference from xoms (string like "7:44")
    const komRaw = seg?.xoms?.kom ?? seg?.xoms?.overall ?? null;
    const komSeconds = parseTimeToSeconds(komRaw);

    const gapSeconds =
      prSeconds !== null && komSeconds !== null ? prSeconds - komSeconds : null;

    const projection =
      gapSeconds !== null
        ? (() => {
            const s = computeWinability(gapSeconds);
            return {
              winability: s.winability,
              color: s.color,
              note: "Score based on PR vs KOM gap",
            };
          })()
        : {
            winability: null,
            color: "red" as const,
            note: "No PR found for this segment yet. Run it once to compute your gap.",
          };

    return NextResponse.json(
      {
        ok: true,
        segment: {
          id: seg?.id ?? segmentId,
          name: seg?.name ?? null,
          distance_m: distanceM,
          avg_grade: seg?.average_grade ?? null,
          max_grade: seg?.maximum_grade ?? null,
          elevation_high: seg?.elevation_high ?? null,
          elevation_low: seg?.elevation_low ?? null,
          city: seg?.city ?? null,
          state: seg?.state ?? null,
          country: seg?.country ?? null,
        },
        performance: {
          your_pr_seconds: prSeconds,
          your_pr_time: secondsToTime(prSeconds),
          your_pace: paceFromSeconds(distanceM, prSeconds),

          kom_seconds: komSeconds,
          kom_time: secondsToTime(komSeconds),
          kom_pace: paceFromSeconds(distanceM, komSeconds),

          gap_seconds: gapSeconds,
          gap_time: secondsToTime(gapSeconds),
        },
        projection,
        debug: {
          xoms: seg?.xoms ?? null,
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}