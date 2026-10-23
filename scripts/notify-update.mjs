import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const repository = 'hudantech/titen-ai-mobile-releases';
export const certificate = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
export function validateManifest(m, tag) {
  if (
    !m ||
    m.schemaVersion !== 1 ||
    m.packageId !== 'id.titen.mobile' ||
    m.channel !== 'internal' ||
    m.certificateSha256 !== certificate ||
    !Number.isSafeInteger(m.versionCode) ||
    m.versionCode < 1 ||
    m.versionCode > 2100000000 ||
    typeof m.versionName !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(m.versionName) ||
    m.tag !== tag ||
    tag !== `v${m.versionName}-build${m.versionCode}` ||
    typeof m.assetName !== 'string' ||
    m.assetName !== `titen-ai-${m.versionName}-build${m.versionCode}-arm64.apk` ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes < 1 ||
    m.bytes > 200 * 1024 * 1024 ||
    m.apkUrl !== `https://github.com/${repository}/releases/download/${tag}/${m.assetName}` ||
    m.releaseUrl !== `https://github.com/${repository}/releases/tag/${tag}`
  )
    throw Error('The stable update manifest is invalid or does not match the release.');
  return m;
}
export function updateMessage(build) {
  if (!Number.isSafeInteger(build) || build < 1) throw Error('Invalid update build.');
  return {
    topic: 'android-internal-updates',
    data: { kind: 'titen-update', versionCode: String(build) },
    android: { priority: 'HIGH', ttl: '86400s', collapse_key: 'titen-android-update' },
  };
}
async function json(url, limit = 16384, api = false) {
  const headers = { Accept: 'application/json' };
  if (api && process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error('Release metadata is unavailable: HTTP ' + r.status);
  const text = await r.text();
  if (text.length > limit) throw Error('Oversized release metadata.');
  return JSON.parse(text);
}
export async function verifyRelease(tag) {
  const api = `https://api.github.com/repos/${repository}/releases`;
  const release = await json(
    tag ? api + '/tags/' + encodeURIComponent(tag) : api + '/latest',
    300000,
    true,
  );
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+-build\d+$/.test(release.tag_name))
    throw Error('Only published stable Android releases may notify devices.');
  const manifest = validateManifest(
    await json(
      `https://github.com/${repository}/releases/download/${release.tag_name}/android-update.json`,
    ),
    release.tag_name,
  );
  const apk = release.assets.find((a) => a.name === manifest.assetName);
  for (const name of [
    'android-update.json',
    manifest.assetName + '.sha256',
    'ANDROID-NOTICES.txt',
    'LICENSES.txt',
  ])
    if (!release.assets.some((a) => a.name === name && a.state === 'uploaded'))
      throw Error('Missing release asset: ' + name);
  if (
    !apk ||
    apk.state !== 'uploaded' ||
    apk.size !== manifest.bytes ||
    (apk.digest && apk.digest !== 'sha256:' + manifest.sha256)
  )
    throw Error('APK asset metadata differs from the manifest.');
  const checksum = await fetch(manifest.apkUrl + '.sha256', { signal: AbortSignal.timeout(30000) });
  if (
    !checksum.ok ||
    (await checksum.text()).trim() !== manifest.sha256 + '  ' + manifest.assetName
  )
    throw Error('APK checksum asset differs from the manifest.');
  let synchronized = false;
  for (let i = 0; i < 30; i++) {
    const [latest, mirror] = await Promise.all([
      json(`https://github.com/${repository}/releases/latest/download/android-update.json`),
      json(
        `https://raw.githubusercontent.com/${repository}/main/android-update.json?notify=${Date.now()}`,
      ),
    ]);
    if (
      [latest, mirror].every(
        (m) =>
          m.versionCode === manifest.versionCode &&
          m.sha256 === manifest.sha256 &&
          m.tag === manifest.tag,
      )
    ) {
      synchronized = true;
      break;
    }
    if (i < 29) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!synchronized)
    throw Error('Latest release and fallback manifest have not synchronized; no push sent.');
  const response = await fetch(manifest.apkUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw Error('APK download is unavailable.');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > manifest.bytes) throw Error('APK download is oversized.');
    hash.update(chunk);
  }
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256)
    throw Error('APK byte count or SHA-256 differs.');
  return manifest;
}
async function main() {
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const mode = process.argv[2];
  if (mode === 'verify') {
    const manifest = await verifyRelease(event.release?.tag_name || event.inputs?.tag || '');
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `build=${manifest.versionCode}\ntag=${manifest.tag}\n`,
      );
    console.log(
      `Verified stable build ${manifest.versionCode}: APK, SHA-256 and both update manifests.`,
    );
  } else if (mode === 'send') {
    const message = updateMessage(Number(process.env.UPDATE_BUILD));
    if (!process.env.FCM_ACCESS_TOKEN) throw Error('Missing short-lived FCM access token.');
    const r = await fetch('https://fcm.googleapis.com/v1/projects/titen-ai-mobile/messages:send', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: 'Bearer ' + process.env.FCM_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ validate_only: process.env.PUSH_MODE !== 'send', message }),
    });
    if (!r.ok)
      throw Error(
        'FCM rejected the update message: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 1000),
      );
    console.log(
      process.env.PUSH_MODE === 'send'
        ? 'FCM update check sent.'
        : 'FCM credentials and message validated; nothing sent.',
    );
  } else throw Error('Expected verify or send.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
