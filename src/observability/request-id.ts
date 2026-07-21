import { randomUUID } from 'node:crypto';

export type IdGenerator = () => string;

export function createRequestId(
  platformRequestId?: string,
  generateId: IdGenerator = randomUUID,
): string {
  const normalizedPlatformId = platformRequestId?.trim();

  return normalizedPlatformId ? normalizedPlatformId : `req_${generateId()}`;
}
