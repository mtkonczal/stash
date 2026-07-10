// Minimal Supabase client for Chrome extension
class SupabaseClient {
  constructor(url, anonKey) {
    this.url = url;
    this.anonKey = anonKey;
    this.session = null;
  }

  async init() {
    const stored = await chrome.storage.local.get(['stash_session']);
    this.session = stored.stash_session || null;
  }

  get accessToken() {
    return this.session?.access_token || null;
  }

  get headers() {
    const h = {
      'apikey': this.anonKey,
      'Content-Type': 'application/json',
    };
    if (this.accessToken) {
      h['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return h;
  }

  async _storeSession(data) {
    // GoTrue may return expires_in without expires_at; normalize so we can
    // decide when to refresh.
    if (data && !data.expires_at && data.expires_in) {
      data.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
    }
    this.session = data;
    await chrome.storage.local.set({ stash_session: data });
  }

  _isExpired() {
    if (!this.session?.access_token) return true;
    // Treat tokens within 60s of expiry as expired to avoid mid-request 401s
    return !this.session.expires_at ||
      this.session.expires_at * 1000 < Date.now() + 60_000;
  }

  async refreshSession() {
    if (!this.session?.refresh_token) return false;
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'apikey': this.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }),
    });
    if (!res.ok) {
      // Refresh token revoked/expired: force a fresh sign-in
      await this.signOut();
      return false;
    }
    await this._storeSession(await res.json());
    return true;
  }

  // Returns true if a valid (refreshed if needed) session exists.
  async ensureSession() {
    if (!this.session) return false;
    if (this._isExpired()) return await this.refreshSession();
    return true;
  }

  // Throws if not signed in. All writes derive user_id from here — never
  // from a hardcoded config value — so rows always belong to the session
  // user and pass RLS's auth.uid() = user_id check.
  async requireUserId() {
    const ok = await this.ensureSession();
    if (!ok || !this.session?.user?.id) {
      throw new Error('Not signed in. Open the Stash popup and sign in.');
    }
    return this.session.user.id;
  }

  // Step 1 of email OTP sign-in: email a one-time 6-digit code.
  // create_user: false — single-user app; unknown emails are rejected
  // server-side instead of creating an account.
  async requestOtp(email) {
    const res = await fetch(`${this.url}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'apikey': this.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, create_user: false }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error_description || err.msg || 'Could not send code');
    }

    return true;
  }

  // Step 2: exchange the emailed code for a session. Codes are single-use,
  // expire server-side, and verification is rate-limited by GoTrue.
  async verifyOtp(email, token) {
    const res = await fetch(`${this.url}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'apikey': this.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'email', email, token }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error_description || err.msg || 'Invalid or expired code');
    }

    const data = await res.json();
    await this._storeSession(data);
    return data;
  }

  async signOut() {
    this.session = null;
    await chrome.storage.local.remove(['stash_session']);
  }

  async getUser() {
    const ok = await this.ensureSession();
    if (!ok) return null;

    const res = await fetch(`${this.url}/auth/v1/user`, {
      headers: this.headers,
    });

    if (!res.ok) return null;
    return await res.json();
  }

  // Database operations
  async insert(table, data) {
    await this.ensureSession();
    console.log('Supabase insert:', table, 'data keys:', Object.keys(data));
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });

    console.log('Supabase response status:', res.status);

    if (!res.ok) {
      const err = await res.json();
      console.error('Supabase insert error:', err);
      throw new Error(err.message || err.error || 'Insert failed');
    }

    const result = await res.json();
    console.log('Supabase insert success:', result);
    return result;
  }

  async select(table, options = {}) {
    await this.ensureSession();
    let url = `${this.url}/rest/v1/${table}?select=${options.select || '*'}`;

    if (options.filters) {
      for (const [key, value] of Object.entries(options.filters)) {
        url += `&${key}=eq.${encodeURIComponent(value)}`;
      }
    }

    if (options.order) {
      url += `&order=${options.order}`;
    }

    if (options.limit) {
      url += `&limit=${options.limit}`;
    }

    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Select failed');
    }

    return await res.json();
  }

  async update(table, id, data) {
    await this.ensureSession();
    const res = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Update failed');
    }

    return await res.json();
  }

  async delete(table, id) {
    await this.ensureSession();
    const res = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Delete failed');
    }

    return true;
  }
}

// Export for use in extension
if (typeof window !== 'undefined') {
  window.SupabaseClient = SupabaseClient;
}
