# Deploy and Host Cortex CRM on Railway

Cortex CRM is a multi-tenant CRM that evolves in natural language. Each organization describes the change it needs ("add a contracts module with expiry reminders", "build a full inventory and invoicing system", "use dark green and group the menu by department") and EVOLVE AI ENGINE plans it, tests it in an isolated sandbox and applies it only after a human approves it, with versioning and one-click rollback. An organization can grow to as many as 2,000 modules, and large requests are planned in parts. The platform administrator can also have the AI change the installation's own source code, tested in an isolated CI service and deployed only after review. The interface is in Spanish.

## About Hosting Cortex CRM

Cortex CRM runs as two services built from the same Docker image plus PostgreSQL. `Cortex` serves the API and the web interface on a public domain. `Worker` runs the job queue: the EVOLVE pipeline, scheduled automations and outgoing webhooks. A fourth service, `CI`, has no variables and no domain and only runs a health check; the optional source-code engine uses it to build and test proposed code changes. All data lives in PostgreSQL over Railway's private network, with Row Level Security isolating every organization. The template generates the encryption key and an installation token on every deploy, and database migrations run automatically on boot, so a new installation needs no manual configuration. Bring your own AI provider keys (Anthropic, OpenAI, OpenRouter, DeepSeek, Gemini, Mistral or Groq); they are stored encrypted per organization.

## Common Use Cases

- Agencies and consultancies running a CRM per client, each one adapted in natural language
- Small and medium businesses that need contacts, companies, deals, tasks and dashboards they can extend without code
- Teams that want AI-assisted CRM changes with tests, approvals and rollback instead of direct edits

## Dependencies for Cortex CRM Hosting

- PostgreSQL (included in the template)
- An API key from at least one AI provider for EVOLVE and the assistant (optional for the core CRM)
- A Resend API key for transactional email (optional)

### Deployment Dependencies

- Railway PostgreSQL: https://docs.railway.com/databases/postgresql
- Resend (email): https://resend.com/docs

### Implementation Details

After the deploy finishes:

1. Open the public domain of the `Cortex` service and sign up. This creates your organization.
2. In **Ajustes › Mi cuenta**, paste the `PLATFORM_ADMIN_SETUP_TOKEN` value from the `Cortex` service variables to become the platform administrator. The token works once.
3. Add an AI provider in **Ajustes › Proveedores de IA**.
4. Optional: set `RESEND_API_KEY` and `EMAIL_FROM` on `Cortex` for email, and `ALLOW_SIGNUP=false` to disable public sign-ups.
5. Optional: to let the AI change the installation's source code, create a Railway project token for this environment and paste it in **Código fuente › Configuración** (platform administrators only). Then disconnect `Cortex`, `Worker` and `CI` from the template repository (service › Settings › Source), so that a push to the template does not overwrite your changes.

## Why Deploy Cortex CRM on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Cortex CRM on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
