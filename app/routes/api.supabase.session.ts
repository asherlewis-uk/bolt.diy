import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import {
  clearSupabaseManagementTokenCookie,
  createSupabaseManagementTokenCookie,
} from '~/lib/api/cookies';

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const { token } = (await request.json()) as { token?: string };
  const secure = new URL(request.url).protocol === 'https:';
  const setCookie = token?.trim()
    ? createSupabaseManagementTokenCookie(token.trim(), secure)
    : clearSupabaseManagementTokenCookie(secure);

  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': setCookie,
    },
  });
}
