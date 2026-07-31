import fs from 'node:fs/promises';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';

const projectConfigPath = path.resolve('project.config.json');

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
];

export async function loadProjectConfig() {
  return JSON.parse(await fs.readFile(projectConfigPath, 'utf8'));
}

export async function loadOAuthClientDefinition() {
  const config = await loadProjectConfig();
  const credentialsPath = path.resolve(config.oauthCredentialsPath);
  const credentials = process.env.GOOGLE_OAUTH_CLIENT_JSON
    ? JSON.parse(process.env.GOOGLE_OAUTH_CLIENT_JSON)
    : JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  const client = credentials.installed || credentials.web;

  if (!client?.client_id || !client?.client_secret) {
    throw new Error(`OAuth desktop credentials are invalid: ${credentialsPath}`);
  }
  return { client, credentialsPath, tokenPath: path.resolve(config.oauthTokenPath) };
}

export async function loadGoogleAuth() {
  const config = await loadProjectConfig();
  const tokenPath = path.resolve(config.oauthTokenPath);
  let token;

  if (process.env.GOOGLE_AUTHORIZED_USER_JSON) {
    token = JSON.parse(process.env.GOOGLE_AUTHORIZED_USER_JSON);
  } else {
    try {
      token = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Google OAuth token not found at ${tokenPath}. Run npm run google:auth first.`);
      }
      throw error;
    }
  }

  if (!token.refresh_token) {
    throw new Error('The saved Google OAuth token has no refresh_token. Run npm run google:auth again.');
  }
  const fallbackClient = token.client_id && token.client_secret
    ? token
    : (await loadOAuthClientDefinition()).client;
  const auth = new OAuth2Client(fallbackClient.client_id, fallbackClient.client_secret);
  auth.setCredentials({ refresh_token: token.refresh_token });
  return auth;
}

export async function saveAuthorizedUserToken(authClient, client, tokenPath) {
  const refreshToken = authClient.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error('Google did not return a refresh token. Revoke the old grant and authenticate again.');
  }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(
    tokenPath,
    `${JSON.stringify({
      type: 'authorized_user',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refreshToken,
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function googleApiRequest(auth, options) {
  const response = await auth.request(options);
  return response.data;
}
