# Template listing: card and variable descriptions

Texts for the Railway marketplace listing of the Cortex CRM template (code `cortex-crm`, https://railway.com/deploy/cortex-crm). The overview is
[template-overview.md](template-overview.md).

- **Description (marketplace card, 25–75 characters):** Open-source, self-hosted AI CRM that builds the modules you ask for
- **Category:** AI/ML
- **Suggested name (template editor only, not settable by API):** Cortex CRM | Open-Source AI CRM, Salesforce Alternative
- **Service icons (template editor only):** the same icon URL on `Cortex`, `Worker` and `CI`
- **Icon:** https://cdn.jsdelivr.net/gh/CortexVed/cortex-crm@7be490e07a5b0627ff3906ebbebcc4b5057e2acf/web/public/favicon.svg

Railway's public API has no operation to edit variable descriptions: they are set in the template editor
(service › Variables › each variable › Description). Every variable below already has an automatic value, so whoever
deploys the template does not need to type anything.

## Cortex

| Variable | Description |
|---|---|
| `APP_ENCRYPTION_KEY` | Generated automatically. Encrypts the stored AI keys, tokens and webhook secrets. Never change it after the first deploy, or those secrets become unreadable. |
| `DATABASE_URL` | Filled in automatically from the Postgres service. Private connection string Cortex uses for the database. |
| `PLATFORM_ADMIN_SETUP_TOKEN` | Generated automatically. One-time token: after signing up, paste it in Settings › My account to become the platform administrator. |
| `S3_ENDPOINT` | Filled in automatically from the Bucket. S3 endpoint where file attachments are stored. |
| `S3_BUCKET` | Filled in automatically from the Bucket. Name of the private bucket for file attachments. |
| `S3_ACCESS_KEY_ID` | Filled in automatically from the Bucket. Access key Cortex uses to store and read files. |
| `S3_SECRET_ACCESS_KEY` | Filled in automatically from the Bucket. Secret key of the bucket; never shown in the app. |
| `S3_REGION` | Filled in automatically from the Bucket ("auto" on Railway). |

## Worker

| Variable | Description |
|---|---|
| `APP_ENCRYPTION_KEY` | Filled in automatically from Cortex. Must stay identical on both services so the worker can read the stored secrets. |
| `APP_URL` | Filled in automatically from Cortex's public domain. Used for links in emails and to check Cortex's health after a code deploy. |
| `CI_SERVICE_ID` | Filled in automatically. ID of the CI service, where the source-code engine builds and tests proposed code changes. |
| `CORTEX_SERVICE_ID` | Filled in automatically. ID of the Cortex service, which the source-code engine updates after a code change is approved. |
| `DATABASE_URL` | Filled in automatically from the Postgres service. Private connection string the worker uses for the database. |
| `S3_ENDPOINT` | Filled in automatically from the Bucket. Same bucket as Cortex: the worker deletes purged files from it. |
| `S3_BUCKET` | Filled in automatically from the Bucket. Name of the private bucket for file attachments. |
| `S3_ACCESS_KEY_ID` | Filled in automatically from the Bucket. Access key the worker uses to delete purged files. |
| `S3_SECRET_ACCESS_KEY` | Filled in automatically from the Bucket. Secret key of the bucket; never shown in the app. |
| `S3_REGION` | Filled in automatically from the Bucket ("auto" on Railway). |

## Postgres

| Variable | Description |
|---|---|
| `DATABASE_URL` | Built automatically from the variables below. Private connection string that Cortex and Worker reference. |
| `PGDATA` | Data directory inside the attached volume. Keep the default. |
| `PGDATABASE` | Database name, same as POSTGRES_DB. |
| `PGHOST` | Private hostname of this service on Railway's network. |
| `PGPASSWORD` | Database password, same as POSTGRES_PASSWORD. |
| `PGPORT` | Port Postgres listens on (5432). |
| `PGUSER` | Database user, same as POSTGRES_USER. |
| `POSTGRES_DB` | Database created on first boot. Uses the generated user name. |
| `POSTGRES_PASSWORD` | Generated automatically: random 32-character password. |
| `POSTGRES_USER` | Generated automatically: random 12-letter user name. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Seconds Railway waits for Postgres to shut down cleanly on a redeploy (60). |
| `SSL_CERT_DAYS` | Validity, in days, of the self-signed TLS certificate Postgres generates (820). |
