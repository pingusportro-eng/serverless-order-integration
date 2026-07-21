import { describe, expect, it, vi } from 'vitest';

import { createRequestId } from '../../src/index.js';

describe('createRequestId', () => {
  it('uses the trusted platform request ID when one is available', () => {
    const generateId = vi.fn(() => 'generated-id');

    expect(createRequestId('  api-gateway-id  ', generateId)).toBe('api-gateway-id');
    expect(generateId).not.toHaveBeenCalled();
  });

  it('generates a prefixed request ID when the platform ID is absent', () => {
    expect(createRequestId(undefined, () => 'generated-id')).toBe('req_generated-id');
    expect(createRequestId('   ', () => 'second-id')).toBe('req_second-id');
  });
});
