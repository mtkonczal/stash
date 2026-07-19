// Stash Configuration
// Replace these with your Supabase project details

const CONFIG = {
  // Your Supabase project URL (from Project Settings > API)
  SUPABASE_URL: 'https://fvydjrhqaeemkdakqnfk.supabase.co',

  // Your Supabase anon/public key (from Project Settings > API).
  // Safe to ship ONLY because RLS is enabled; all data access is scoped to
  // the signed-in user's JWT.
  SUPABASE_ANON_KEY: 'sb_publishable_MkrRsrV7RAyYyTqkod_BxQ_4FdBY28I',

  // Your web app URL (after deploying to Vercel/Netlify)
  WEB_APP_URL: 'https://stash-phi-eight.vercel.app',
};

// Don't edit below this line
if (typeof module !== 'undefined') {
  module.exports = CONFIG;
}
