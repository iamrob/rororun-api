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

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function secondsToMMSS(s: number) {
  if (!Number.isFinite(s) || s < 0) return null;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function paceSecondsPerKm(timeSec: number, distanceM: number) {
  if (!timeSec || !distanceM) return null;
  const km = distanceM / 1000;
  if (km <= 0) return null;
  return timeSec / km;
}

function paceToString(secPerKm: number | null) {
  if (secPerKm === null) return null;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

// Simple V1 scoring: explainable + tunable
function computeWinability(params: {
  gapSec: number; // yourPR - KOM (positive => behind)
  distanceM: number;
  elevationGainM: number; // rough
}) {
  // Gap score: 0s behind => 100, >=60s behind => 0
  const gapScore = clamp(100 - (params.gapSec / 60) * 100);

  // Difficulty score: penalize long / hilly segments
  // distance effect: 0..5000m mapped to 100..40
  const distPenalty = clamp((params.distanceM / 5000) * 60, 0, 60); // 0..60
  // elevation effect: 0..200m mapped to 0..40 penalty
  const elevPenalty = clamp((params.elevationGainM / 200) * 40, 0, 40); // 0..40
  const difficultyScore = clamp(100 - (distPenalty + elevPenalty)); // 100..0

  // Sprint bonus for short segments
  const sprintBonus =
    params.distanceM <= 600 ? 10 : params.distanceM <= 1200 ? 5 : 0;

  const winability = clamp(
    gapScore * 0.65 + difficultyScore * 0.25 + sprintBonus * 0.1
  );

  let color: "green" | "orange" | "red" = "red";
  if (winability >= 70) color = "green";
  else if (winability >= 40) color = "orange";

  return {
    winability: Math.round(winability),
    color,
    breakdown: {
      gapScore: Math.round(gapScore),
      difficultyScore: Math.round(difficultyScore),
      sprintBonus,
    },
  };
}

async function getAccessTokenFromSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!supabaseUrl || !serviceKey) {
    return { error: "Missing Supabase env vars" as const };
  }
  if (!clientId || !clientSecret) {
    return { error: "Missing Strava client env vars" as const };
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const tokenRes = await supabase
    .from("strava_tokens")
    .select("athlete_id, access_token, refresh_token, expires_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tokenRes.error || !tokenRes.data) {
    return { error: "No Strava tokens found in DB" as const };
  }

  let { access_token, refresh_token, expires_at } = tokenRes.data;
  const now = Math.floor(Date.now() / 1000);

  // refresh if expired or about to expire
  if (expires_at <= now + 60) {
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      return { error: `Strava refresh_token failed: ${txt}` as const };
    }

    const refreshed = await res.json();
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

  return { access_token } as const;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idStr = url.searchParams.get("id");
  const segmentId = Number(idStr);

  if (!Number.isFinite(segmentId)) {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid segment id" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const token = await getAccessTokenFromSupabase();
  if ("error" in token) {
    return NextResponse.json(
      { ok: false, error: token.error },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const headers = { Authorization: `Bearer ${token.access_token}` };

  // 1) Segment details
  const segRes = await fetch(
    `https://www.strava.com/api/v3/segments/${segmentId}`,
    { headers }
  );
  if (!segRes.ok) {
    const txt = await segRes.text();
    return NextResponse.json(
      { ok: false, error: "Segment fetch failed", details: txt },
      { status: 500, headers: CORS_HEADERS }
    );
  }
  const seg = await segRes.json();

  const distanceM: number = seg.distance ?? 0;
  const elevHigh: number = seg.elevation_high ?? 0;
  const elevLow: number = seg.elevation_low ?? 0;
  const elevationGainM = Math.max(0, elevHigh - elevLow); // rough proxy

  // 2) Your PR on this segment (best effort)
  const effRes = await fetch(
    `https://www.strava.com/api/v3/segment_efforts?segment_id=${segmentId}&per_page=1`,
    { headers }
  );
  if (!effRes.ok) {
    const txt = await effRes.text();
    return NextResponse.json(
      { ok: false, error: "Segment efforts fetch failed", details: txt },
      { status: 500, headers: CORS_HEADERS }
    );
  }
  const efforts = await effRes.json();
  const bestEffort = Array.isArray(efforts) && efforts.length ? efforts[0] : null;
  const yourPRSec: number | null = bestEffort?.elapsed_time ?? null;

  // 3) KOM/CR time from leaderboard top 1
  const lbRes = await fetch(
    `https://www.strava.com/api/v3/segments/${segmentId}/leaderboard?per_page=1`,
    { headers }
  );
  if (!lbRes.ok) {
    const txt = await lbRes.text();
    return NextResponse.json(
      { ok: false, error: "Leaderboard fetch failed", details: txt },
      { status: 500, headers: CORS_HEADERS }
    );
  }
  const lb = await lbRes.json();
  const topEntry = lb?.entries?.[0] ?? null;
  const komSec: number | null = topEntry?.elapsed_time ?? null;

  // Compute gap + target pace
  const gapSec =
    yourPRSec !== null && komSec !== null ? yourPRSec - komSec : null;

  const targetPace = komSec !== null ? paceToString(paceSecondsPerKm(komSec, distanceM)) : null;
  const yourPace = yourPRSec !== null ? paceToString(paceSecondsPerKm(yourPRSec, distanceM)) : null;

  // Score only if we have both times
  const score =
    gapSec !== null
      ? computeWinability({ gapSec, distanceM, elevationGainM })
      : null;

  return NextResponse.json(
    {
      ok: true,
      segment: {
        id: seg.id,
        name: seg.name,
        distance_m: distanceM,
        avg_grade: seg.average_grade ?? null,
        max_grade: seg.maximum_grade ?? null,
        elevation_high: elevHigh,
        elevation_low: elevLow,
        city: seg.city ?? null,
        state: seg.state ?? null,
        country: seg.country ?? null,
      },
      performance: {
        your_pr_seconds: yourPRSec,
        your_pr_time: yourPRSec !== null ? secondsToMMSS(yourPRSec) : null,
        your_pace: yourPace,
        kom_seconds: komSec,
        kom_time: komSec !== null ? secondsToMMSS(komSec) : null,
        kom_pace: targetPace,
        gap_seconds: gapSec,
        gap_time: gapSec !== null ? `${gapSec >= 0 ? "+" : "-"}${secondsToMMSS(Math.abs(gapSec))}` : null,
      },
      projection: score
        ? {
            winability: score.winability,
            color: score.color,
            breakdown: score.breakdown,
          }
        : {
            winability: null,
            color: "red",
            breakdown: null,
            note: "No PR found for this segment yet (or leaderboard unavailable).",
          },
    },
    { headers: CORS_HEADERS }
  );
}