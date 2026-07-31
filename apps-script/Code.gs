/**
 * SatFinder TinyGS Monitor
 *
 * A scheduled API worker writes TinyGS station data into the bound Google
 * Sheet. This Apps Script publishes the dashboard/API and retains RAW_JSON as
 * a manual fallback. No browser session is required for recurring updates.
 */

const SATFINDER = Object.freeze({
  RAW_SHEET: 'RAW_JSON',
  STATION_SHEET: 'SatFinder_Stations',
  CONFIG_SHEET: 'Config',
  LOG_SHEET: 'Import_Log',
  SUMMARY_SHEET: 'Project_Summary',
  DEFAULT_PREFIX: 'SatFinder',
  DEFAULT_PREFIXES: ['SatFinder', 'SatFider'],
  DEFAULT_PREFIX_TYPO_TOLERANCE: 1,
  TIMEZONE: 'Asia/Bangkok',
});

const CONFIG_ROWS = [
  ['StationPrefix', 'SatFinder', 'Only station names that begin with this prefix are imported.'],
  ['StationPrefixes', 'SatFinder, SatFider', 'Comma/newline separated prefixes. Case-insensitive; supports common typo variants such as satfider.'],
  ['StationPrefixTypoTolerance', '1', 'Allowed typo distance for the prefix only. Use 0 for exact prefixes, 1 for common one-character mistakes.'],
  ['TinyGsApiUrl', 'https://api.tinygs.com/v3/stations', 'TinyGS station endpoint used by the scheduled API worker.'],
  ['TinyGsRefreshMinutes', '60', 'Windows scheduled worker interval in minutes.'],
  ['LastTinyGsFetchAt', '', 'Managed by the script.'],
  ['LastTinyGsFetchStatus', '', 'Managed by the script.'],
  ['ProjectName', 'SatFinder', 'Public project name shown on the dashboard.'],
  ['DashboardTitle', 'SatFinder TinyGS World Monitor', 'Dashboard title.'],
  ['CountryFocus', 'Thailand', 'Country or program coverage label.'],
  ['OperatorName', 'คณะวิศวกรรมศาสตร์ มหาวิทยาลัยธรรมศาสตร์', 'Project operator.'],
  ['PartnerName', 'สถาบันวิจัยและให้คำปรึกษาแห่งมหาวิทยาลัยธรรมศาสตร์', 'Project partner.'],
  ['RecentWindowMinutes', '360', 'Non-online stations seen within this window are shown as recently seen.'],
  ['FollowUpWindowMinutes', '1440', 'Used as the default review window for quiet stations.'],
  ['LatestImportBatchId', '', 'Managed by the script.'],
  ['LastImportAt', '', 'Managed by the script.'],
];

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

const LOG_HEADERS = [
  'importedAt',
  'batchId',
  'prefix',
  'rawRecords',
  'matchedStations',
  'inserted',
  'updated',
  'skippedNoName',
  'stationsWithoutLocation',
  'message',
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SatFinder')
    .addItem('1) เตรียม Environment', 'setupSatFinderEnvironment')
    .addItem('นำเข้าจากชีต RAW_JSON (สำรอง)', 'analyzeRawJson')
    .addSeparator()
    .addItem('เปิด Dashboard', 'showDashboard')
    .addItem('เปิด Sheet สถานี', 'activateStationSheet')
    .addItem('เปิด Import Log', 'activateLogSheet')
    .addToUi();
}

function setupSatFinderEnvironment() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureEnvironment_(ss);
  refreshSummarySheet_(ss);
  SpreadsheetApp.flush();
  notify_('SatFinder', 'เตรียม Sheet และ Environment เรียบร้อยแล้ว');
}

function analyzeRawJson() {
  return runStationImport_('RAW_JSON', (ss) => {
    return parseRawStations_(readRawJsonFromSheet_(ss));
  });
}

function runStationImport_(sourceLabel, recordsLoader) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another SatFinder import is running. Please try again in a moment.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  let batchId = '';
  let prefix = '';

  try {
    ensureEnvironment_(ss);
    const config = getConfig_(ss);
    const prefixFilter = getStationPrefixFilter_(config);
    prefix = prefixFilter.label;
    batchId = Utilities.formatDate(now, config.Timezone || SATFINDER.TIMEZONE, 'yyyyMMdd-HHmmss');
    const rawRecords = recordsLoader(ss, config);
    if (!Array.isArray(rawRecords)) {
      throw new Error('Station source did not return an array.');
    }

    let skippedNoName = 0;
    let stationsWithoutLocation = 0;
    const matched = [];

    rawRecords.forEach((record) => {
      const name = String(record && record.name ? record.name : '').trim();
      if (!name) {
        skippedNoName += 1;
        return;
      }
      if (!matchesStationPrefix_(name, prefixFilter)) {
        return;
      }

      const station = normalizeStation_(record, now, batchId, config);
      if (!station.hasLocation) {
        stationsWithoutLocation += 1;
      }
      matched.push(station);
    });

    const uniqueStations = dedupeStationsByKey_(matched);
    const upsertResult = upsertStations_(ss, uniqueStations, batchId);

    setConfigValue_(ss, 'LatestImportBatchId', batchId);
    setConfigValue_(ss, 'LastImportAt', now);
    writeImportLog_(ss, {
      importedAt: now,
      batchId,
      prefix,
      rawRecords: rawRecords.length,
      matchedStations: uniqueStations.length,
      inserted: upsertResult.inserted,
      updated: upsertResult.updated,
      skippedNoName,
      stationsWithoutLocation,
      message: 'OK: ' + sourceLabel,
    });
    refreshSummarySheet_(ss);

    const message = [
      'อัปเดตจาก ' + sourceLabel + ' เสร็จแล้ว',
      'พบ ' + uniqueStations.length + ' สถานีที่ขึ้นต้นด้วย ' + prefix,
      'เพิ่มใหม่ ' + upsertResult.inserted + ' / บันทึกทับ ' + upsertResult.updated,
    ].join('\n');
    notify_('SatFinder Import', message);
    return {
      batchId,
      rawRecords: rawRecords.length,
      matchedStations: uniqueStations.length,
      inserted: upsertResult.inserted,
      updated: upsertResult.updated,
      skippedNoName,
      stationsWithoutLocation,
      source: sourceLabel,
    };
  } catch (error) {
    writeImportLog_(ss, {
      importedAt: now,
      batchId,
      prefix,
      rawRecords: 0,
      matchedStations: 0,
      inserted: 0,
      updated: 0,
      skippedNoName: 0,
      stationsWithoutLocation: 0,
      message: 'ERROR (' + sourceLabel + '): ' + error.message,
    });
    notify_('SatFinder Import Error', error.message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function showDashboard() {
  const html = HtmlService
    .createHtmlOutputFromFile('Dashboard')
    .setTitle('SatFinder TinyGS World Monitor')
    .setWidth(1400)
    .setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, 'SatFinder TinyGS World Monitor');
}

function doGet(event) {
  const params = event && event.parameter ? event.parameter : {};
  if (params.format === 'json' || params.callback) {
    return createPublicDataResponse_(params);
  }

  return HtmlService
    .createHtmlOutputFromFile('Dashboard')
    .setTitle('SatFinder TinyGS World Monitor')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function createPublicDataResponse_(params) {
  const callback = String(params.callback || '').trim();
  const payload = {
    ok: true,
    schemaVersion: 1,
    data: buildPublicDashboardData_(),
  };
  const json = JSON.stringify(payload);

  if (!callback) {
    return ContentService
      .createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (!/^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(callback) || callback.length > 128) {
    return ContentService
      .createTextOutput('/* Invalid callback */')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(callback + '(' + json + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function buildPublicDashboardData_() {
  const data = getDashboardData();
  return {
    generatedAt: data.generatedAt,
    project: data.project,
    config: data.config,
    summary: data.summary,
    satelliteBreakdown: data.satelliteBreakdown,
    versionBreakdown: data.versionBreakdown,
    regionBreakdown: data.regionBreakdown,
    stations: data.stations.map((station) => ({
      stationKey: station.stationKey,
      name: station.name,
      isOnline: station.isOnline,
      monitorState: station.monitorState,
      monitorLabel: station.monitorLabel,
      lastSeen: station.lastSeen,
      minutesSinceSeen: station.minutesSinceSeen,
      confirmedPackets: station.confirmedPackets,
      telemetryPackets: station.telemetryPackets,
      satellite: station.satellite,
      satDisplayName: station.satDisplayName,
      version: station.version,
      latitude: station.latitude,
      longitude: station.longitude,
      hasLocation: station.hasLocation,
      region: station.region,
    })),
  };
}

function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureEnvironment_(ss);
  return buildDashboardData_(ss);
}

function activateStationSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, SATFINDER.STATION_SHEET);
  ss.setActiveSheet(sheet);
}

function activateLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, SATFINDER.LOG_SHEET);
  ss.setActiveSheet(sheet);
}

function ensureEnvironment_(ss) {
  const configSheet = getOrCreateSheet_(ss, SATFINDER.CONFIG_SHEET);
  setupConfigSheet_(configSheet);

  const rawSheet = getOrCreateSheet_(ss, SATFINDER.RAW_SHEET);
  setupRawSheet_(rawSheet);

  const stationSheet = getOrCreateSheet_(ss, SATFINDER.STATION_SHEET);
  ensureHeaders_(stationSheet, STATION_HEADERS);
  formatStationSheet_(stationSheet);

  const logSheet = getOrCreateSheet_(ss, SATFINDER.LOG_SHEET);
  ensureHeaders_(logSheet, LOG_HEADERS);
  formatLogSheet_(logSheet);

  getOrCreateSheet_(ss, SATFINDER.SUMMARY_SHEET);
}

function setupRawSheet_(sheet) {
  sheet.getRange('A1').setValue('Manual fallback only: paste TinyGS station JSON in A2:A. Normal updates fetch TinyGS directly into Google Sheet.');
  sheet.getRange('B1').setValue('Run menu: SatFinder > นำเข้าจากชีต RAW_JSON (สำรอง)');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 760);
  sheet.setColumnWidth(2, 360);
  sheet.getRange('A:A').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  sheet.getRange('A1:B1')
    .setFontWeight('bold')
    .setBackground('#17201c')
    .setFontColor('#f6fff9');
}

function setupConfigSheet_(sheet) {
  ensureHeaders_(sheet, ['Key', 'Value', 'Description']);

  const lastRow = sheet.getLastRow();
  const existing = {};
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach((row, index) => {
      const key = String(row[0] || '').trim();
      if (key) {
        existing[key] = index + 2;
      }
    });
  }

  CONFIG_ROWS.forEach((row) => {
    if (!existing[row[0]]) {
      sheet.appendRow(row);
    }
  });

  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 1, 220);
  sheet.setColumnWidths(2, 1, 520);
  sheet.setColumnWidths(3, 1, 520);
  sheet.getRange('A1:C1')
    .setFontWeight('bold')
    .setBackground('#17201c')
    .setFontColor('#f6fff9');
}

function ensureHeaders_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function formatStationSheet_(sheet) {
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  const stateColumn = STATION_HEADERS.indexOf('monitorState') + 1;
  const onlineColumn = STATION_HEADERS.indexOf('isOnline') + 1;
  const lastSeenColumn = STATION_HEADERS.indexOf('lastSeen') + 1;
  const lastPacketColumn = STATION_HEADERS.indexOf('lastPacketTime') + 1;
  const confirmedColumn = STATION_HEADERS.indexOf('confirmedPackets') + 1;
  const telemetryColumn = STATION_HEADERS.indexOf('telemetryPackets') + 1;
  const latitudeColumn = STATION_HEADERS.indexOf('latitude') + 1;
  const longitudeColumn = STATION_HEADERS.indexOf('longitude') + 1;
  const importColumn = STATION_HEADERS.indexOf('latestImportAt') + 1;
  const rawJsonColumn = STATION_HEADERS.indexOf('rawJson') + 1;

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(6, 150);
  sheet.setColumnWidths(7, 2, 165);
  sheet.setColumnWidths(10, 2, 140);
  sheet.setColumnWidth(12, 170);
  sheet.setColumnWidth(13, 170);
  sheet.setColumnWidths(16, 2, 110);
  sheet.getRange(1, 1, 1, STATION_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#17201c')
    .setFontColor('#f6fff9');
  sheet.getRange(2, lastSeenColumn, maxRows, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(2, confirmedColumn, maxRows, 2).setNumberFormat('#,##0');
  sheet.getRange(2, latitudeColumn, maxRows, 2).setNumberFormat('0.000000');
  sheet.getRange(2, importColumn, maxRows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  const stateRange = sheet.getRange(2, stateColumn, maxRows, 1);
  const rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('online')
      .setBackground('#dff7ea')
      .setFontColor('#0b6b3a')
      .setRanges([stateRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('recent')
      .setBackground('#fff4c2')
      .setFontColor('#6b5300')
      .setRanges([stateRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('followup')
      .setBackground('#ffe1dd')
      .setFontColor('#8a1f12')
      .setRanges([stateRange])
      .build(),
  ];
  sheet.setConditionalFormatRules(rules);

  const existingFilter = sheet.getFilter();
  if (existingFilter) {
    const filterRange = existingFilter.getRange();
    if (filterRange.getLastRow() < sheet.getMaxRows() || filterRange.getLastColumn() < STATION_HEADERS.length) {
      existingFilter.remove();
      sheet.getRange(1, 1, sheet.getMaxRows(), STATION_HEADERS.length).createFilter();
    }
  } else {
    sheet.getRange(1, 1, sheet.getMaxRows(), STATION_HEADERS.length).createFilter();
  }

  hideColumnQuietly_(sheet, 1);
  hideColumnQuietly_(sheet, rawJsonColumn);
  sheet.getRange(2, onlineColumn, maxRows, 1).insertCheckboxes();
}

function formatLogSheet_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, LOG_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#17201c')
    .setFontColor('#f6fff9');
  sheet.setColumnWidths(1, LOG_HEADERS.length, 145);
  sheet.setColumnWidth(10, 340);
  if (sheet.getMaxRows() > 1) {
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

function readRawJsonFromSheet_(ss) {
  const sheet = ss.getSheetByName(SATFINDER.RAW_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error('กรุณาวาง RAW JSON ในชีต RAW_JSON ตั้งแต่เซลล์ A2 ลงไป');
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  const text = values
    .map((row) => row[0])
    .filter((line) => String(line || '').trim() !== '')
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('ไม่พบ RAW JSON ใน RAW_JSON!A2:A');
  }
  return text;
}

function parseRawStations_(rawText) {
  const cleaned = cleanJsonText_(rawText);
  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch (firstError) {
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    } else {
      throw new Error('RAW JSON ไม่ถูกต้อง: ' + firstError.message);
    }
  }

  const stationArray = findStationArray_(parsed, 0);
  if (!stationArray) {
    throw new Error('ไม่พบ array ของ station ใน RAW JSON');
  }
  return stationArray;
}

function cleanJsonText_(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function findStationArray_(value, depth) {
  if (depth > 4 || value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'object') {
    return null;
  }

  const preferredKeys = ['stations', 'data', 'items', 'result', 'payload'];
  for (let i = 0; i < preferredKeys.length; i += 1) {
    const key = preferredKeys[i];
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findStationArray_(value[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const found = findStationArray_(value[keys[i]], depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizeStation_(record, importedAt, batchId, config) {
  const name = String(record.name || '').trim();
  const location = Array.isArray(record.location) ? record.location : [];
  const latitude = toNullableNumber_(location[0]);
  const longitude = toNullableNumber_(location[1]);
  const lastSeenMs = toEpochMs_(record.lastSeen);
  const lastPacketMs = toEpochMs_(record.lastPacketTime);
  const minutesSinceSeen = lastSeenMs
    ? Math.max(0, Math.round((importedAt.getTime() - lastSeenMs) / 60000))
    : '';
  const statusCode = toNumber_(record.status, 0);
  const isOnline = Number(statusCode) === 1;

  return {
    stationKey: normalizeKey_(name),
    name,
    userId: record.userId || '',
    statusCode,
    isOnline,
    monitorState: determineMonitorState_(isOnline, minutesSinceSeen, config),
    lastSeen: lastSeenMs ? new Date(lastSeenMs) : '',
    lastPacketTime: lastPacketMs ? new Date(lastPacketMs) : '',
    minutesSinceSeen,
    confirmedPackets: toNumber_(record.confirmedPackets, 0),
    telemetryPackets: toNumber_(record.telemetryPackets, 0),
    satellite: record.satellite || '',
    satDisplayName: record.satDisplayName || record.satellite || '',
    autoTune: record.autoTune === undefined || record.autoTune === null ? '' : record.autoTune,
    version: record.version || '',
    latitude: latitude === null ? '' : latitude,
    longitude: longitude === null ? '' : longitude,
    hasLocation: latitude !== null && longitude !== null,
    hasPictures: Boolean(record.hasPictures),
    isTest: Boolean(record.test),
    latestImportAt: importedAt,
    importBatchId: batchId,
    rawJson: JSON.stringify(record),
  };
}

function determineMonitorState_(isOnline, minutesSinceSeen, config) {
  if (isOnline) {
    return 'online';
  }
  const recentWindow = toNumber_(config.RecentWindowMinutes, 360);
  if (minutesSinceSeen !== '' && Number(minutesSinceSeen) <= recentWindow) {
    return 'recent';
  }
  return 'followup';
}

function dedupeStationsByKey_(stations) {
  const byKey = {};
  const order = [];
  stations.forEach((station) => {
    if (!byKey[station.stationKey]) {
      order.push(station.stationKey);
    }
    byKey[station.stationKey] = station;
  });
  return order.map((key) => byKey[key]);
}

function upsertStations_(ss, stations, batchId) {
  const sheet = ss.getSheetByName(SATFINDER.STATION_SHEET);
  ensureHeaders_(sheet, STATION_HEADERS);

  const existingByKey = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const existing = sheet.getRange(2, 1, lastRow - 1, STATION_HEADERS.length).getValues();
    existing.forEach((row, index) => {
      const key = String(row[0] || normalizeKey_(row[1])).trim();
      if (key) {
        existingByKey[key] = index + 2;
      }
    });
  }

  let inserted = 0;
  let updated = 0;
  const appendRows = [];

  stations.forEach((station) => {
    const row = stationToRow_(station);
    const rowNumber = existingByKey[station.stationKey];
    if (rowNumber) {
      sheet.getRange(rowNumber, 1, 1, STATION_HEADERS.length).setValues([row]);
      updated += 1;
    } else {
      appendRows.push(row);
      inserted += 1;
    }
  });

  if (appendRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appendRows.length, STATION_HEADERS.length).setValues(appendRows);
  }

  markMissingStationsForFollowUp_(sheet, batchId);
  sortStationSheet_(sheet);
  formatStationSheet_(sheet);
  return { inserted, updated };
}

function markMissingStationsForFollowUp_(sheet, batchId) {
  if (!batchId || sheet.getLastRow() <= 1) {
    return 0;
  }

  const statusColumn = STATION_HEADERS.indexOf('statusCode');
  const onlineColumn = STATION_HEADERS.indexOf('isOnline');
  const stateColumn = STATION_HEADERS.indexOf('monitorState');
  const importBatchColumn = STATION_HEADERS.indexOf('importBatchId');
  const nameColumn = STATION_HEADERS.indexOf('name');
  const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, STATION_HEADERS.length);
  const values = range.getValues();
  let changed = 0;

  values.forEach((row) => {
    const name = String(row[nameColumn] || '').trim();
    const rowBatchId = String(row[importBatchColumn] || '');
    if (name && rowBatchId !== batchId) {
      row[statusColumn] = 0;
      row[onlineColumn] = false;
      row[stateColumn] = 'followup';
      changed += 1;
    }
  });

  if (changed > 0) {
    range.setValues(values);
  }
  return changed;
}

function stationToRow_(station) {
  return [
    station.stationKey,
    station.name,
    station.userId,
    station.statusCode,
    station.isOnline,
    station.monitorState,
    station.lastSeen,
    station.lastPacketTime,
    station.minutesSinceSeen,
    station.confirmedPackets,
    station.telemetryPackets,
    station.satellite,
    station.satDisplayName,
    station.autoTune,
    station.version,
    station.latitude,
    station.longitude,
    station.hasPictures,
    station.isTest,
    station.latestImportAt,
    station.importBatchId,
    station.rawJson,
  ];
}

function sortStationSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 2) {
    return;
  }
  sheet.getRange(2, 1, lastRow - 1, STATION_HEADERS.length).sort([
    { column: STATION_HEADERS.indexOf('isOnline') + 1, ascending: false },
    { column: STATION_HEADERS.indexOf('confirmedPackets') + 1, ascending: false },
    { column: STATION_HEADERS.indexOf('telemetryPackets') + 1, ascending: false },
    { column: STATION_HEADERS.indexOf('name') + 1, ascending: true },
  ]);
}

function buildDashboardData_(ss) {
  const config = getConfig_(ss);
  const sheet = ss.getSheetByName(SATFINDER.STATION_SHEET);
  const latestBatchId = String(config.LatestImportBatchId || '');
  const stations = [];

  if (sheet && sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, STATION_HEADERS.length).getValues();
    values.forEach((row) => {
      if (String(row[1] || '').trim() === '') {
        return;
      }
      stations.push(rowToStationObject_(row, config, latestBatchId));
    });
  }

  stations.sort((a, b) => {
    if (a.isOnline !== b.isOnline) {
      return a.isOnline ? -1 : 1;
    }
    if (b.confirmedPackets !== a.confirmedPackets) {
      return b.confirmedPackets - a.confirmedPackets;
    }
    if (b.telemetryPackets !== a.telemetryPackets) {
      return b.telemetryPackets - a.telemetryPackets;
    }
    return a.name.localeCompare(b.name);
  });

  const summary = summarizeStations_(stations);
  const prefixFilter = getStationPrefixFilter_(config);
  return {
    generatedAt: new Date().toISOString(),
    project: {
      name: config.ProjectName || 'SatFinder',
      title: config.DashboardTitle || 'SatFinder TinyGS World Monitor',
      countryFocus: config.CountryFocus || 'Thailand',
      operatorName: config.OperatorName || '',
      partnerName: config.PartnerName || '',
    },
    config: {
      stationPrefix: prefixFilter.label,
      timezone: config.Timezone || SATFINDER.TIMEZONE,
      latestBatchId,
      lastImportAt: config.LastImportAt ? dateToIso_(config.LastImportAt) : '',
      recentWindowMinutes: toNumber_(config.RecentWindowMinutes, 360),
      followUpWindowMinutes: toNumber_(config.FollowUpWindowMinutes, 1440),
    },
    summary,
    stations,
    satelliteBreakdown: topCounts_(stations, 'satDisplayName', 8),
    versionBreakdown: topCounts_(stations, 'version', 8),
    regionBreakdown: topCounts_(stations, 'region', 8),
    autoTuneBreakdown: topCounts_(stations, 'autoTune', 8),
  };
}

function rowToStationObject_(row, config, latestBatchId) {
  const importedBatchId = String(row[20] || '');
  const inLatestImport = latestBatchId ? importedBatchId === latestBatchId : true;
  const rawOnline = asBoolean_(row[4]);
  const minutesSinceSeen = row[8] === '' ? null : Number(row[8]);
  const state = resolveDashboardState_(rawOnline, inLatestImport, minutesSinceSeen, config);
  const latitude = row[15] === '' ? null : Number(row[15]);
  const longitude = row[16] === '' ? null : Number(row[16]);
  const hasLocation = isFiniteNumber_(latitude) && isFiniteNumber_(longitude);

  return {
    stationKey: String(row[0] || ''),
    name: String(row[1] || ''),
    userId: row[2] === '' ? '' : String(row[2]),
    statusCode: toNumber_(row[3], 0),
    rawOnline,
    isOnline: rawOnline && inLatestImport,
    monitorState: state,
    monitorLabel: monitorLabel_(state),
    lastSeen: dateToIso_(row[6]),
    lastPacketTime: dateToIso_(row[7]),
    minutesSinceSeen,
    confirmedPackets: toNumber_(row[9], 0),
    telemetryPackets: toNumber_(row[10], 0),
    satellite: String(row[11] || ''),
    satDisplayName: String(row[12] || row[11] || ''),
    autoTune: row[13] === '' ? 'ไม่ระบุ' : String(row[13]),
    version: row[14] === '' ? 'ไม่ระบุ' : String(row[14]),
    latitude,
    longitude,
    hasLocation,
    hasPictures: asBoolean_(row[17]),
    isTest: asBoolean_(row[18]),
    latestImportAt: dateToIso_(row[19]),
    importBatchId: importedBatchId,
    inLatestImport,
    region: classifyThailandRegion_(latitude, longitude),
  };
}

function resolveDashboardState_(rawOnline, inLatestImport, minutesSinceSeen, config) {
  if (!inLatestImport) {
    return 'followup';
  }
  if (rawOnline) {
    return 'online';
  }
  const recentWindow = toNumber_(config.RecentWindowMinutes, 360);
  if (minutesSinceSeen !== null && minutesSinceSeen <= recentWindow) {
    return 'recent';
  }
  return 'followup';
}

function summarizeStations_(stations) {
  return stations.reduce((summary, station) => {
    summary.totalStations += 1;
    summary.latestStations += station.inLatestImport ? 1 : 0;
    summary.onlineStations += station.isOnline ? 1 : 0;
    summary.recentStations += station.monitorState === 'recent' ? 1 : 0;
    summary.followUpStations += station.monitorState === 'followup' ? 1 : 0;
    summary.notLatestStations += station.inLatestImport ? 0 : 1;
    summary.withLocation += station.hasLocation ? 1 : 0;
    summary.withoutLocation += station.hasLocation ? 0 : 1;
    summary.withPictures += station.hasPictures ? 1 : 0;
    summary.testStations += station.isTest ? 1 : 0;
    summary.confirmedPackets += station.confirmedPackets;
    summary.telemetryPackets += station.telemetryPackets;
    return summary;
  }, {
    totalStations: 0,
    latestStations: 0,
    onlineStations: 0,
    recentStations: 0,
    followUpStations: 0,
    notLatestStations: 0,
    withLocation: 0,
    withoutLocation: 0,
    withPictures: 0,
    testStations: 0,
    confirmedPackets: 0,
    telemetryPackets: 0,
  });
}

function topCounts_(stations, key, limit) {
  const counts = {};
  stations.forEach((station) => {
    const value = String(station[key] || 'ไม่ระบุ');
    counts[value] = (counts[value] || 0) + 1;
  });
  return Object.keys(counts)
    .map((name) => ({ name, count: counts[name] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function refreshSummarySheet_(ss) {
  const sheet = getOrCreateSheet_(ss, SATFINDER.SUMMARY_SHEET);
  const data = buildDashboardData_(ss);
  const rows = [
    ['Metric', 'Value'],
    ['Project', data.project.name],
    ['Dashboard title', data.project.title],
    ['Country focus', data.project.countryFocus],
    ['Station prefix', data.config.stationPrefix],
    ['Last import at', data.config.lastImportAt],
    ['Latest batch id', data.config.latestBatchId],
    ['Stations in table', data.summary.totalStations],
    ['Stations in latest import', data.summary.latestStations],
    ['Online in latest import', data.summary.onlineStations],
    ['Recently seen', data.summary.recentStations],
    ['Needs follow-up', data.summary.followUpStations],
    ['With location', data.summary.withLocation],
    ['Without location', data.summary.withoutLocation],
    ['Confirmed packets', data.summary.confirmedPackets],
    ['Telemetry packets', data.summary.telemetryPackets],
  ];

  sheet.clear();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1, 1, 2)
    .setFontWeight('bold')
    .setBackground('#17201c')
    .setFontColor('#f6fff9');
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 420);
  sheet.getRange(8, 2, 10, 1).setNumberFormat('#,##0');

  if (data.satelliteBreakdown.length > 0) {
    const startRow = rows.length + 3;
    sheet.getRange(startRow, 1, 1, 2).setValues([['Top satellites', 'Stations']]);
    sheet.getRange(startRow, 1, 1, 2)
      .setFontWeight('bold')
      .setBackground('#17201c')
      .setFontColor('#f6fff9');
    sheet.getRange(startRow + 1, 1, data.satelliteBreakdown.length, 2)
      .setValues(data.satelliteBreakdown.map((item) => [item.name, item.count]));
  }
}

function writeImportLog_(ss, entry) {
  const sheet = getOrCreateSheet_(ss, SATFINDER.LOG_SHEET);
  ensureHeaders_(sheet, LOG_HEADERS);
  sheet.appendRow([
    entry.importedAt || new Date(),
    entry.batchId || '',
    entry.prefix || '',
    entry.rawRecords || 0,
    entry.matchedStations || 0,
    entry.inserted || 0,
    entry.updated || 0,
    entry.skippedNoName || 0,
    entry.stationsWithoutLocation || 0,
    entry.message || '',
  ]);
  formatLogSheet_(sheet);
}

function getConfig_(ss) {
  const sheet = getOrCreateSheet_(ss, SATFINDER.CONFIG_SHEET);
  setupConfigSheet_(sheet);
  const values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 2).getValues();
  const config = { Timezone: SATFINDER.TIMEZONE };
  values.forEach((row) => {
    const key = String(row[0] || '').trim();
    if (key) {
      config[key] = row[1];
    }
  });
  return config;
}

function setConfigValue_(ss, key, value) {
  const sheet = getOrCreateSheet_(ss, SATFINDER.CONFIG_SHEET);
  setupConfigSheet_(sheet);
  const lastRow = sheet.getLastRow();
  const keys = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  for (let i = 0; i < keys.length; i += 1) {
    if (String(keys[i][0] || '').trim() === key) {
      sheet.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, 'Managed by the script.']);
}

function classifyThailandRegion_(latitude, longitude) {
  if (!isFiniteNumber_(latitude) || !isFiniteNumber_(longitude)) {
    return 'ไม่ระบุพิกัด';
  }
  if (latitude < 5 || latitude > 21 || longitude < 97 || longitude > 106) {
    return 'นอกพื้นที่ไทย';
  }
  if (latitude < 11.5) {
    return 'ภาคใต้';
  }
  if (longitude > 101.3 && latitude < 14.8) {
    return 'ภาคตะวันออก';
  }
  if (longitude > 101 && latitude >= 14.2) {
    return 'ภาคตะวันออกเฉียงเหนือ';
  }
  if (latitude >= 17) {
    return 'ภาคเหนือ';
  }
  if (longitude < 99.7 && latitude < 16) {
    return 'ภาคตะวันตก';
  }
  return 'ภาคกลาง';
}

function monitorLabel_(state) {
  const labels = {
    online: 'Online',
    recent: 'เพิ่งเห็นสัญญาณ',
    followup: 'รอติดตาม',
  };
  return labels[state] || state || 'ไม่ระบุ';
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function hideColumnQuietly_(sheet, column) {
  try {
    sheet.hideColumns(column);
  } catch (error) {
    // Hidden already or unsupported in the current context.
  }
}

function getStationPrefixFilter_(config) {
  const prefixes = parseStationPrefixes_(config);
  const typoTolerance = clampInteger_(
    config.StationPrefixTypoTolerance,
    SATFINDER.DEFAULT_PREFIX_TYPO_TOLERANCE,
    2
  );
  const normalizedPrefixes = prefixes
    .map((prefix) => normalizePrefixForMatch_(prefix))
    .filter((prefix) => prefix);

  return {
    prefixes,
    normalizedPrefixes,
    typoTolerance,
    label: prefixes.join(', ') + (typoTolerance > 0 ? ' (typo tolerance <= ' + typoTolerance + ')' : ''),
  };
}

function parseStationPrefixes_(config) {
  let prefixes = splitPrefixList_(config.StationPrefixes);
  if (prefixes.length === 0) {
    prefixes = splitPrefixList_(config.StationPrefix || SATFINDER.DEFAULT_PREFIX);
  }
  prefixes = uniquePrefixList_(prefixes);
  if (prefixes.length === 0) {
    prefixes = uniquePrefixList_(SATFINDER.DEFAULT_PREFIXES);
  }
  return prefixes;
}

function splitPrefixList_(value) {
  return String(value || '')
    .split(/[\n,;|]+/)
    .map((prefix) => String(prefix || '').trim())
    .filter((prefix) => prefix);
}

function uniquePrefixList_(prefixes) {
  const seen = {};
  const unique = [];
  prefixes.forEach((prefix) => {
    const key = normalizePrefixForMatch_(prefix);
    if (key && !seen[key]) {
      seen[key] = true;
      unique.push(prefix);
    }
  });
  return unique;
}

function matchesStationPrefix_(stationName, prefixFilter) {
  const normalizedName = normalizePrefixForMatch_(stationName);
  if (!normalizedName) {
    return false;
  }

  const prefixes = prefixFilter.normalizedPrefixes || [];
  const typoTolerance = toNumber_(prefixFilter.typoTolerance, 0);
  for (let i = 0; i < prefixes.length; i += 1) {
    const prefix = prefixes[i];
    if (normalizedName.indexOf(prefix) === 0) {
      return true;
    }
    if (typoTolerance > 0 && prefix.length >= 4 && fuzzyPrefixMatches_(normalizedName, prefix, typoTolerance)) {
      return true;
    }
  }
  return false;
}

function normalizePrefixForMatch_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fuzzyPrefixMatches_(normalizedName, normalizedPrefix, typoTolerance) {
  const minLength = Math.max(1, normalizedPrefix.length - typoTolerance);
  const maxLength = Math.min(normalizedName.length, normalizedPrefix.length + typoTolerance);
  for (let length = minLength; length <= maxLength; length += 1) {
    const candidate = normalizedName.slice(0, length);
    if (editDistance_(candidate, normalizedPrefix) <= typoTolerance) {
      return true;
    }
  }
  return false;
}

function editDistance_(left, right) {
  const matrix = [];
  for (let i = 0; i <= left.length; i += 1) {
    matrix[i] = [i];
  }
  for (let j = 1; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1;
      let distance = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost
      );

      if (
        i > 1 &&
        j > 1 &&
        left.charAt(i - 1) === right.charAt(j - 2) &&
        left.charAt(i - 2) === right.charAt(j - 1)
      ) {
        distance = Math.min(distance, matrix[i - 2][j - 2] + 1);
      }

      matrix[i][j] = distance;
    }
  }

  return matrix[left.length][right.length];
}

function clampInteger_(value, fallback, max) {
  const numeric = Math.round(toNumber_(value, fallback));
  return Math.max(0, Math.min(max, numeric));
}

function normalizeKey_(value) {
  return String(value || '').trim().toLowerCase();
}

function toEpochMs_(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value.getTime();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateToIso_(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  const ms = toEpochMs_(value);
  return ms ? new Date(ms).toISOString() : '';
}

function toNumber_(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableNumber_(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isFiniteNumber_(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function asBoolean_(value) {
  if (value === true || value === false) {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function notify_(title, message) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, title, 8);
  } catch (error) {
    Logger.log(title + ': ' + message);
  }
}
