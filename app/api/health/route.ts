import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    return NextResponse.json(
      { ok: false, error: "Missing Supabase env vars" },
      { status: 500 }
    );
  }

  const supabase = createClient(url, anon);

  const insertRes = await supabase.from("health_checks").insert({ source: "api" });
  if (insertRes.error) {
    return NextResponse.json(
      { ok: false, step: "insert", error: insertRes.error.message },
      { status: 500 }
    );
  }

  const readRes = await supabase
    .from("health_checks")
    .select("id, created_at, source")
    .order("id", { ascending: false })
    .limit(5);

  if (readRes.error) {
    return NextResponse.json(
      { ok: false, step: "select", error: readRes.error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "API + Supabase OK",
    last_rows: readRes.data,
  });
}
