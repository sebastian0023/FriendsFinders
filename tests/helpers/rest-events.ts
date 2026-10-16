import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export interface RestEventOptions {
  /** The authenticated caller (Cognito `sub`). Defaults to 'user-1'; `null` means no claims. */
  sub?: string | null;
  /** Serialised with JSON.stringify. */
  body?: unknown;
  /** Sent as-is, for malformed or non-JSON payloads. */
  rawBody?: string;
}

/** Builds an API Gateway HTTP API (v2) event as the REST handler sees it. */
export function restEvent(method: string, path: string, opts: RestEventOptions = {}): APIGatewayProxyEventV2 {
  const sub = opts.sub === undefined ? 'user-1' : opts.sub;
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));

  return {
    rawPath: path,
    body,
    requestContext: {
      http: { method },
      // The JWT authorizer injects verified claims; no claims means an unauthenticated call.
      authorizer: sub === null ? undefined : { jwt: { claims: { sub } } },
    },
  } as unknown as APIGatewayProxyEventV2;
}

export const resultStatus = (result: APIGatewayProxyResultV2): number =>
  (result as { statusCode: number }).statusCode;

export const resultJson = (result: APIGatewayProxyResultV2): any =>
  JSON.parse((result as { body: string }).body);

export const resultHeaders = (result: APIGatewayProxyResultV2): Record<string, unknown> =>
  (result as { headers: Record<string, unknown> }).headers;
