// Stash Web App Configuration
// Replace these with your Supabase project details

const CONFIG = {
  // Your Supabase project URL (from Project Settings > API)
  SUPABASE_URL: 'https://fvydjrhqaeemkdakqnfk.supabase.co',

  // Your Supabase anon/public key (from Project Settings > API).
  // Safe to ship to browsers ONLY because RLS is enabled on all tables;
  // every query runs as the signed-in user via their JWT.
  SUPABASE_ANON_KEY: 'sb_publishable_MkrRsrV7RAyYyTqkod_BxQ_4FdBY28I',
};
