import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: Request) {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { ok: false, error: "Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET" },
      { status: 500 }
    );
  }

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json(
      { ok: false, error: "Missing code param from Strava" },
      { status: 400 }
    );
  }

  // Exchange authorization code for tokens
  const tokenRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return NextResponse.json(
      { ok: false, error: "Token exchange failed", details: txt },
      { status: 500 }
    );
  }

  const data = await tokenRes.json();
  const athleteId = data?.athlete?.id;

  if (!athleteId) {
    return NextResponse.json(
      { ok: false, error: "No athlete id in Strava response" },
      { status: 500 }
    );
  }

  // Store tokens (server-side using service role)
  const supabase = createClient(supabaseUrl, serviceKey);

  const upsertRes = await supabase.from("strava_tokens").upsert(
    {
      athlete_id: athleteId,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      scope: data.scope ?? null,
    },
    { onConflict: "athlete_id" }
  );

  if (upsertRes.error) {
    return NextResponse.json(
      { ok: false, error: "DB upsert failed", details: upsertRes.error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Strava connected",
    athlete_id: athleteId,
    scope: data.scope,
  });
}