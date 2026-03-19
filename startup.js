// Startup entry point.
// If AWS_SECRETS_ARN is set, fetches the secret from Secrets Manager and
// merges its keys into process.env before starting the app.
// Falls back to dotenv for local development.

async function loadSecrets() {
  const arn = process.env.AWS_SECRETS_ARN;
  if (!arn) {
    // Local dev: load from .env file
    require('dotenv').config();
    return;
  }

  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});

  console.log(`[startup] fetching secrets from ${arn}`);
  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secrets = JSON.parse(response.SecretString);

  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
  }
  console.log(`[startup] loaded ${Object.keys(secrets).length} secret(s)`);
}

loadSecrets()
  .then(() => require('./server'))
  .catch(err => {
    console.error('[startup] failed to load secrets:', err);
    process.exit(1);
  });
