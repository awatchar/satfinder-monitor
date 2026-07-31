import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_SCOPES,
  loadOAuthClientDefinition,
  saveAuthorizedUserToken,
} from './lib/google-auth.mjs';

const { client, credentialsPath, tokenPath } = await loadOAuthClientDefinition();
const state = crypto.randomBytes(24).toString('hex');

const result = await new Promise((resolve, reject) => {
  const server = http.createServer();
  server.on('error', reject);
  server.on('request', async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      if (requestUrl.pathname !== '/oauth2callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (requestUrl.searchParams.get('state') !== state) {
        throw new Error('OAuth state mismatch.');
      }
      const authorizationError = requestUrl.searchParams.get('error');
      if (authorizationError) throw new Error(`Google authorization failed: ${authorizationError}`);
      const code = requestUrl.searchParams.get('code');
      if (!code) throw new Error('Google authorization did not return a code.');

      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        Connection: 'close',
      });
      response.end('<h1>SatFinder authorization complete</h1><p>You may close this tab.</p>');
      resolve({ code, server });
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.message);
      reject(error);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const authClient = new OAuth2Client(client.client_id, client.client_secret, redirectUri);
    const authorizationUrl = authClient.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
      state,
    });

    console.log(`Opening Google authorization for ${credentialsPath}`);
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', authorizationUrl], (error) => {
      if (error) console.log(`Open this URL manually:\n${authorizationUrl}`);
    });
  });
});

const address = result.server.address();
const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
const authClient = new OAuth2Client(client.client_id, client.client_secret, redirectUri);
const { tokens } = await authClient.getToken(result.code);
authClient.setCredentials(tokens);
await saveAuthorizedUserToken(authClient, client, tokenPath);
await new Promise((resolve) => {
  result.server.close(resolve);
  result.server.closeAllConnections?.();
});
console.log(`Google OAuth token saved outside Git tracking: ${tokenPath}`);
