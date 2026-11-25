/**
 * Cliente mínimo de Railway para el motor de código fuente.
 *
 * - Subida de código (el mismo protocolo que `railway up` en la CLI oficial):
 *   `POST https://backboard.railway.com/project/{projectId}/environment/{environmentId}/up?serviceId={serviceId}&message=…`
 *   con `Content-Type: application/gzip`, el tar comprimido como cuerpo y la cabecera `Project-Access-Token`.
 *   200 → `{deploymentId, url, logsUrl, deploymentDomain}`; 400 → `{message}`; 413 → demasiado grande.
 * - Estado, logs, rollback y retirada de despliegues con la API GraphQL pública
 *   (`https://backboard.railway.com/graphql/v2`).
 *
 * Solo se admiten tokens de PROYECTO (limitados a un proyecto y un entorno, y a acciones de despliegue). El
 * token nunca aparece en errores ni registros.
 */

export const RAILWAY_BACKBOARD = 'https://backboard.railway.com';
export const RAILWAY_GRAPHQL_URL = `${RAILWAY_BACKBOARD}/graphql/v2`;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRailwayId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

export type RailwayErrorCode = 'auth' | 'invalid' | 'too_large' | 'unavailable';

export class RailwayError extends Error {
  constructor(
    readonly code: RailwayErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RailwayError';
  }
}

export interface ServiceTarget {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

export interface UploadResult {
  deploymentId: string;
  url: string | null;
  logsUrl: string | null;
  deploymentDomain: string | null;
}

export interface DeploymentInfo {
  id: string;
  status: string;
  createdAt: string | null;
}

export type DeploymentOutcome = 'pending' | 'success' | 'failed' | 'removed';

/** Clasifica el estado de un despliegue de Railway. */
export function deploymentOutcome(status: string): DeploymentOutcome {
  switch (status) {
    case 'SUCCESS':
    case 'SLEEPING':
      return 'success';
    case 'FAILED':
    case 'CRASHED':
      return 'failed';
    case 'REMOVED':
    case 'REMOVING':
    case 'SKIPPED':
      return 'removed';
    default:
      return 'pending'; // INITIALIZING, QUEUED, WAITING, BUILDING, DEPLOYING, NEEDS_APPROVAL…
  }
}

const clip = (s: unknown, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export interface RailwayClientOptions {
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  signal?: AbortSignal;
}

export class RailwayClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly opts: RailwayClientOptions = {},
  ) {}

  private signal(ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return this.opts.signal ? AbortSignal.any([timeout, this.opts.signal]) : timeout;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(RAILWAY_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Project-Access-Token': this.token },
        body: JSON.stringify({ query, variables }),
        signal: this.signal(this.opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new RailwayError('unavailable', `No se pudo conectar con Railway: ${clip((e as Error).message, 160)}`);
    }
    const text = await res.text().catch(() => '');
    let body: { data?: T; errors?: { message?: string }[] } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status === 401 || res.status === 403) throw new RailwayError('auth', 'Railway ha rechazado el token (no es válido, se ha revocado o no tiene permisos)', res.status);
    if (body?.errors?.length) {
      const msg = clip(body.errors[0]?.message ?? 'error desconocido');
      const auth = /not authorized|unauthori[sz]ed|forbidden|invalid token|permission|authenticat/i.test(msg);
      throw new RailwayError(auth ? 'auth' : 'invalid', `Railway: ${msg}`, res.status);
    }
    if (!res.ok) throw new RailwayError(res.status >= 500 || res.status === 429 ? 'unavailable' : 'invalid', `Railway respondió ${res.status}`, res.status);
    if (!body?.data) throw new RailwayError('unavailable', 'Respuesta de Railway no válida');
    return body.data;
  }

  /** Proyecto y entorno del token (solo existe para tokens de proyecto). */
  async projectToken(): Promise<{ projectId: string; environmentId: string }> {
    const d = await this.graphql<{ projectToken: { projectId: string; environmentId: string } }>('query projectToken { projectToken { projectId environmentId } }');
    if (!d.projectToken?.projectId || !d.projectToken?.environmentId) throw new RailwayError('invalid', 'El token no es un token de proyecto de Railway');
    return { projectId: d.projectToken.projectId, environmentId: d.projectToken.environmentId };
  }

  /** Sube el código (tar.gz) a un servicio: crea un despliegue nuevo que Railway construye y publica. */
  async upload(target: ServiceTarget, archive: Buffer, message: string): Promise<UploadResult> {
    for (const [k, v] of Object.entries(target)) if (!isRailwayId(v)) throw new RailwayError('invalid', `Identificador de Railway no válido (${k})`);
    const url = `${RAILWAY_BACKBOARD}/project/${target.projectId}/environment/${target.environmentId}/up?serviceId=${target.serviceId}&message=${encodeURIComponent(message.slice(0, 200))}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', 'Project-Access-Token': this.token },
        body: new Uint8Array(archive),
        signal: this.signal(this.opts.uploadTimeoutMs ?? 180_000),
      });
    } catch (e) {
      throw new RailwayError('unavailable', `No se pudo subir el código a Railway: ${clip((e as Error).message, 160)}`);
    }
    const text = await res.text().catch(() => '');
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status === 413) throw new RailwayError('too_large', 'El código comprimido supera el tamaño máximo que acepta Railway', 413);
    if (res.status === 401 || res.status === 403) throw new RailwayError('auth', 'Railway ha rechazado el token al subir el código', res.status);
    if (res.status === 400) throw new RailwayError('invalid', `Railway ha rechazado la subida: ${clip(body?.message ?? text) || 'petición no válida'}`, 400);
    if (!res.ok) throw new RailwayError(res.status >= 500 || res.status === 429 ? 'unavailable' : 'invalid', `Railway respondió ${res.status} a la subida`, res.status);
    const deploymentId = typeof body?.deploymentId === 'string' ? body.deploymentId : null;
    if (!deploymentId) throw new RailwayError('invalid', 'Railway no ha devuelto el identificador del despliegue');
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return { deploymentId, url: str(body?.url), logsUrl: str(body?.logsUrl), deploymentDomain: str(body?.deploymentDomain) };
  }

  async deployment(id: string): Promise<DeploymentInfo> {
    const d = await this.graphql<{ deployment: DeploymentInfo }>('query deployment($id: String!) { deployment(id: $id) { id status createdAt } }', { id });
    return { id: d.deployment.id, status: String(d.deployment.status), createdAt: d.deployment.createdAt ?? null };
  }

  async buildLogs(id: string, limit = 5000): Promise<string[]> {
    const d = await this.graphql<{ buildLogs: { message: string }[] }>('query buildLogs($id: String!, $limit: Int) { buildLogs(deploymentId: $id, limit: $limit) { message timestamp severity } }', { id, limit });
    return (d.buildLogs ?? []).map((l) => String(l.message ?? ''));
  }

  async deploymentLogs(id: string, limit = 500): Promise<string[]> {
    const d = await this.graphql<{ deploymentLogs: { message: string }[] }>('query deploymentLogs($id: String!, $limit: Int) { deploymentLogs(deploymentId: $id, limit: $limit) { message timestamp severity } }', { id, limit });
    return (d.deploymentLogs ?? []).map((l) => String(l.message ?? ''));
  }

  /** Despliegue activo de un servicio: el más reciente con estado SUCCESS (o SLEEPING). */
  async activeDeployment(target: ServiceTarget): Promise<DeploymentInfo | null> {
    const d = await this.graphql<{ deployments: { edges: { node: DeploymentInfo }[] } }>(
      'query deployments($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { id status createdAt } } } }',
      { input: { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId, status: { in: ['SUCCESS', 'SLEEPING'] } } },
    );
    const nodes = (d.deployments?.edges ?? []).map((e) => e.node).filter((n) => n && deploymentOutcome(String(n.status)) === 'success');
    nodes.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return nodes[0] ? { id: nodes[0].id, status: String(nodes[0].status), createdAt: nodes[0].createdAt ?? null } : null;
  }

  /** Vuelve a publicar un despliegue anterior (Railway crea un despliegue nuevo con su imagen). */
  /**
   * Repositorio de GitHub conectado a un servicio (`repo: null` si se despliega por subida). Si el token no
   * puede consultarlo, `checked: false`: quien llama decide cómo avisar.
   */
  async connectedRepo(target: ServiceTarget): Promise<{ repo: string | null; checked: boolean }> {
    try {
      const d = await this.graphql<{ serviceInstance: { source: { repo: string | null } | null } | null }>(
        'query serviceInstance($s: String!, $e: String!) { serviceInstance(serviceId: $s, environmentId: $e) { source { repo } } }',
        { s: target.serviceId, e: target.environmentId },
      );
      return { repo: d.serviceInstance?.source?.repo ?? null, checked: true };
    } catch (e) {
      if (e instanceof RailwayError && (e.code === 'auth' || e.code === 'invalid')) return { repo: null, checked: false };
      throw e;
    }
  }

  async rollback(deploymentId: string): Promise<boolean> {
    const d = await this.graphql<{ deploymentRollback: boolean }>('mutation deploymentRollback($id: String!) { deploymentRollback(id: $id) }', { id: deploymentId });
    return !!d.deploymentRollback;
  }

  async remove(deploymentId: string): Promise<boolean> {
    const d = await this.graphql<{ deploymentRemove: boolean }>('mutation deploymentRemove($id: String!) { deploymentRemove(id: $id) }', { id: deploymentId });
    return !!d.deploymentRemove;
  }

  async cancel(deploymentId: string): Promise<boolean> {
    const d = await this.graphql<{ deploymentCancel: boolean }>('mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }', { id: deploymentId });
    return !!d.deploymentCancel;
  }
}
