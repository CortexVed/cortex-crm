# Deploy and Host Cortex CRM on Railway

Cortex CRM is a self-hosted AI CRM that adapts to the way your business works. It comes with contacts, companies, deals, tasks and dashboards, and when you need something more you just ask for it in plain language: "add a contracts module with renewal reminders", "when a deal is won, create an onboarding task". The AI engine plans the change, tests it in a sandbox and waits for your approval before anything goes live. Think of it as a self-hosted alternative to Salesforce or HubSpot that you reshape without writing code. The interface is in Spanish.

## About Hosting Cortex CRM

This template deploys the whole stack in one click, with nothing to fill in. Two Node.js 24 services are built from the same Docker image: `Cortex` serves the web app and the REST API, and `Worker` runs background jobs (the AI pipeline, scheduled automations and webhooks). PostgreSQL 18 is the only datastore; even the job queue lives in Postgres, so there is no Redis to manage. A small `CI` service, with no variables and no public domain, is used by the optional source-code engine to test code changes. Every organization is isolated with PostgreSQL Row-Level Security, services talk over Railway's private network, and both app services expose a health check at `/api/health`. Secrets are generated on each deploy with template functions, database migrations run on boot, and AI provider keys are stored encrypted with AES-256-GCM.

## Common Use Cases

- Agencies and consultancies running a separate, tailored CRM for each client on a single installation
- Small and mid-size businesses that need a CRM shaped to their process (contracts, inventory, quotes, projects) without hiring developers
- Sales teams that want a kanban pipeline, automations and dashboards they can change by asking
- Teams that want an AI assistant grounded in their own CRM data: plain-language questions, record summaries and document analysis
- Developers who want an AI CRM they can host, inspect and extend, with every change versioned and reversible

## Features

- **EVOLVE AI ENGINE:** describe a change and get a plan, sandbox test results, a risk score and an impact summary. Approving it publishes a new version, checks it automatically and keeps one-click rollback.
- **Custom modules and fields:** up to 2,000 modules per organization, with table, kanban and calendar views, relations, formulas and public forms.
- **Automations:** event-based and scheduled rules, outgoing webhooks, and sandboxed scripts (QuickJS compiled to WebAssembly) for custom logic.
- **AI assistant:** answers questions about your data, summarizes records and prepares changes that you confirm.
- **Channels:** WhatsApp Cloud API, Telegram and Slack.
- **Security:** roles and per-module permissions, audit log, API keys, encrypted secrets and a built-in security review.
- **Your look:** custom colors, density, navigation and pages, with light and dark themes.
- **Source-code engine (optional, platform admins):** the AI edits the app's own code, type-checks it, runs the test suite in the isolated CI service and deploys only after you confirm.

## Dependencies for Cortex CRM Hosting

- PostgreSQL (included in the template)
- An API key from at least one AI provider: Anthropic Claude, OpenAI, Google Gemini, DeepSeek, Mistral, Groq or OpenRouter. The core CRM works without one; the AI features use your own key, so you pay your provider directly.
- Optional: a Resend API key for email, and WhatsApp Cloud API, Telegram or Slack credentials for messaging

### Deployment Dependencies

- Project website: https://cortex-crm-web-production.up.railway.app
- Source code: https://github.com/carbollo/cortex-crm
- Railway PostgreSQL: https://docs.railway.com/databases/postgresql
- Resend (email): https://resend.com/docs

### Implementation Details

After the deploy finishes:

1. Open the public domain of the `Cortex` service and sign up. This creates your first organization.
2. In **Ajustes › Mi cuenta**, paste the `PLATFORM_ADMIN_SETUP_TOKEN` value from the `Cortex` service variables to become the platform administrator. The token works once.
3. Add an AI provider in **Ajustes › Proveedores de IA**.
4. Optional: set `RESEND_API_KEY` and `EMAIL_FROM` on `Cortex` for email, and `ALLOW_SIGNUP=false` to close public sign-ups.
5. Optional: to let the AI change the installation's source code, create a Railway project token for this environment and paste it in **Código fuente › Configuración** (platform administrators only). Then disconnect `Cortex`, `Worker` and `CI` from the template repository (service › Settings › Source), so that a push to the template does not overwrite your changes.

## Why Deploy Cortex CRM on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Cortex CRM on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
