import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);

function argumentValue(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const sourceUrl = argumentValue('--url', process.env.SATFINDER_PUBLIC_API_URL || '').trim();
const outputPath = resolve(argumentValue('--output', 'docs/data/stations.json'));

if (!/^https:\/\//i.test(sourceUrl)) {
  throw new Error('Set SATFINDER_PUBLIC_API_URL or pass --url with an HTTPS Apps Script endpoint.');
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fetchSource() {
  const url = new URL(sourceUrl);
  url.searchParams.set('format', 'json');
  url.searchParams.set('_', Date.now().toString());

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'satfinder-monitor-snapshot/1.0',
        },
      });
      if (!response.ok) throw new Error(`Apps Script returned HTTP ${response.status}.`);
      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn(`Snapshot attempt ${attempt}/4 failed: ${error.message}`);
      if (attempt < 4) await sleep(attempt * 2_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactPayload(payload) {
  if (!payload?.ok || !payload?.data || !Array.isArray(payload.data.stations)) {
    throw new Error('Apps Script returned an invalid SatFinder payload.');
  }

  const data = payload.data;
  const stations = data.stations
    .filter((station) => String(station?.name || '').trim())
    .map((station) => ({
      stationKey: String(station.stationKey || station.name),
      name: String(station.name),
      satellite: String(station.satellite || ''),
      satDisplayName: String(station.satDisplayName || ''),
      latitude: finiteNumber(station.latitude),
      longitude: finiteNumber(station.longitude),
      region: String(station.region || ''),
    }));

  const summary = data.summary || {};
  return {
    ok: true,
    schemaVersion: 2,
    data: {
      generatedAt: data.generatedAt || new Date().toISOString(),
      config: {
        lastImportAt: data.config?.lastImportAt || '',
      },
      summary: {
        totalStations: Number(summary.totalStations) || stations.length,
        withLocation: Number(summary.withLocation) || stations.filter((station) => station.latitude !== null && station.longitude !== null).length,
        confirmedPackets: Number(summary.confirmedPackets) || 0,
      },
      stations,
    },
  };
}

const snapshot = compactPayload(await fetchSource());
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`, 'utf8');

console.log(`Wrote ${snapshot.data.stations.length} stations to ${outputPath}.`);
