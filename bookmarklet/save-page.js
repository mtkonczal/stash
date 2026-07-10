// Stash Bookmarklet - Save Page (client-side extraction)
// Minified version will be used as the actual bookmarklet

(async function() {
  const CONFIG = {
    // Replace with your Supabase Edge Function URL
    FUNCTION_URL: 'https://YOUR_PROJECT_ID.supabase.co/functions/v1/save-page',
    // Long random secret matching the STASH_BOOKMARKLET_TOKEN function
    // secret. The server maps it to your user id; the bookmarklet never
    // sends a user_id. Generate with: openssl rand -hex 32
    STASH_TOKEN: 'YOUR_BOOKMARKLET_TOKEN',
  };

  // Get selected text (if any) for highlight
  const selection = window.getSelection().toString().trim();

  // Show saving indicator
  const toast = document.createElement('div');
  toast.textContent = 'Saving...';
  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;font:500 14px system-ui;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.15);';
  document.body.appendChild(toast);

  // Extract content client-side (works for paywalled sites you're logged into)
  function extractContent() {
    const paragraphs = [];

    // Get all paragraph text from article selectors
    document.querySelectorAll('article p, main p, .article-body p, .post-content p, .entry-content p, [role="article"] p').forEach(p => {
      const text = p.innerText?.trim();
      if (text && text.length > 20) paragraphs.push(text);
    });

    // Fallback: get all paragraphs if article-specific selectors didn't work
    if (paragraphs.length < 3) {
      document.querySelectorAll('p').forEach(p => {
        const text = p.innerText?.trim();
        if (text && text.length > 50) paragraphs.push(text);
      });
    }

    return paragraphs.join('\n\n');
  }

  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"], meta[property="og:${name}"]`);
    return el?.content || el?.getAttribute('content') || null;
  }

  // Get the current page URL
  function getOriginalUrl() {
    return window.location.href;
  }

  // Get site name from URL
  function getSiteName(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return location.hostname.replace('www.', '');
    }
  }

  const originalUrl = getOriginalUrl();

  // Extract article data from current page
  const prefetched = {
    title: document.querySelector('h1')?.innerText?.trim() || document.title,
    content: extractContent(),
    excerpt: getMeta('description') || getMeta('og:description') || '',
    image_url: getMeta('og:image'),
    site_name: getMeta('og:site_name') || getSiteName(originalUrl),
    author: getMeta('author') || document.querySelector('[rel="author"], .author, .byline')?.innerText?.trim() || null,
  };

  // Save via Edge Function with prefetched content.
  // Auth: X-Stash-Token secret; the function derives user_id server-side.
  const saveRes = await fetch(CONFIG.FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stash-Token': CONFIG.STASH_TOKEN,
    },
    body: JSON.stringify({
      url: originalUrl,
      highlight: selection || null,
      source: 'bookmarklet',
      prefetched: selection ? null : prefetched, // Only send prefetched for full page saves
    }),
  });

  if (saveRes.ok) {
    toast.textContent = selection ? '✓ Highlight saved!' : '✓ Page saved!';
    toast.style.background = '#10b981';
    setTimeout(() => toast.remove(), 2000);
  } else {
    toast.textContent = 'Save failed';
    toast.style.background = '#ef4444';
    setTimeout(() => toast.remove(), 3000);
  }
})();
