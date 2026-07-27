import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const [, , secretFile, timestamp, bodyFile] = process.argv;
if (!secretFile || !timestamp || !bodyFile || !/^[1-9][0-9]*$/.test(timestamp)) {
  process.stderr.write('Usage: sign-webhook.mjs <secret-json-file> <unix-seconds> <body-file>\n');
  process.exitCode = 2;
} else {
  const secretDocument = JSON.parse(await readFile(secretFile, 'utf8'));
  if (
    typeof secretDocument !== 'object' ||
    secretDocument === null ||
    typeof secretDocument.webhookSecret !== 'string' ||
    secretDocument.webhookSecret.length < 32
  ) {
    throw new Error('Secret file does not contain a valid webhookSecret.');
  }
  const body = await readFile(bodyFile, 'utf8');
  const digest = createHmac('sha256', secretDocument.webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  process.stdout.write(`sha256=${digest}\n`);
}
