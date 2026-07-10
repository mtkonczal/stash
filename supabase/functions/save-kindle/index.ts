import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Verify the caller's JWT and return their user id, or null. This function
// writes with the service-role key (bypasses RLS), so user_id MUST come
// from the verified token, never from the request body.
async function authenticateRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;

  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
  );
  const { data, error } = await anonClient.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user.id;
}

interface KindleHighlight {
  title: string;
  author?: string | null;
  highlight: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const user_id = await authenticateRequest(req);
    if (!user_id) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { highlights } = await req.json();

    if (!highlights || !Array.isArray(highlights)) {
      return new Response(
        JSON.stringify({ error: "highlights array required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (highlights.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No highlights to import", imported: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get existing Kindle highlights to check for duplicates
    const { data: existingSaves, error: fetchError } = await supabase
      .from("saves")
      .select("highlight, title")
      .eq("user_id", user_id)
      .not("highlight", "is", null);

    if (fetchError) {
      throw fetchError;
    }

    // Create set of existing highlights for O(1) lookup
    const existingSet = new Set(
      (existingSaves || []).map((s: { highlight: string; title: string }) =>
        `${s.highlight}|||${s.title}`
      )
    );

    // Filter out duplicates
    const newHighlights = (highlights as KindleHighlight[]).filter((h) => {
      const key = `${h.highlight}|||${h.title}`;
      return !existingSet.has(key);
    });

    if (newHighlights.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: `All ${highlights.length} highlights already synced`,
          imported: 0,
          duplicates: highlights.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prepare saves for batch insert
    const savesToInsert = newHighlights.map((h) => ({
      user_id,
      title: h.title,
      author: h.author || null,
      highlight: h.highlight,
      site_name: "Kindle",
      source: "kindle",
    }));

    // Insert in batches of 50
    const batchSize = 50;
    let insertedCount = 0;

    for (let i = 0; i < savesToInsert.length; i += batchSize) {
      const batch = savesToInsert.slice(i, i + batchSize);
      const { error: insertError } = await supabase
        .from("saves")
        .insert(batch);

      if (insertError) {
        throw insertError;
      }
      insertedCount += batch.length;
    }

    const skipped = highlights.length - newHighlights.length;
    const message = skipped > 0
      ? `Synced ${insertedCount} new highlights (${skipped} duplicates skipped)`
      : `Synced ${insertedCount} new highlights`;

    return new Response(
      JSON.stringify({
        success: true,
        message,
        imported: insertedCount,
        duplicates: skipped,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Save Kindle error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
