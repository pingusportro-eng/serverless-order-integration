import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const SIGNING_SECRET_PREFIX = 'whsec_';
const CONSISTENCY_ATTEMPTS = 6;
const CONSISTENCY_DELAY_MS = 250;

function lifecycleError(message, cause) {
  return new StripeWebhookLifecycleError(message, { cause });
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string') {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function validateRecovery(recovery) {
  if (
    typeof recovery !== 'object' ||
    recovery === null ||
    typeof recovery.endpointId !== 'string' ||
    !recovery.endpointId.startsWith('we_')
  ) {
    throw new TypeError('Stripe webhook recovery state must contain a webhook endpoint ID.');
  }
}

async function eventually(check, waitForConsistency = sleep) {
  for (let attempt = 1; attempt <= CONSISTENCY_ATTEMPTS; attempt += 1) {
    if (await check()) {
      return true;
    }
    if (attempt < CONSISTENCY_ATTEMPTS) {
      await waitForConsistency(CONSISTENCY_DELAY_MS);
    }
  }
  return false;
}

export class StripeWebhookLifecycleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StripeWebhookLifecycleError';
  }
}

export async function prepareStripeWebhookLifecycle({
  endpointManager,
  parameterStore,
  webhookUrl,
  webhookSecretParameterName,
  saveRecovery,
  waitForConsistency,
}) {
  let prepared;
  try {
    prepared = await endpointManager.prepare(webhookUrl);
  } catch (error) {
    throw lifecycleError('Stripe webhook endpoint preparation failed.', error);
  }

  const recovery = { endpointId: prepared.endpointId };
  try {
    await saveRecovery(recovery);
  } catch (error) {
    try {
      await endpointManager.deleteOwnedEndpoint(prepared.endpointId);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Stripe webhook recovery state failed before endpoint ${prepared.endpointId} could be recorded or removed.`,
        { cause: cleanupError },
      );
    }
    throw lifecycleError('Stripe webhook recovery state could not be recorded.', error);
  }

  if (
    typeof prepared.signingSecret !== 'string' ||
    !prepared.signingSecret.startsWith(SIGNING_SECRET_PREFIX)
  ) {
    throw lifecycleError('Stripe returned an invalid webhook signing secret.');
  }

  try {
    await parameterStore.putSecureString(webhookSecretParameterName, prepared.signingSecret);
    const verified = await eventually(
      async () =>
        sameSecret(
          await parameterStore.readSecureString(webhookSecretParameterName),
          prepared.signingSecret,
        ),
      waitForConsistency,
    );
    if (!verified) {
      throw new Error('the stored Stripe webhook secret did not match the created endpoint');
    }
  } catch (error) {
    throw lifecycleError('Stripe webhook signing-secret activation failed.', error);
  }

  return {
    endpointId: prepared.endpointId,
    url: prepared.url,
    replacedEndpointIds: prepared.replacedEndpointIds,
  };
}

export async function cleanupStripeWebhookLifecycle({
  endpointManager,
  parameterStore,
  recovery,
  webhookSecretParameterName,
  clearRecovery,
  waitForConsistency,
}) {
  validateRecovery(recovery);

  try {
    await endpointManager.deleteOwnedEndpoint(recovery.endpointId);
    const verification = await endpointManager.deleteOwnedEndpoint(recovery.endpointId);
    if (verification !== 'absent') {
      throw new Error('Stripe did not verify webhook endpoint absence');
    }
  } catch (error) {
    throw lifecycleError('Stripe webhook endpoint cleanup failed.', error);
  }

  try {
    await parameterStore.deleteParameter(webhookSecretParameterName);
    const verified = await eventually(
      async () => (await parameterStore.readSecureString(webhookSecretParameterName)) === undefined,
      waitForConsistency,
    );
    if (!verified) {
      throw new Error('the obsolete Stripe webhook signing-secret parameter still exists');
    }
  } catch (error) {
    throw lifecycleError('Stripe webhook signing-secret cleanup failed.', error);
  }

  try {
    await clearRecovery();
  } catch (error) {
    throw lifecycleError('Stripe webhook recovery state cleanup failed.', error);
  }
}
