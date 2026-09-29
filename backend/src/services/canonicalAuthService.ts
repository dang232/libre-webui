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

export const exchangeCanonicalCredentials = async (
  credentials: CanonicalCredentialInput,
  transport: AuthTransport,
  signal: AbortSignal
): Promise<string | null> => {
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
    if (!response.ok) return null;
    const body = await parseJson(response);
    if (typeof body?.['access_token'] !== 'string') return null;
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
    if (!exchange.ok) return null;
    const codeBody = await parseJson(exchange);
    if (typeof codeBody?.['code'] !== 'string') return null;
    authBearer = '';
    return codeBody['code'];
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

export const authenticateCanonicalPassword = async (
  credentials: CanonicalCredentialInput,
  signal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<ProductAssertion | null> => {
  const base = authBaseUrl();
  const code = await exchangeCanonicalCredentials(
    credentials,
    {
      request: (path, init) => fetch(`${base}${path}`, init),
    },
    signal
  );
  if (!code) return null;
  return consumeLibreExchangeCode(code, signal);
};

export const exchangeCanonicalGoogleToken = async (
  idToken: string,
  signal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<string | null> => {
  const base = authBaseUrl();
  const verified = await fetch(`${base}/auth/google/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
    signal,
  });
  if (verified.status >= 500) {
    throw new Error('Auth Google verification is unavailable');
  }
  if (!verified.ok) return null;
  const verifiedBody = await parseJson(verified);
  if (typeof verifiedBody?.['access_token'] !== 'string') return null;
  const exchanged = await fetch(`${base}/oidc/exchange`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${verifiedBody['access_token']}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audience: LIBRE_AUDIENCE,
      intent: PRODUCT_EXCHANGE_INTENT,
    }),
    signal,
  });
  if (!exchanged.ok) return null;
  const codeBody = await parseJson(exchanged);
  return typeof codeBody?.['code'] === 'string' ? codeBody['code'] : null;
};

export const getCanonicalGoogleStatus = async (
  signal: AbortSignal = AbortSignal.timeout(5_000)
): Promise<{ readonly configured: boolean; readonly clientId: string }> => {
  const response = await fetch(`${authBaseUrl()}/auth/google/config`, {
    signal,
  });
  if (!response.ok) return { configured: false, clientId: '' };
  const body = await parseJson(response);
  const clientId =
    typeof body?.['clientId'] === 'string' ? body['clientId'] : '';
  return { configured: clientId.length > 0, clientId };
};

export const consumeLibreExchangeCode = async (
  code: string,
  timeoutSignal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<ProductAssertion | null> => {
  const response = await fetch(`${authBaseUrl()}/oidc/exchange/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      audience: LIBRE_AUDIENCE,
      intent: PRODUCT_EXCHANGE_INTENT,
    }),
    signal: timeoutSignal,
  });
  if (!response.ok) return null;
  const body = await parseJson(response);
  if (typeof body?.['access_token'] !== 'string') return null;
  const secret = process.env.AUTH_JWT_SECRET || '';
  if (secret.length === 0) return null;
  return verifyProductAssertion(
    body['access_token'],
    secret,
    process.env.AUTH_ISSUER || 'auth.alcore.io.vn'
  );
};
