interface StoredCredentials {
  accessToken: string;
  appSecret: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

/**
 * Holds an automatically generated installation key in customer-owned Durable
 * Object storage. The key is never returned to a browser or stored in D1.
 */
export class InstallationSecrets implements DurableObject {
  private keyMaterial = '';
  private webhookToken = '';

  constructor(private readonly state: DurableObjectState) {
    this.state.blockConcurrencyWhile(async () => {
      this.keyMaterial = (await this.state.storage.get<string>('credential_encryption_key')) ?? '';
      if (!this.keyMaterial) {
        this.keyMaterial = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        await this.state.storage.put('credential_encryption_key', this.keyMaterial);
      }
      this.webhookToken = (await this.state.storage.get<string>('webhook_verify_token')) ?? '';
      if (!this.webhookToken) {
        this.webhookToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        await this.state.storage.put('webhook_verify_token', this.webhookToken);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname === '/webhook-token') return new Response(this.webhookToken);
      const key = await crypto.subtle.importKey('raw', fromBase64Url(this.keyMaterial), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      if (new URL(request.url).pathname === '/encrypt') {
        const value = await request.json<StoredCredentials>();
        if (!value.accessToken || !value.appSecret) return Response.json({ error: 'invalid_credentials' }, { status: 422 });
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(JSON.stringify(value)));
        return Response.json({ ciphertext: toBase64Url(new Uint8Array(encrypted)), nonce: toBase64Url(nonce) });
      }
      if (new URL(request.url).pathname === '/decrypt') {
        const input = await request.json<{ ciphertext?: string; nonce?: string }>();
        if (!input.ciphertext || !input.nonce) return Response.json({ error: 'invalid_ciphertext' }, { status: 422 });
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(input.nonce) }, key, fromBase64Url(input.ciphertext));
        const value = JSON.parse(decoder.decode(plaintext)) as StoredCredentials;
        if (!value.accessToken || !value.appSecret) return Response.json({ error: 'invalid_credentials' }, { status: 422 });
        return Response.json(value);
      }
      return new Response('Not found', { status: 404 });
    } catch {
      return Response.json({ error: 'credential_operation_failed' }, { status: 500 });
    }
  }
}
