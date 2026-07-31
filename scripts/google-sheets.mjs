import fs from 'node:fs/promises';
import path from 'node:path';
import { googleApiRequest, loadGoogleAuth, loadProjectConfig } from './lib/google-auth.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireConfirmation() {
  if (!process.argv.includes('--yes')) {
    throw new Error('Writing requires --yes after reviewing the target range and values.');
  }
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-');
}

const command = process.argv[2] || 'info';
const config = await loadProjectConfig();
const auth = await loadGoogleAuth();
const spreadsheetBaseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}`;

if (command === 'info') {
  const data = await googleApiRequest(auth, {
    url: spreadsheetBaseUrl,
    params: {
      includeGridData: false,
      fields: 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
    },
  });
  console.log(JSON.stringify(data, null, 2));
} else if (command === 'read') {
  const range = option('--range') || config.defaultReadRange;
  const data = await googleApiRequest(auth, {
    url: `${spreadsheetBaseUrl}/values/${encodeURIComponent(range)}`,
  });
  console.log(JSON.stringify({ range: data.range, values: data.values || [] }, null, 2));
} else if (command === 'write') {
  const range = option('--range');
  const valuesJson = option('--values');
  const singleValue = option('--value');
  if (!range || (!valuesJson && singleValue === undefined)) {
    throw new Error('Usage: npm run sheet:write -- --range "Sheet1!A1" --value "text" --yes, or use --values with a JSON row array.');
  }
  requireConfirmation();

  const values = valuesJson ? JSON.parse(valuesJson) : [[singleValue]];
  if (!Array.isArray(values) || values.some((row) => !Array.isArray(row))) {
    throw new Error('--values must be a JSON array of row arrays.');
  }

  const before = await googleApiRequest(auth, {
    url: `${spreadsheetBaseUrl}/values/${encodeURIComponent(range)}`,
  });
  const backupPath = path.resolve('.api-backups', `sheet-${timestamp()}.json`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  const update = await googleApiRequest(auth, {
    url: `${spreadsheetBaseUrl}/values/${encodeURIComponent(range)}`,
    method: 'PUT',
    params: { valueInputOption: option('--input') || 'USER_ENTERED' },
    data: { values },
  });
  console.log(JSON.stringify({ backupPath, update }, null, 2));
} else if (command === 'clear') {
  const range = option('--range');
  if (!range) {
    throw new Error('Usage: node scripts/google-sheets.mjs clear --range "Sheet1!A1:C3" --yes');
  }
  requireConfirmation();

  const before = await googleApiRequest(auth, {
    url: `${spreadsheetBaseUrl}/values/${encodeURIComponent(range)}`,
  });
  const backupPath = path.resolve('.api-backups', `sheet-${timestamp()}.json`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  const update = await googleApiRequest(auth, {
    url: `${spreadsheetBaseUrl}/values/${encodeURIComponent(range)}:clear`,
    method: 'POST',
    data: {},
  });
  console.log(JSON.stringify({ backupPath, update }, null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
