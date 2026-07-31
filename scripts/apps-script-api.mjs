import fs from 'node:fs/promises';
import path from 'node:path';
import { googleApiRequest, loadGoogleAuth, loadProjectConfig } from './lib/google-auth.mjs';

const extensionByType = {
  SERVER_JS: '.gs',
  HTML: '.html',
  JSON: '.json',
};

const typeByExtension = {
  '.gs': 'SERVER_JS',
  '.html': 'HTML',
  '.json': 'JSON',
};

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-');
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function apiNameToLocalPath(sourceDir, file) {
  const extension = extensionByType[file.type];
  if (!extension) throw new Error(`Unsupported Apps Script file type: ${file.type}`);
  return path.join(sourceDir, ...file.name.split('/')) + extension;
}

async function localFilesToApi(sourceDir) {
  const paths = await walk(sourceDir);
  const files = [];
  for (const filePath of paths) {
    const extension = path.extname(filePath).toLowerCase();
    const type = typeByExtension[extension];
    if (!type) continue;
    const relative = path.relative(sourceDir, filePath).replaceAll('\\', '/');
    files.push({
      name: relative.slice(0, -extension.length),
      type,
      source: await fs.readFile(filePath, 'utf8'),
    });
  }
  if (!files.some((file) => file.name === 'appsscript' && file.type === 'JSON')) {
    throw new Error('apps-script/appsscript.json is required before pushing.');
  }
  return files;
}

const command = process.argv[2] || 'pull';
const config = await loadProjectConfig();
const sourceDir = path.resolve(config.appsScriptSourceDir);
const auth = await loadGoogleAuth();
const contentUrl = `https://script.googleapis.com/v1/projects/${encodeURIComponent(config.scriptId)}/content`;

if (command === 'pull') {
  const remote = await googleApiRequest(auth, { url: contentUrl });
  await fs.mkdir(sourceDir, { recursive: true });
  for (const file of remote.files || []) {
    const outputPath = apiNameToLocalPath(sourceDir, file);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const source = file.type === 'JSON'
      ? `${JSON.stringify(JSON.parse(file.source), null, 2)}\n`
      : file.source;
    await fs.writeFile(outputPath, source, 'utf8');
  }
  console.log(`Pulled ${(remote.files || []).length} files into ${sourceDir}`);
} else if (command === 'push') {
  if (!process.argv.includes('--yes')) {
    throw new Error('Apps Script push replaces the complete remote project. Re-run with --yes after reviewing git diff.');
  }

  const remote = await googleApiRequest(auth, { url: contentUrl });
  const backupPath = path.resolve('.api-backups', `apps-script-${timestamp()}.json`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, `${JSON.stringify(remote, null, 2)}\n`, 'utf8');

  const files = await localFilesToApi(sourceDir);
  const response = await googleApiRequest(auth, {
    url: contentUrl,
    method: 'PUT',
    data: { files },
  });
  console.log(JSON.stringify({ backupPath, uploadedFiles: response.files?.length || files.length }, null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
