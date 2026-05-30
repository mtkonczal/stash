import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// npm: specifiers, not esm.sh: Deno treats linkedom's `canvas` as an optional
// dependency and skips it, whereas esm.sh tries to bundle canvas's native
// binding and fails ("Module not found canvas.node").
import { parseHTML } from "npm:linkedom@0.16.8";
import { Readability } from "npm:@mozilla/readability@0.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Extract meta content by name or property
function extractMeta(doc: any, attr: string, value: string): string | null {
  const el = doc.querySelector(`meta[${attr}="${value}"]`);
  return el?.getAttribute("content") || null;
}

// Parse HTML and extract article data
function extractArticle(html: string, url: string) {
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();

  const title = article?.title ||
               extractMeta(document, "property", "og:title") ||
               document.querySelector("title")?.textContent ||
               "Untitled";

  const excerpt = article?.excerpt ||
                 extractMeta(document, "name", "description") ||
                 extractMeta(document, "property", "og:description") ||
                 "";

  const image_url = extractMeta(document, "property", "og:image");

  const site_name = extractMeta(document, "property", "og:site_name") ||
                   new URL(url).hostname.replace("www.", "");

  const author = article?.byline ||
                extractMeta(document, "name", "author") ||
                extractMeta(document, "property", "article:author") ||
                null;

  // Extract paragraphs with line breaks
  let content = "";
  if (article?.content) {
    const { document: articleDoc } = parseHTML(article.content);
    const paragraphs: string[] = [];
    articleDoc.querySelectorAll("p").forEach((p: any) => {
      const text = p.textContent?.trim();
      if (text) paragraphs.push(text);
    });
    content = paragraphs.join("\n\n");
  }

  if (!content && article?.textContent) {
    content = article.textContent;
  }

  return { title, excerpt, image_url, site_name, author, content };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, user_id, highlight, source, prefetched } = await req.json();

    if (!url || !user_id) {
      return new Response(
        JSON.stringify({ error: "url and user_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let article: any = null;

    // If client sent prefetched data, use it (handles paywalled sites, etc.)
    if (prefetched) {
      console.log("Using prefetched data from client");
      article = {
        title: prefetched.title || "Untitled",
        excerpt: prefetched.excerpt || "",
        content: prefetched.content || "",
        image_url: prefetched.image_url || null,
        site_name: prefetched.site_name || new URL(url).hostname.replace("www.", ""),
        author: prefetched.author || null,
      };
    } else {
      // Server-side fetch
      let html = "";

      const response = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA },
      });

      if (response.ok) {
        html = await response.text();
      }

      // Extract article from direct fetch
      article = html ? extractArticle(html, url) : null;
    }

    if (!article) {
      throw new Error("Could not extract article content");
    }

    // Build save object
    const saveData: Record<string, unknown> = {
      user_id,
      url,
      title: article.title,
      excerpt: article.excerpt,
      content: highlight ? null : article.content.substring(0, 100000),
      highlight: highlight || null,
      image_url: article.image_url,
      site_name: article.site_name,
      author: article.author,
      source: source || "api",
    };

    // Save to database
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase
      .from("saves")
      .insert(saveData)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return new Response(
      JSON.stringify({ success: true, save: data }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
