import fs from 'node:fs/promises';
import path from 'node:path';
import { googleApiRequest, loadGoogleAuth, loadProjectConfig } from './lib/google-auth.mjs';

const STATION_SHEET = 'SatFinder_Stations';
const CONFIG_SHEET = 'Config';
const LOG_SHEET = 'Import_Log';
const TINYGS_URL = 'https://api.tinygs.com/v3/stations';
const TINYGS_CLIENT_KEY = 'TinyGS-WebApp-2025-SecureKey';
const DEFAULT_PREFIXES = ['SatFinder', 'SatFider'];
const DEFAULT_TYPO_TOLERANCE = 1;
const LOCK_MAX_AGE_MS = 15 * 60 * 1000;
const GOOGLE_SHEETS_EPOCH_OFFSET = 25569;

const STATION_HEADERS = [
  'stationKey',
  'name',
  'userId',
  'statusCode',
  'isOnline',
  'monitorState',
  'lastSeen',
  'lastPacketTime',
  'minutesSinceSeen',
  'confirmedPackets',
  'telemetryPackets',
  'satellite',
  'satDisplayName',
  'autoTune',
  'version',
  'latitude',
  'longitude',
  'hasPictures',
  'isTest',
  'latestImportAt',
  'importBatchId',
  'rawJson',
];

function requireConfirmation() {
  if (!process.argv.includes('--yes')) {
    throw new Error('Writing to Google Sheet requires --yes.');
  }
}

function createTinyGsClientTimestamp(timestampMs = Date.now()) {
  const value = String(timestampMs);
  const bytes = Buffer.alloc(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) ^ TINYGS_CLIENT_KEY.charCodeAt(index % TINYGS_CLIENT_KEY.length);
  }
  return bytes.toString('base64');
}

async function fetchTinyGsStations(url) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const headers = {
      accept: 'application/json',
      'cache-control': 'no-cache',
      origin: 'https://app.tinygs.com',
      referer: 'https://app.tinygs.com/',
      'user-agent': 'Mozilla/5.0 SatFinder-Monitor/1.0',
      'x-client-timestamp': createTinyGsClientTimestamp(),
    };
    const bearerToken = String(process.env.TINYGS_BEARER_TOKEN || '').trim();
    if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`TinyGS API returned HTTP ${response.status}.`);
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 5_000_000) {
        throw new Error(`TinyGS response is unexpectedly large (${contentLength} bytes).`);
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length < 100) {
        throw new Error('TinyGS response did not contain the expected station array.');
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}

function configMap(values) {
  return Object.fromEntries(values.slice(1).filter((row) => row[0]).map((row) => [String(row[0]), row[1]]));
}

function splitPrefixes(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePrefix(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function matchesPrefix(name, prefixes, tolerance) {
  const normalizedName = normalizePrefix(name);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizePrefix(prefix);
    if (!normalizedPrefix) return false;
    if (normalizedName.startsWith(normalizedPrefix)) return true;
    if (tolerance <= 0 || normalizedName.length < normalizedPrefix.length) return false;
    return editDistance(normalizedName.slice(0, normalizedPrefix.length), normalizedPrefix) <= tolerance;
  });
}

function toEpochMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSheetsSerial(epochMs) {
  return epochMs ? epochMs / 86_400_000 + GOOGLE_SHEETS_EPOCH_OFFSET : '';
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : '';
}

function monitorState(isOnline, minutesSinceSeen, recentWindowMinutes) {
  if (isOnline) return 'online';
  if (minutesSinceSeen !== '' && minutesSinceSeen <= recentWindowMinutes) return 'recent';
  return 'followup';
}

function normalizeStation(record, now, batchId, recentWindowMinutes) {
  const name = String(record?.name || '').trim();
  const location = Array.isArray(record?.location) ? record.location : [];
  const lastSeenMs = toEpochMs(record?.lastSeen);
  const lastPacketMs = toEpochMs(record?.lastPacketTime);
  const minutesSinceSeen = lastSeenMs ? Math.max(0, Math.round((now.getTime() - lastSeenMs) / 60_000)) : '';
  const statusCode = numberOr(record?.status, 0);
  const isOnline = statusCode === 1;

  return [
    name.toLowerCase(),
    name,
    record?.userId ?? '',
    statusCode,
    isOnline,
    monitorState(isOnline, minutesSinceSeen, recentWindowMinutes),
    toSheetsSerial(lastSeenMs),
    toSheetsSerial(lastPacketMs),
    minutesSinceSeen,
    numberOr(record?.confirmedPackets, 0),
    numberOr(record?.telemetryPackets, 0),
    record?.satellite ?? '',
    record?.satDisplayName ?? record?.satellite ?? '',
    record?.autoTune ?? '',
    record?.version ?? '',
    nullableNumber(location[0]),
    nullableNumber(location[1]),
    Boolean(record?.hasPictures),
    Boolean(record?.test),
    toSheetsSerial(now.getTime()),
    batchId,
    JSON.stringify(record),
  ];
}

function mergeStationRows(existingValues, importedRows, batchId) {
  const existingRows = existingValues.slice(1).filter((row) => row.some((value) => value !== '' && value !== null));
  const rowsByKey = new Map();
  for (const row of existingRows) {
    const key = String(row[0] || row[1] || '').trim().toLowerCase();
    if (key) rowsByKey.set(key, [...row, ...Array(Math.max(0, STATION_HEADERS.length - row.length)).fill('')].slice(0, STATION_HEADERS.length));
  }

  let inserted = 0;
  let updated = 0;
  for (const row of importedRows) {
    if (rowsByKey.has(row[0])) updated += 1;
    else inserted += 1;
    rowsByKey.set(row[0], row);
  }

  const batchColumn = STATION_HEADERS.indexOf('importBatchId');
  const statusColumn = STATION_HEADERS.indexOf('statusCode');
  const onlineColumn = STATION_HEADERS.indexOf('isOnline');
  const stateColumn = STATION_HEADERS.indexOf('monitorState');
  for (const row of rowsByKey.values()) {
    if (String(row[batchColumn] || '') !== batchId) {
      row[statusColumn] = 0;
      row[onlineColumn] = false;
      row[stateColumn] = 'followup';
    }
  }

  const confirmedColumn = STATION_HEADERS.indexOf('confirmedPackets');
  const telemetryColumn = STATION_HEADERS.indexOf('telemetryPackets');
  const nameColumn = STATION_HEADERS.indexOf('name');
  const rows = [...rowsByKey.values()].sort((left, right) => {
    return Number(right[onlineColumn]) - Number(left[onlineColumn])
      || numberOr(right[confirmedColumn]) - numberOr(left[confirmedColumn])
      || numberOr(right[telemetryColumn]) - numberOr(left[telemetryColumn])
      || String(left[nameColumn]).localeCompare(String(right[nameColumn]));
  });
  return { rows, inserted, updated };
}

function batchIdFor(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

async function readSheet(auth, baseUrl, range) {
  return googleApiRequest(auth, {
    url: `${baseUrl}/values/${encodeURIComponent(range)}`,
    params: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' },
  });
}

async function writeStatusFile(dataDir, status) {
  await fs.writeFile(path.join(dataDir, 'tinygs-last-run.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

async function acquireLock(dataDir) {
  const lockPath = path.join(dataDir, 'tinygs-sync.lock');
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_MAX_AGE_MS) await fs.unlink(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(lockPath, 'wx');
  await handle.writeFile(`${process.pid}\n`, 'utf8');
  await handle.close();
  return async () => fs.unlink(lockPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

requireConfirmation();
const startedAt = new Date();
const config = await loadProjectConfig();
const auth = await loadGoogleAuth();
const dataDir = path.resolve('.data');
await fs.mkdir(dataDir, { recursive: true });
const releaseLock = await acquireLock(dataDir);

try {
  const sheetsBaseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}`;
  const [configData, stationData] = await Promise.all([
    readSheet(auth, sheetsBaseUrl, `${CONFIG_SHEET}!A1:C100`),
    readSheet(auth, sheetsBaseUrl, `${STATION_SHEET}!A1:V5000`),
  ]);
  const settings = configMap(configData.values || []);
  const prefixes = [...new Set([
    ...splitPrefixes(settings.StationPrefixes),
    ...splitPrefixes(settings.StationPrefix),
  ])];
  const activePrefixes = prefixes.length ? prefixes : DEFAULT_PREFIXES;
  const tolerance = Math.max(0, Math.min(2, Math.round(numberOr(settings.StationPrefixTypoTolerance, DEFAULT_TYPO_TOLERANCE))));
  const recentWindowMinutes = Math.max(1, Math.round(numberOr(settings.RecentWindowMinutes, 360)));
  const apiUrl = String(settings.TinyGsApiUrl || TINYGS_URL).trim();
  if (!/^https:\/\/api\.tinygs\.com\//i.test(apiUrl)) throw new Error('TinyGsApiUrl must use https://api.tinygs.com/.');

  const rawRecords = await fetchTinyGsStations(apiUrl);
  await fs.writeFile(path.join(dataDir, 'tinygs-stations.json'), `${JSON.stringify(rawRecords)}\n`, 'utf8');

  const batchId = batchIdFor(startedAt);
  let skippedNoName = 0;
  let stationsWithoutLocation = 0;
  const importedByKey = new Map();
  for (const record of rawRecords) {
    const name = String(record?.name || '').trim();
    if (!name) {
      skippedNoName += 1;
      continue;
    }
    if (!matchesPrefix(name, activePrefixes, tolerance)) continue;
    const row = normalizeStation(record, startedAt, batchId, recentWindowMinutes);
    if (row[15] === '' || row[16] === '') stationsWithoutLocation += 1;
    importedByKey.set(row[0], row);
  }
  if (!importedByKey.size) throw new Error(`No stations matched prefixes: ${activePrefixes.join(', ')}`);

  const merged = mergeStationRows(stationData.values || [STATION_HEADERS], [...importedByKey.values()], batchId);
  const outputValues = [STATION_HEADERS, ...merged.rows];
  await fs.writeFile(
    path.join(dataDir, 'tinygs-previous-sheet.json'),
    `${JSON.stringify({ savedAt: startedAt.toISOString(), values: stationData.values || [] })}\n`,
    'utf8',
  );

  await googleApiRequest(auth, {
    url: `${sheetsBaseUrl}/values/${encodeURIComponent(`${STATION_SHEET}!A1:V${outputValues.length}`)}`,
    method: 'PUT',
    params: { valueInputOption: 'RAW' },
    data: { values: outputValues },
  });
  const previousRowCount = Math.max(0, (stationData.values || []).length);
  if (previousRowCount > outputValues.length) {
    await googleApiRequest(auth, {
      url: `${sheetsBaseUrl}/values:batchClear`,
      method: 'POST',
      data: { ranges: [`${STATION_SHEET}!A${outputValues.length + 1}:V${previousRowCount}`] },
    });
  }

  const configRows = configData.values || [];
  const managedConfig = {
    LatestImportBatchId: batchId,
    LastImportAt: startedAt.toISOString(),
    LastTinyGsFetchAt: startedAt.toISOString(),
    LastTinyGsFetchStatus: `OK: ${rawRecords.length} records, ${importedByKey.size} matched`,
  };
  const updates = [];
  for (const [key, value] of Object.entries(managedConfig)) {
    const rowIndex = configRows.findIndex((row) => String(row[0] || '').trim() === key);
    if (rowIndex >= 1) updates.push({ range: `${CONFIG_SHEET}!B${rowIndex + 1}`, values: [[value]] });
  }
  if (updates.length) {
    await googleApiRequest(auth, {
      url: `${sheetsBaseUrl}/values:batchUpdate`,
      method: 'POST',
      data: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }

  await googleApiRequest(auth, {
    url: `${sheetsBaseUrl}/values/${encodeURIComponent(`${LOG_SHEET}!A:J`)}:append`,
    method: 'POST',
    params: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
    data: { values: [[
      startedAt.toISOString(), batchId, activePrefixes.join(', '), rawRecords.length,
      importedByKey.size, merged.inserted, merged.updated, skippedNoName,
      stationsWithoutLocation, 'OK: TinyGS API via local scheduled worker',
    ]] },
  });

  const status = {
    ok: true,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    batchId,
    rawRecords: rawRecords.length,
    matchedStations: importedByKey.size,
    inserted: merged.inserted,
    updated: merged.updated,
  };
  await writeStatusFile(dataDir, status);
  console.log(JSON.stringify(status, null, 2));
} catch (error) {
  const status = {
    ok: false,
    startedAt: startedAt.toISOString(),
    failedAt: new Date().toISOString(),
    error: error.message,
  };
  await writeStatusFile(dataDir, status);
  console.error(JSON.stringify(status, null, 2));
  process.exitCode = 1;
} finally {
  await releaseLock();
}
