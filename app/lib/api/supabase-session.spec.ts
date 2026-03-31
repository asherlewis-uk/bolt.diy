import { describe, expect, it } from 'vitest';
import { action } from '~/routes/api.supabase.session';

describe('/api/supabase/session', () => {
  it('sets an httpOnly management-token cookie', async () => {
    const response = await action({
      request: new Request('https://example.com/api/supabase/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'supabase-token-123',
        }),
      }),
    } as never);

    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toContain('supabaseManagementToken=supabase-token-123');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('SameSite=Lax');
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
  });

  it('clears the management-token cookie when no token is provided', async () => {
    const response = await action({
      request: new Request('http://localhost:5173/api/supabase/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    } as never);

    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toContain('supabaseManagementToken=');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(response.headers.get('Set-Cookie')).not.toContain('Secure');
  });
});
