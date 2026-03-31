export function parseCookies(cookieHeader: string | null) {
  const cookies: Record<string, string> = {};

  if (!cookieHeader) {
    return cookies;
  }

  // Split the cookie string by semicolons and spaces
  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest.length > 0) {
      // Decode the name and value, and join value parts in case it contains '='
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

export const SUPABASE_MANAGEMENT_TOKEN_COOKIE = 'supabaseManagementToken';

export function getApiKeysFromCookie(cookieHeader: string | null): Record<string, string> {
  const cookies = parseCookies(cookieHeader);
  return cookies.apiKeys ? JSON.parse(cookies.apiKeys) : {};
}

export function getProviderSettingsFromCookie(cookieHeader: string | null): Record<string, any> {
  const cookies = parseCookies(cookieHeader);
  return cookies.providers ? JSON.parse(cookies.providers) : {};
}

export function getSupabaseManagementTokenFromCookie(cookieHeader: string | null): string | undefined {
  const cookies = parseCookies(cookieHeader);
  return cookies[SUPABASE_MANAGEMENT_TOKEN_COOKIE] || undefined;
}

export function createSupabaseManagementTokenCookie(token: string, secure: boolean): string {
  const attributes = [
    `${SUPABASE_MANAGEMENT_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000',
  ];

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

export function clearSupabaseManagementTokenCookie(secure: boolean): string {
  const attributes = [
    `${SUPABASE_MANAGEMENT_TOKEN_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}
