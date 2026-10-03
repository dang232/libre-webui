/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRODUCT_EXCHANGE_INTENT = 'product_exchange';
export const LIBRE_AUDIENCE = 'libre';

export interface ProductAssertion {
  readonly sub: string;
  readonly sid: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly intent: string;
  // Verified address supplied by Auth for profile provisioning. Optional so
  // assertions minted before this claim existed still verify.
  readonly email?: string;
}

export interface CanonicalCredentialInput {
  readonly email: string;
  password: string;
  readonly signup: boolean;
}

export interface AuthTransport {
  readonly request: (path: string, init: RequestInit) => Promise<Response>;
}

export type AlcoreCustomerConfig = {
  readonly baseUrl: string;
  readonly organizationId: string;
};

export type AlcoreCustomer = {
  readonly id: string;
  readonly organizationId: string;
  readonly canonicalUserId: string;
  readonly email: string | null;
  readonly name: string;
};

export type AlcoreCustomerTransport = {
  readonly request: (path: string, init: RequestInit) => Promise<Response>;
};

export type GoogleIdentityTokenVerifier = (
  token: string,
  audience: string
) => Promise<{ readonly subject: string; readonly email: string } | null>;

const decodeBase64Url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export const verifyProductAssertion = (
  token: string,
  secret: string,
  issuer: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): ProductAssertion | null => {
  const parts = token.split('.');
  const header = parts[0];
  const payload = parts[1];
  const signature = parts[2];
  if (parts.length !== 3 || !header || !payload || !signature) return null;
  const data = `${header}.${payload}`;
  const expected = createHmac('sha256', secret).update(data).digest();
  const received = decodeBase64Url(signature);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    return null;
  try {
    const decodedHeader: unknown = JSON.parse(
      decodeBase64Url(header).toString('utf8')
    );
    if (
      typeof decodedHeader !== 'object' ||
      decodedHeader === null ||
      !('alg' in decodedHeader) ||
      decodedHeader.alg !== 'HS256'
    )
      return null;
    const decoded: unknown = JSON.parse(
      decodeBase64Url(payload).toString('utf8')
    );
    if (typeof decoded !== 'object' || decoded === null) return null;
    const claims = decoded as Record<string, unknown>;
    if (
      typeof claims.sub !== 'string' ||
      claims.sub.length === 0 ||
      typeof claims.sid !== 'string' ||
      claims.sid.length === 0 ||
      claims.iss !== issuer ||
      claims.aud !== LIBRE_AUDIENCE ||
      claims.intent !== PRODUCT_EXCHANGE_INTENT ||
      typeof claims.exp !== 'number' ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= nowSeconds
    )
      return null;
    return {
      sub: claims.sub,
      sid: claims.sid,
      iss: issuer,
      aud: LIBRE_AUDIENCE,
      exp: claims.exp,
      intent: PRODUCT_EXCHANGE_INTENT,
      ...(typeof claims.email === 'string' && claims.email.trim() !== ''
        ? { email: claims.email }
        : {}),
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
};

const authBaseUrl = (): string =>
  (process.env.AUTH_BASE_URL || 'https://auth.alcore.io.vn').replace(
    /\/+$/,
    ''
  );

const parseJson = async (
  response: Response
): Promise<Record<string, unknown> | null> => {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : null;
};

/**
 * Why an exchange failed, so 401 means bad credentials rather than also
 * covering rate limits and Auth outages. Anti-enumeration invariant: never add
 * a reason that separates unknown-email from wrong-password — Auth answers both
 * with `invalid_credentials`, and that collapse is what prevents account
 * enumeration.
 */
export type CanonicalAuthFailure =
  | 'invalid_credentials'
  | 'email_taken'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response';

export type CanonicalExchangeResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: CanonicalAuthFailure };

export type CanonicalAssertionResult =
  | { readonly ok: true; readonly assertion: ProductAssertion }
  | { readonly ok: false; readonly reason: CanonicalAuthFailure };

const classifyFailure = (status: number): CanonicalAuthFailure => {
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'email_taken';
  if (status === 400 || status === 401) return 'invalid_credentials';
  if (status >= 500) return 'unavailable';
  return 'invalid_response';
};

export const exchangeCanonicalCredentials = async (
  credentials: CanonicalCredentialInput,
  transport: AuthTransport,
  signal: AbortSignal
): Promise<CanonicalExchangeResult> => {
  let authBearer = '';
  let password = credentials.password;
  try {
    const path = credentials.signup ? '/auth/register' : '/auth/login';
    const response = await transport.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credentials.email, password }),
      signal,
    });
    if (!response.ok)
      return { ok: false, reason: classifyFailure(response.status) };
    const body = await parseJson(response);
    if (typeof body?.['access_token'] !== 'string') {
      return { ok: false, reason: 'invalid_response' };
    }
    authBearer = body['access_token'];
    const exchange = await transport.request('/oidc/exchange', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authBearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audience: LIBRE_AUDIENCE,
        intent: PRODUCT_EXCHANGE_INTENT,
      }),
      signal,
    });
    if (!exchange.ok)
      return { ok: false, reason: classifyFailure(exchange.status) };
    const codeBody = await parseJson(exchange);
    if (typeof codeBody?.['code'] !== 'string') {
      return { ok: false, reason: 'invalid_response' };
    }
    authBearer = '';
    return { ok: true, code: codeBody['code'] };
  } finally {
    authBearer = '';
    password = '';
    credentials.password = '';
  }
};

const alcoreConfig = (): AlcoreCustomerConfig | null => {
  const baseUrl = process.env.ALCORE_API_URL?.trim().replace(/\/+$/, '');
  const organizationId = process.env.ALCORE_ORGANIZATION_ID?.trim();
  if (!baseUrl || !organizationId) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
  } catch {
    return null;
  }
  if (!/^[0-9a-fA-F]{24}$/.test(organizationId)) return null;
  return { baseUrl, organizationId };
};

export const alcoreCustomerAuthEnabled = (): boolean =>
  Boolean(process.env.ALCORE_API_URL?.trim());

const parseAlcoreCustomer = (value: unknown): AlcoreCustomer | null => {
  if (typeof value !== 'object' || value === null) return null;
  const customer = value as Record<string, unknown>;
  const id = customer['_id'];
  const organizationId = customer['organizationId'];
  const email = customer['email'];
  const name = customer['name'];
  if (
    typeof id !== 'string' ||
    !/^[0-9a-fA-F]{24}$/.test(id) ||
    typeof organizationId !== 'string' ||
    !/^[0-9a-fA-F]{24}$/.test(organizationId) ||
    (email !== null && typeof email !== 'string') ||
    typeof name !== 'string'
  )
    return null;
  return {
    id,
    organizationId,
    canonicalUserId: `alcore-customer:${organizationId.toLowerCase()}:${id.toLowerCase()}`,
    email,
    name,
  };
};

export const forwardAlcorePassword = async (
  credentials: CanonicalCredentialInput,
  transport: AlcoreCustomerTransport = {
    request: (url, init) => fetch(url, init),
  },
  signal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<AlcoreCustomer | null> => {
  const password = credentials.password;
  try {
    const config = alcoreConfig();
    if (!config) return null;
    const response = await transport.request(
      `${config.baseUrl}/public/customers/${credentials.signup ? 'register' : 'login'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: config.organizationId,
          ...(credentials.signup
            ? { name: credentials.email.split('@')[0] || 'customer' }
            : {}),
          email: credentials.email,
          password,
        }),
        signal,
      }
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const payload = body as Record<string, unknown>;
    return parseAlcoreCustomer(payload['customer']);
  } finally {
    credentials.password = '';
  }
};

export const forwardAlcoreGoogle = async (
  idToken: string,
  displayName: string | undefined,
  transport: AlcoreCustomerTransport = {
    request: (path, init) => fetch(path, init),
  },
  signal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<AlcoreCustomer | null> => {
  const config = alcoreConfig();
  if (!config) return null;
  const response = await transport.request(
    `${config.baseUrl}/public/customers/oauth/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId: config.organizationId,
        idToken,
        ...(displayName ? { displayName } : {}),
      }),
      signal,
    }
  );
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, unknown>;
  return parseAlcoreCustomer(payload['customer']);
};

// (unified-auth-core todo 16) The legacy Bearer password client lived here.
// See the tombstone below: no shared secret may be reintroduced.

type CanonicalGoogleStatus = {
  readonly configured: boolean;
  readonly clientId: string;
};

let cachedGoogleStatus: { at: number; value: CanonicalGoogleStatus } | null =
  null;
const GOOGLE_STATUS_TTL_MS = 30_000;

export const getCanonicalGoogleStatus = async (
  signal: AbortSignal = AbortSignal.timeout(2_500)
): Promise<CanonicalGoogleStatus> => {
  const cached = cachedGoogleStatus;
  if (cached && Date.now() - cached.at < GOOGLE_STATUS_TTL_MS)
    return cached.value;
  try {
    const response = await fetch(`${authBaseUrl()}/auth/google/config`, {
      signal,
    });
    if (!response.ok) return { configured: false, clientId: '' };
    const body = await parseJson(response);
    const clientId =
      typeof body?.['clientId'] === 'string' ? body['clientId'] : '';
    const result: CanonicalGoogleStatus = {
      configured: clientId.length > 0,
      clientId,
    };
    if (result.configured)
      cachedGoogleStatus = { at: Date.now(), value: result };
    return result;
  } catch {
    return { configured: false, clientId: '' };
  }
};

// REMOVED (unified-auth-core todo 16): legacy Bearer shared-secret bridge.
// consumeLibreExchangeCode lived here: it exchanged an Auth code at
// POST /oidc/exchange/token and verified the Auth-minted product assertion
// against the shared AUTH_JWT_SECRET before a Libre product session could be
// issued. That path is retired in every mode — the redirect
// POST /api/auth/alcore/exchange performs S2S-bound verification without any
// shared secret. AUTH_JWT_SECRET must not be reintroduced: no production code
// in backend/src may read it (this tombstone plus the removal test are the
// only allowed mentions).
