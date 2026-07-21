export type HttpHeaders = Readonly<Record<string, string>>;

export interface HttpResponse<TBody> {
  readonly statusCode: number;
  readonly headers: HttpHeaders;
  readonly body: TBody;
}

export type SuccessStatus = 200 | 201 | 202;

export function successResponse<TBody>(
  statusCode: SuccessStatus,
  body: TBody,
  requestId: string,
  headers: HttpHeaders = {},
): HttpResponse<TBody> {
  return {
    statusCode,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
    body,
  };
}
