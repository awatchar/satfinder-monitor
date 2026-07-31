import fs from 'node:fs/promises';
import path from 'node:path';
import { googleApiRequest, loadGoogleAuth, loadProjectConfig } from './lib/google-auth.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-');
}

function webAppUrl(deployment) {
  return deployment.entryPoints?.find((entry) => entry.entryPointType === 'WEB_APP')?.webApp?.url || '';
}

const command = process.argv[2] || 'list';
const config = await loadProjectConfig();
const auth = await loadGoogleAuth();
const projectUrl = `https://script.googleapis.com/v1/projects/${encodeURIComponent(config.scriptId)}`;

async function listDeployments() {
  const data = await googleApiRequest(auth, { url: `${projectUrl}/deployments` });
  return data.deployments || [];
}

if (command === 'list') {
  const deployments = await listDeployments();
  console.log(JSON.stringify(deployments.map((deployment) => ({
    deploymentId: deployment.deploymentId,
    versionNumber: deployment.deploymentConfig?.versionNumber,
    description: deployment.deploymentConfig?.description || '',
    updateTime: deployment.updateTime,
    webAppUrl: webAppUrl(deployment),
  })), null, 2));
} else if (command === 'publish') {
  if (!process.argv.includes('--yes')) {
    throw new Error('Publishing changes the live Apps Script deployment. Re-run with --yes after reviewing the source.');
  }

  const deployments = await listDeployments();
  const backupPath = path.resolve('.api-backups', `deployments-${timestamp()}.json`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, `${JSON.stringify(deployments, null, 2)}\n`, 'utf8');

  const description = option('--description') || `SatFinder data API ${new Date().toISOString()}`;
  const version = await googleApiRequest(auth, {
    url: `${projectUrl}/versions`,
    method: 'POST',
    data: { description },
  });

  const requestedDeploymentId = option('--deployment');
  const webDeployments = deployments.filter((deployment) =>
    deployment.deploymentId !== '@HEAD' && webAppUrl(deployment));
  let target;
  if (requestedDeploymentId) {
    target = deployments.find((deployment) => deployment.deploymentId === requestedDeploymentId);
    if (!target) throw new Error(`Deployment not found: ${requestedDeploymentId}`);
  } else if (webDeployments.length === 1) {
    target = webDeployments[0];
  } else if (webDeployments.length > 1) {
    throw new Error('Multiple web app deployments exist. Re-run with --deployment <deploymentId>.');
  }

  const deploymentConfig = {
    versionNumber: version.versionNumber,
    manifestFileName: 'appsscript',
    description,
  };
  const published = target
    ? await googleApiRequest(auth, {
      url: `${projectUrl}/deployments/${encodeURIComponent(target.deploymentId)}`,
      method: 'PUT',
      data: { deploymentConfig },
    })
    : await googleApiRequest(auth, {
      url: `${projectUrl}/deployments`,
      method: 'POST',
      data: { deploymentConfig },
    });

  console.log(JSON.stringify({
    backupPath,
    deploymentId: published.deploymentId,
    versionNumber: published.deploymentConfig?.versionNumber,
    webAppUrl: webAppUrl(published),
  }, null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
