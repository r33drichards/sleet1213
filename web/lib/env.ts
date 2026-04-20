// Centralised env accessors. Throws on missing required values so we fail
// fast at request time instead of silently misbehaving.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const env = {
  tedUrl: process.env.TED_URL ?? 'http://127.0.0.1:8787',
  keycloakIssuer: () => required('AUTH_KEYCLOAK_ISSUER'),
  keycloakClientId: () => required('AUTH_KEYCLOAK_ID'),
  keycloakClientSecret: () => required('AUTH_KEYCLOAK_SECRET'),
  nextAuthSecret: () => required('NEXTAUTH_SECRET'),
};
