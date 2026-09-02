export const json = (value: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export const error = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status);

export const id = (): string => crypto.randomUUID();

export const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
};

export const now = (): string => new Date().toISOString();

export const safeJson = (value: string): unknown => JSON.parse(value);
