import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/* -------------------------------------------------- */
/* Helpers */
/* -------------------------------------------------- */

function secondsToTime(sec: number | null): string | null {
  if (!sec || !Number.isFinite(sec)) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function paceFromSeconds(distanceM: number, seconds: number | null): string | null {
  if (!seconds || !distanceM) return null;
  const secPerKm = seconds / (distanceM / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

/* 🔧 FIX IMPORTANT : parse "5:58" → 358 */
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

function computeWinability(gapSec: number): {
  score: number;
  color: "green" | "orange" | "red";
} {
  if (gapSec <= 5) return { score: 95, color: "green" };
  if (gapSec <= 15) return { score: 80, color: "green" };
  if (gapSec <= 30) return { score: 60, color: "orange" };
  if (gapSec <= 60) return { score: 40, color: "orange" };
  return { score: 15, color: "red" };
}

/* -------------------------------------------------- */
/* Route */
/* -------------------------------------------------- */

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const segmentId = searchParams.get("id");

    if (!segmentId) {
      return NextResponse.json(
        { ok: false, error: "Missing segment id" },
        { status: 400 }
      );
    }

    /* ENV -------------------------------------------------- */

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const clientId = process.env.STRAVA_CLIENT_ID!;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET!;

    const supabase = createClient(supabaseUrl, serviceKey);

    /* TOKEN -------------------------------------------------- */

    const tokenRes = await supabase
      .from("strava_tokens")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!tokenRes.data) {
      return NextResponse.json({
        ok: false,
        error: "No Strava tokens found",
      });
    }

    let { access_token } = tokenRes.data;

    /* SEGMENT INFO ----------------------------------------- */

    const segRes = await fetch(
      `https://www.strava.com/api/v3/segments/${segmentId}`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    if (!segRes.ok) {
      const txt = await segRes.text();
      return NextResponse.json({
        ok: false,
        error: "Segment fetch failed",
        details: txt,
      });
    }

    const seg = await segRes.json();

    /* ATHLETE STATS ---------------------------------------- */

    const statsRes = await fetch(
      `https://www.strava.com/api/v3/segments/${segmentId}/all_efforts`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    let prSeconds: number | null = null;

    if (statsRes.ok) {
      const efforts = await statsRes.json();
      if (efforts?.length > 0) {
        prSeconds = efforts[0].elapsed_time ?? null;
      }
    }

    /* KOM --------------------------------------------------- */

    const komRaw = seg?.xoms?.kom ?? seg?.xoms?.overall ?? null;
    const komSeconds = parseTimeToSeconds(komRaw);

    /* GAP --------------------------------------------------- */

    const gapSeconds =
      prSeconds && komSeconds ? prSeconds - komSeconds : null;

    /* SCORE ------------------------------------------------- */

    let winability: number | null = null;
    let color: "green" | "orange" | "red" = "red";

    if (gapSeconds !== null) {
      const score = computeWinability(gapSeconds);
      winability = score.score;
      color = score.color;
    }

    /* RESPONSE --------------------------------------------- */

    return NextResponse.json({
      ok: true,

      segment: {
        id: seg.id,
        name: seg.name,
        distance_m: seg.distance,
        avg_grade: seg.average_grade,
        max_grade: seg.maximum_grade,
        elevation_high: seg.elevation_high,
        elevation_low: seg.elevation_low,
        city: seg.city,
        state: seg.state,
        country: seg.country,
      },

      performance: {
        your_pr_seconds: prSeconds,
        your_pr_time: secondsToTime(prSeconds),
        your_pace: paceFromSeconds(seg.distance, prSeconds),

        kom_seconds: komSeconds,
        kom_time: secondsToTime(komSeconds),
        kom_pace: paceFromSeconds(seg.distance, komSeconds),

        gap_seconds: gapSeconds,
        gap_time: secondsToTime(gapSeconds),
      },

      projection:
        gapSeconds !== null
          ? {
              winability,
              color,
              note: "Score based on PR vs KOM gap",
            }
          : {
              winability: null,
              color: "red",
              note:
                "No PR found for this segment yet. Run it once to compute your gap.",
            },

      debug: {
        xoms: seg?.xoms ?? null,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}