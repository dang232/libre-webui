import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  exchangeCanonicalCredentials,
  forwardAlcoreGoogle,
  forwardAlcorePassword,
  verifyProductAssertion,
} from './canonicalAuthService.js';

const assertion = (
  claims: Record<string, unknown>,
  secret = 'auth-test-secret'
): string => {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(input)
    .digest('base64url');
  return `${input}.${signature}`;
};

const validClaims = {
  sub: 'canonical-user',
  sid: 'auth-session',
  iss: 'auth.alcore.io.vn',
  aud: 'libre',
  exp: 200,
  intent: 'product_exchange',
};

test('Given valid Auth assertion, when verified, then returns canonical subject', () => {
  assert.equal(
    verifyProductAssertion(
      assertion(validClaims),
      'auth-test-secret',
      'auth.alcore.io.vn',
      100
    )?.sub,
    'canonical-user'
  );
});

test('Given another audience, when verified, then rejects assertion', () => {
  assert.equal(
    verifyProductAssertion(
      assertion({ ...validClaims, aud: 'tokenpanel' }),
      'auth-test-secret',
      'auth.alcore.io.vn',
      100
    ),
    null
  );
});

test('Given wrong issuer, when verified, then rejects assertion', () => {
  assert.equal(
    verifyProductAssertion(
      assertion(validClaims),
      'auth-test-secret',
      'other-issuer',
      100
    ),
    null
  );
});

test('Given expired assertion, when verified, then rejects assertion', () => {
  assert.equal(
    verifyProductAssertion(
      assertion({ ...validClaims, exp: 100 }),
      'auth-test-secret',
      'auth.alcore.io.vn',
      100
    ),
    null
  );
});

test('Given product assertion with different intent, when verified, then rejects assertion', () => {
  assert.equal(
    verifyProductAssertion(
      assertion({ ...validClaims, intent: 'session' }),
      'auth-test-secret',
      'auth.alcore.io.vn',
      100
    ),
    null
  );
});

test('Given a malformed Auth assertion, when verified, then rejects assertion', () => {
  assert.equal(
    verifyProductAssertion(
      'not.a.jwt',
      'auth-test-secret',
      'auth.alcore.io.vn',
      100
    ),
    null
  );
});

test('Given valid canonical credentials, when exchanged, then returns the verified assertion without returning the Auth bearer', async () => {
  const authBearer = 'auth-only-access-token';
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const transport = {
    request: async (path: string, init: RequestInit): Promise<Response> => {
      calls.push({ path, init });
      if (path === '/auth/login')
        return Response.json({ access_token: authBearer });
      if (path === '/oidc/exchange')
        return Response.json({ code: 'one-use-code' });
      return Response.json({ code: 'one-use-code' });
    },
  };
  process.env.AUTH_JWT_SECRET = 'auth-test-secret';
  process.env.AUTH_ISSUER = 'auth.alcore.io.vn';
  const result = await exchangeCanonicalCredentials(
    { email: 'user@example.com', password: 'private-password', signup: false },
    transport,
    AbortSignal.timeout(1000)
  );
  assert.equal(result, 'one-use-code');
  assert.deepEqual(
    calls.map(call => call.path),
    ['/auth/login', '/oidc/exchange']
  );
  assert.equal(
    calls[1]?.init.headers instanceof Headers
      ? calls[1].init.headers.get('Authorization')
      : (calls[1]?.init.headers as Record<string, string>)['Authorization'],
    `Bearer ${authBearer}`
  );
  assert.equal(calls[1]?.init.body?.toString().includes(authBearer), false);
});

test('Given a wrong signing key, when verified, then rejects assertion', () => {
  assert.equal(
    verifyProductAssertion(
      assertion(validClaims),
      'wrong-key',
      'auth.alcore.io.vn',
      100
    ),
    null
  );
});

test('Given configured Alcore, when password login forwards, then sends org-scoped credentials and maps its customer without retaining password', async () => {
  process.env.ALCORE_API_URL = 'https://alcore.example/';
  process.env.ALCORE_ORGANIZATION_ID = '0123456789abcdef01234567';
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const credentials = {
    email: 'user@example.com',
    password: 'secret',
    signup: false,
  };
  const customer = {
    _id: 'abcdef0123456789abcdef01',
    organizationId: process.env.ALCORE_ORGANIZATION_ID,
    email: 'server@example.com',
    name: 'Server User',
    passwordHash: 'never-return-this',
  };
  const result = await forwardAlcorePassword(credentials, {
    request: async (path, init) => {
      calls.push({ path, init });
      return Response.json({ token: 'alcore-token-not-used', customer });
    },
  });
  assert.equal(calls[0]?.path, 'https://alcore.example/public/customers/login');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    organizationId: process.env.ALCORE_ORGANIZATION_ID,
    email: 'user@example.com',
    password: 'secret',
  });
  assert.deepEqual(result, {
    id: customer._id,
    organizationId: customer.organizationId,
    canonicalUserId: `alcore-customer:${customer.organizationId}:${customer._id}`,
    email: customer.email,
    name: customer.name,
  });
  assert.equal(credentials.password, '');
});

test('Given successful Alcore registration, when retried with the same customer identity, then forwards register contract and returns same mapping identity', async () => {
  process.env.ALCORE_API_URL = 'https://alcore.example';
  process.env.ALCORE_ORGANIZATION_ID = '0123456789abcdef01234567';
  const paths: string[] = [];
  const customers = await Promise.all(
    [1, 2].map(() =>
      forwardAlcorePassword(
        { email: 'new@example.com', password: 'secret', signup: true },
        {
          request: async (path, init) => {
            paths.push(path);
            assert.equal(JSON.parse(String(init.body)).name, 'new');
            return Response.json(
              {
                token: 'ignored',
                customer: {
                  _id: 'abcdef0123456789abcdef01',
                  organizationId: process.env.ALCORE_ORGANIZATION_ID,
                  email: 'new@example.com',
                  name: 'new',
                },
              },
              { status: 201 }
            );
          },
        }
      )
    )
  );
  assert.deepEqual(paths, [
    'https://alcore.example/public/customers/register',
    'https://alcore.example/public/customers/register',
  ]);
  assert.deepEqual(customers[0], customers[1]);
});

test('Given incomplete Alcore config, when forwarding, then fails closed without making a request', async () => {
  delete process.env.ALCORE_ORGANIZATION_ID;
  let requested = false;
  const result = await forwardAlcorePassword(
    { email: 'user@example.com', password: 'secret', signup: false },
    {
      request: async () => {
        requested = true;
        return Response.json({});
      },
    }
  );
  assert.equal(result, null);
  assert.equal(requested, false);
});

test('Given a verified GIS ID token, when Google callback forwards, then maps only the server response customer', async () => {
  process.env.ALCORE_API_URL = 'https://alcore.example';
  process.env.ALCORE_ORGANIZATION_ID = '0123456789abcdef01234567';
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const result = await forwardAlcoreGoogle('gis.id.token', 'Display', {
    request: async (path, init) => {
      calls.push({ path, init });
      return Response.json(
        {
          token: 'alcore-bearer-must-not-be-returned',
          customer: {
            _id: 'abcdef0123456789abcdef01',
            organizationId: '0123456789abcdef01234567',
            email: 'server@example.com',
            name: 'Server Profile',
          },
        },
        { status: 201 }
      );
    },
  });
  assert.equal(
    calls[0]?.path,
    'https://alcore.example/public/customers/oauth/callback'
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    organizationId: process.env.ALCORE_ORGANIZATION_ID,
    idToken: 'gis.id.token',
    displayName: 'Display',
  });
  assert.equal(
    result?.canonicalUserId,
    'alcore-customer:0123456789abcdef01234567:abcdef0123456789abcdef01'
  );
  assert.equal('token' in (result ?? {}), false);
});
