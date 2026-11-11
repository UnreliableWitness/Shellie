/** What a handler answers; `send` in server.ts turns it into the response. */
export type Reply = {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
};

/** On every response, the site's and the API's. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function json(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): Reply {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

export type Refusal =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'precondition_failed'
  | 'too_large'
  | 'account_full'
  | 'too_many_requests'
  | 'server_error';

export function refuse(
  status: number,
  error: Refusal,
  headers?: Record<string, string>,
): Reply {
  return json(status, { error }, headers);
}

export function notAllowed(allowed: string[]): Reply {
  return refuse(405, 'method_not_allowed', { Allow: allowed.join(', ') });
}
