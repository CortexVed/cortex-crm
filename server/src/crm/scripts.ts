import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { activeModules, findModule, NotifyTargetSchema } from '../../../shared/blueprint';
import type { RecordService } from './record-service';
import type { StoredRecord } from './store';

/**
 * SCRIPTS POR ORGANIZACIÓN.
 *
 * Cuando una organización necesita lógica que no cabe en la configuración declarativa, EVOLVE AI
 * ENGINE genera un script que forma parte del blueprint de ESA organización (versionado, probado,
 * aprobado y reversible). El código se ejecuta aquí, dentro de la plataforma (Railway), en un
 * sandbox QuickJS compilado a WebAssembly:
 *   - sin red, sin sistema de archivos, sin acceso a variables de entorno ni al proceso Node;
 *   - con límite de memoria, de pila y de tiempo (interrupción por plazo);
 *   - como función PURA: recibe datos de la propia organización y devuelve intenciones
 *     (actualizar, crear, avisar) que la plataforma valida y aplica con sus reglas habituales.
 * El vm de Node NO se usa: no es una barrera de seguridad.
 *
 * El sandbox NO corre en el hilo principal de Node, sino en un pool pequeño de hilos
 * (worker_threads), cada uno con su propio módulo QuickJS:
 *   - Algunos built-ins de QuickJS recorren `length` en C sin consultar la interrupción
 *     (p. ej. `Array.prototype.indexOf.call({ length: 2 ** 53 - 1 }, 1)`): en el hilo principal
 *     bloquearían el proceso entero (todas las organizaciones). Por eso el hilo principal solo envía
 *     el trabajo y espera con un plazo DURO (timeoutMs + margen); si vence, termina el hilo y lo
 *     sustituye por otro nuevo. El bucle de eventos sigue atendiendo peticiones mientras tanto.
 *   - Cualquier fallo del propio motor (abort/aserción de WebAssembly, trap, pila nativa agotada,
 *     límites del hilo) descarta ese hilo: un módulo en estado dudoso nunca ejecuta otro script.
 */

export const SCRIPT_LIMITS = {
  // Límite de QuickJS. En esta compilación para WebAssembly solo frena cada asignación por separado
  // (medido: 10 bloques de 10 MB pasan; en Emscripten QuickJS no conoce el tamaño real de cada bloque y
  // el total no se acumula): el tope real del total es la memoria WebAssembly del hilo
  // (SCRIPT_POOL.wasmMemoryMaxBytes).
  memoryBytes: 16 * 1024 * 1024,
  // Pila de QuickJS (mide la pila C de WebAssembly, de 5 MB). Con 448–512 KB, en el hilo principal
  // (≈1 MB de pila nativa de V8) la pila NATIVA se agotaba antes de que QuickJS detectase nada: la
  // excepción de V8 cruzaba el código C sin limpiarlo y el módulo compartido quedaba roto
  // (`list_empty(&rt->gc_obj_list)`). Con 192 KB (≈1100 niveles de recursión) y la pila del hilo de
  // SCRIPT_POOL.threadStackMb, QuickJS corta antes en todos los patrones medidos (recursión,
  // getters, Proxy, toJSON, JSON, RegExp, analizador sintáctico...).
  stackBytes: 192 * 1024,
  maxCodeChars: 20_000,
  maxInputChars: 512_000,
  maxOutputChars: 64_000,
  defaultTimeoutMs: 1000,
  maxTimeoutMs: 3000,
  relatedPerModule: 50,
} as const;

/** Pool de hilos del sandbox. */
export const SCRIPT_POOL = {
  /** Hilos simultáneos (cada uno ejecuta un script a la vez). */
  workers: 2,
  /** Ejecuciones en espera cuando todos los hilos están ocupados; más allá se rechazan. */
  maxQueued: 100,
  /** Margen del plazo duro sobre timeoutMs (la interrupción de QuickJS suele cortar antes). */
  deadlineMarginMs: 250,
  /** Tiempo máximo para que un hilo nuevo cargue QuickJS. */
  startTimeoutMs: 10_000,
  /**
   * Pila nativa del hilo. El analizador sintáctico de QuickJS gasta ~20 veces más pila nativa
   * (marcos de WebAssembly) que pila de QuickJS: con 192 KB, el peor anidamiento medido
   * (`eval('('.repeat(n) …)`, `({a:`… con TurboFan) necesita ~6,5 MB antes de que QuickJS lo corte;
   * con los 4 MB por defecto, V8 se desbordaba primero. 32 MB deja un margen de ~5× y es solo
   * reserva virtual: la memoria real se usa a medida que crece la pila.
   */
  threadStackMb: 32,
  /** Heap de V8 del hilo (el de QuickJS va aparte, en la memoria WebAssembly). */
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  /**
   * Tope de la memoria WebAssembly de cada hilo (≈5 MB de pila C y datos + ≈27 MB de heap). Es el
   * límite REAL del total: sin él, `while (true) a.push(new Float64Array(1e6))` llevaba la memoria a
   * 2 GB (que WebAssembly nunca devuelve). Los resourceLimits de V8 no cubren esta memoria.
   * También acota el anidamiento de funciones que compila QuickJS (guarda el texto de cada función:
   * memoria cuadrática), cuya recursión no comprueba la pila C (~875 B por nivel; con ≈5850 niveles
   * la desbordaba y pisaba los datos estáticos del módulo): con 32 MB no pasa de ~4200 niveles.
   */
  wasmMemoryMaxBytes: 32 * 1024 * 1024,
} as const;

export const ScriptOutputSchema = z
  .object({
    update: z.record(z.string(), z.unknown()).optional(),
    create: z
      .array(z.object({ module: z.string().max(40), values: z.record(z.string(), z.unknown()) }).strict())
      .max(10)
      .optional(),
    notify: z
      .array(z.object({ to: NotifyTargetSchema, title: z.string().trim().min(1).max(140), body: z.string().max(500).optional() }).strict())
      .max(5)
      .optional(),
    log: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();
export type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

export class ScriptError extends Error {}

// Preludio dentro del sandbox: console.log recoge trazas (no hay E/S real).
const PRELUDE = `var __logs = [];
var console = { log: function () { if (__logs.length < 20) __logs.push(Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ').slice(0, 500)); } };
console.info = console.warn = console.error = console.log;
`;

const EPILOGUE = `
;(function () {
  if (typeof run !== 'function') throw new Error('El script debe definir function run(input)');
  var out = run(JSON.parse(__input));
  if (out === undefined || out === null) out = {};
  if (typeof out !== 'object' || Array.isArray(out)) throw new Error('run(input) debe devolver un objeto');
  return JSON.stringify({ out: out, logs: __logs });
})()`;

function describe(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    if (e.message) return `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`;
  }
  return String(err);
}

/**
 * Código del hilo del sandbox. Es JavaScript plano (CommonJS) evaluado con `new Worker(src, { eval: true })`:
 * funciona igual con vitest (fuentes TypeScript) que en el bundle de esbuild de producción, sin una
 * entrada de build aparte. Los paquetes de QuickJS se cargan con require() desde rutas absolutas que
 * resuelve el hilo principal (ambos publican entrada CommonJS).
 * Responde a cada trabajo con { id, kind, ... }: 'ok' (raw = JSON devuelto por el epílogo), 'timeout',
 * 'memory', 'too_big', 'script' (error normal del script) o 'internal' (fallo del propio motor).
 */
const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } = require(workerData.corePath);
const releaseVariant = require(workerData.variantPath);
const L = workerData.limits;
// Memoria WebAssembly propia y con tope: aunque algo escapase al límite de QuickJS, no puede crecer más.
const wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: L.wasmMemoryPages });
const variant = newVariant(releaseVariant.default || releaseVariant, { wasmMemory: wasmMemory });
let broken = false;

function describe(err) {
  if (err && typeof err === 'object' && err.message) return (err.name && err.name !== 'Error' ? err.name + ': ' : '') + err.message;
  return String(err);
}

function stringProp(vm, h, key) {
  const p = vm.getProp(h, key);
  try { return vm.typeof(p) === 'string' ? vm.getString(p) : ''; } finally { p.dispose(); }
}

// Texto del valor lanzado por el script: solo cadenas (message/name o String(valor), calculado dentro
// del sandbox). No se usa vm.dump: serializa el objeto entero a JSON y, con referencias compartidas,
// fuera del sandbox puede ocupar muchas veces más que dentro.
function errorText(vm, h) {
  if (vm.typeof(h) === 'object') {
    const message = stringProp(vm, h, 'message');
    if (message) {
      const name = stringProp(vm, h, 'name');
      return (name && name !== 'Error' ? name + ': ' : '') + message;
    }
  }
  return vm.getString(h);
}

function evaluate(vm, job, started) {
  const input = vm.newString(job.inputJson);
  vm.setProp(vm.global, '__input', input);
  input.dispose();
  const result = vm.evalCode(L.prelude + job.code + L.epilogue, 'script.js');
  if (result.error) {
    const msg = errorText(vm, result.error) || 'error sin descripción';
    result.error.dispose();
    if (/interrupted/i.test(msg) || Date.now() - started >= job.timeoutMs) return { kind: 'timeout' };
    if (/out of memory/i.test(msg)) return { kind: 'memory' };
    return { kind: 'script', message: msg.slice(0, 500) };
  }
  const raw = vm.typeof(result.value) === 'string' ? vm.getString(result.value) : '';
  result.value.dispose();
  if (raw.length > L.maxOutputChars) return { kind: 'too_big' };
  return { kind: 'ok', raw: raw };
}

function execute(QuickJS, job) {
  if (broken) return { id: job.id, kind: 'internal', message: 'sandbox inutilizable' };
  const started = Date.now();
  try {
    // Runtime y contexto nuevos por ejecución: nada de un script sobrevive al siguiente.
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(L.memoryBytes);
    runtime.setMaxStackSize(L.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(started + job.timeoutMs));
    const vm = runtime.newContext();
    const reply = evaluate(vm, job, started);
    vm.dispose();
    runtime.dispose();
    reply.id = job.id;
    reply.ms = Date.now() - started;
    return reply;
  } catch (e) {
    // Excepción del propio motor, no del script (abort o aserción de WebAssembly, trap, pila nativa
    // agotada...): el estado del módulo ya no es fiable. No se libera nada (podría abortar otra vez)
    // y el hilo principal descarta este hilo.
    broken = true;
    return { id: job.id, kind: 'internal', message: describe(e).slice(0, 300) };
  }
}

newQuickJSWASMModuleFromVariant(variant).then(function (QuickJS) {
  parentPort.on('message', function (job) { parentPort.postMessage(execute(QuickJS, job)); });
  parentPort.postMessage({ type: 'ready' });
});
`;

type WorkerReply =
  | { id: number; kind: 'ok'; raw: string; ms: number }
  | { id: number; kind: 'timeout' | 'memory' | 'too_big'; ms: number }
  | { id: number; kind: 'script'; message: string; ms: number }
  | { id: number; kind: 'internal'; message: string };

interface PendingRun {
  id: number;
  code: string;
  inputJson: string;
  timeoutMs: number;
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  ready: boolean;
  run: PendingRun | null;
  /** Plazo de arranque o plazo duro de la ejecución en curso. */
  timer: ReturnType<typeof setTimeout> | null;
  retired: boolean;
}

/** Tras tantos arranques fallidos seguidos se deja de insistir hasta que llegue trabajo nuevo. */
const MAX_FAILED_STARTS = 3;

const pool = {
  workers: new Set<PoolWorker>(),
  queue: [] as PendingRun[],
  nextId: 1,
  failedStarts: 0,
  lastStartError: '',
  started: 0,
  replaced: 0,
};
let quickjsPaths: { corePath: string; variantPath: string } | null = null;

function workerError(detail: string): ScriptError {
  return new ScriptError(`El sandbox de scripts ha fallado y se ha reiniciado (${detail.slice(0, 300)})`);
}

function clearTimer(slot: PoolWorker): void {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
}

/** Saca el hilo del pool y lo termina (también si está atascado dentro de WebAssembly). */
function discard(slot: PoolWorker): Promise<void> {
  slot.retired = true;
  pool.workers.delete(slot);
  clearTimer(slot);
  slot.run = null;
  slot.worker.unref();
  return slot.worker.terminate().then(
    () => undefined,
    () => undefined,
  );
}

function spawnWorker(): boolean {
  let worker: Worker;
  try {
    // Resolución desde este módulo: server/src/crm (vitest) o dist/server (producción, con node_modules
    // al lado). En el hilo se cargan con require() las entradas CommonJS de los paquetes.
    if (!quickjsPaths) {
      const req = createRequire(import.meta.url);
      quickjsPaths = { corePath: req.resolve('quickjs-emscripten-core'), variantPath: req.resolve('@jitl/quickjs-wasmfile-release-sync') };
    }
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      // El hilo no necesita variables de entorno (credenciales, DATABASE_URL...) ni hereda las opciones
      // de Node del proceso (--import/--require de cargadores o agentes, --input-type...), que podrían
      // cambiar cómo se evalúa este código o meter código ajeno en el hilo del sandbox.
      env: {},
      execArgv: [],
      workerData: {
        ...quickjsPaths,
        limits: {
          memoryBytes: SCRIPT_LIMITS.memoryBytes,
          stackBytes: SCRIPT_LIMITS.stackBytes,
          maxOutputChars: SCRIPT_LIMITS.maxOutputChars,
          wasmMemoryPages: SCRIPT_POOL.wasmMemoryMaxBytes / 65536,
          prelude: PRELUDE,
          epilogue: EPILOGUE,
        },
      },
      resourceLimits: {
        maxOldGenerationSizeMb: SCRIPT_POOL.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: SCRIPT_POOL.maxYoungGenerationSizeMb,
        stackSizeMb: SCRIPT_POOL.threadStackMb,
      },
    });
  } catch (e) {
    pool.failedStarts++;
    pool.lastStartError = describe(e);
    return false;
  }
  const slot: PoolWorker = { worker, ready: false, run: null, timer: null, retired: false };
  pool.workers.add(slot);
  pool.started++;
  slot.timer = setTimeout(() => fail(slot, 'el hilo no ha arrancado a tiempo'), SCRIPT_POOL.startTimeoutMs);
  slot.timer.unref();
  worker.on('message', (msg: unknown) => onMessage(slot, msg));
  // Sin estos manejadores, un 'error' del hilo tumbaría el proceso principal.
  worker.on('error', (err) => fail(slot, describe(err)));
  worker.on('messageerror', (err) => fail(slot, describe(err)));
  worker.on('exit', (code) => fail(slot, `el hilo ha terminado con código ${code}`));
  return true;
}

/** El hilo murió por su cuenta ('error', 'exit', límites de recursos) o no arrancó a tiempo. */
function fail(slot: PoolWorker, detail: string): void {
  if (slot.retired) return;
  const run = slot.run;
  if (slot.ready) pool.replaced++;
  else {
    pool.failedStarts++;
    pool.lastStartError = detail;
  }
  void discard(slot);
  run?.reject(workerError(detail));
  pump();
}

function onMessage(slot: PoolWorker, msg: unknown): void {
  if (slot.retired || !msg || typeof msg !== 'object') return;
  if ((msg as { type?: unknown }).type === 'ready') {
    slot.ready = true;
    clearTimer(slot);
    pool.failedStarts = 0;
    pump();
    return;
  }
  const reply = msg as WorkerReply;
  const run = slot.run;
  if (reply.kind === 'internal') {
    // El motor de ese hilo ya no es fiable, sea cual sea la ejecución que lo provocó: fuera del pool.
    pool.replaced++;
    void discard(slot);
    if (run && run.id === reply.id) run.reject(workerError(reply.message));
    else if (run) pool.queue.unshift(run); // no llegó a ejecutarse en ese hilo: va a otro
    pump();
    return;
  }
  if (!run || reply.id !== run.id) return;
  clearTimer(slot);
  slot.run = null;
  run.resolve(reply);
  pump();
}

function dispatch(slot: PoolWorker, run: PendingRun): void {
  slot.run = run;
  // Plazo duro: corta lo que la interrupción de QuickJS no puede (bucles internos de los built-ins).
  slot.timer = setTimeout(() => {
    if (slot.run !== run) return;
    pool.replaced++;
    void discard(slot);
    run.reject(new ScriptError(`Tiempo máximo de ejecución superado (${run.timeoutMs} ms)`));
    pump();
  }, run.timeoutMs + SCRIPT_POOL.deadlineMarginMs);
  slot.worker.postMessage({ id: run.id, code: run.code, inputJson: run.inputJson, timeoutMs: run.timeoutMs });
}

/** Repone hilos, reparte la cola entre los libres y ajusta qué hilos mantienen vivo el proceso. */
function pump(): void {
  const { workers, queue } = pool;
  // Reposición: sin trabajo pendiente solo se repone si los arranques van bien (nunca en bucle).
  while (workers.size < SCRIPT_POOL.workers && pool.failedStarts < MAX_FAILED_STARTS && (queue.length > 0 || pool.failedStarts === 0)) {
    if (!spawnWorker()) break;
  }
  if (!workers.size && queue.length) {
    // Ningún hilo vivo ni por arrancar: se rechaza la cola en vez de dejarla colgada. El siguiente
    // script volverá a intentarlo una vez.
    pool.failedStarts = MAX_FAILED_STARTS - 1;
    const detail = pool.lastStartError ? ` (${pool.lastStartError.slice(0, 300)})` : '';
    for (const run of queue.splice(0)) run.reject(new ScriptError(`No se ha podido iniciar el sandbox de scripts${detail}`));
  }
  for (const slot of workers) {
    if (!queue.length) break;
    if (slot.ready && !slot.run) dispatch(slot, queue.shift()!);
  }
  // Un hilo ocupado (o arrancando con trabajo en cola) mantiene vivo el proceso; uno inactivo, no.
  for (const slot of workers) {
    if (slot.run || (!slot.ready && queue.length)) slot.worker.ref();
    else slot.worker.unref();
  }
}

function submit(code: string, inputJson: string, timeoutMs: number): Promise<WorkerReply> {
  if (pool.queue.length >= SCRIPT_POOL.maxQueued) return Promise.reject(new ScriptError('Demasiados scripts en ejecución; inténtalo de nuevo'));
  return new Promise((resolve, reject) => {
    pool.queue.push({ id: pool.nextId++, code, inputJson, timeoutMs, resolve, reject });
    pump();
  });
}

/** Termina todos los hilos del sandbox y rechaza lo pendiente. Un script posterior vuelve a arrancar el pool. */
export async function shutdownScriptPool(): Promise<void> {
  const pending = pool.queue.splice(0);
  const stopping = [...pool.workers].map((slot) => {
    if (slot.run) pending.push(slot.run);
    return discard(slot);
  });
  pool.failedStarts = 0;
  for (const run of pending) run.reject(new ScriptError('El sandbox de scripts se ha detenido'));
  await Promise.all(stopping);
}

/** Estado del pool (diagnóstico y pruebas). */
export function scriptPoolStats(): { workers: number; ready: number; busy: number; queued: number; started: number; replaced: number } {
  const list = [...pool.workers];
  return {
    workers: list.length,
    ready: list.filter((s) => s.ready).length,
    busy: list.filter((s) => s.run).length,
    queued: pool.queue.length,
    started: pool.started,
    replaced: pool.replaced,
  };
}

/** Ejecuta `run(input)` del script en un sandbox nuevo y devuelve su salida validada. */
export async function runScript(code: string, input: unknown, opts: { timeoutMs?: number } = {}): Promise<{ output: ScriptOutput; logs: string[]; ms: number }> {
  if (!code.trim()) throw new ScriptError('El script no tiene código');
  if (code.length > SCRIPT_LIMITS.maxCodeChars) throw new ScriptError(`El script supera ${SCRIPT_LIMITS.maxCodeChars} caracteres`);
  const inputJson = JSON.stringify(input) ?? 'null';
  if (inputJson.length > SCRIPT_LIMITS.maxInputChars) throw new ScriptError('Los datos de entrada del script son demasiado grandes');
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? SCRIPT_LIMITS.defaultTimeoutMs, 50), SCRIPT_LIMITS.maxTimeoutMs);

  const reply = await submit(code, inputJson, timeoutMs);
  switch (reply.kind) {
    case 'ok':
      break;
    case 'timeout':
      throw new ScriptError(`Tiempo máximo de ejecución superado (${timeoutMs} ms)`);
    case 'memory':
      // 16 MB por asignación y ~27 MB en total (tope de memoria WebAssembly del hilo): sin cifra para no engañar.
      throw new ScriptError('Memoria máxima del script superada');
    case 'too_big':
      throw new ScriptError('La respuesta del script es demasiado grande');
    case 'script':
      throw new ScriptError(`Error en el script: ${reply.message}`);
    default:
      throw workerError('respuesta desconocida');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.raw);
  } catch {
    throw new ScriptError('El script no devolvió un resultado válido');
  }
  if (!parsed || typeof parsed !== 'object') throw new ScriptError('El script no devolvió un resultado válido');
  const { out: rawOut, logs: rawLogs } = parsed as { out?: unknown; logs?: unknown };
  const out = ScriptOutputSchema.safeParse(rawOut);
  if (!out.success) {
    throw new ScriptError(`Resultado no válido: ${out.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'resultado'}: ${i.message}`).join('; ')}`);
  }
  const logs = Array.isArray(rawLogs) ? rawLogs.filter((l): l is string => typeof l === 'string').slice(0, 20).map((l) => l.slice(0, 500)) : [];
  return { output: out.data, logs, ms: reply.ms };
}

export interface ScriptInput {
  record: { id: string; module: string; data: Record<string, unknown>; createdAt: string; updatedAt: string; lastActivityAt: string };
  previous: Record<string, unknown> | null;
  trigger: string;
  /** Registros de otros módulos que apuntan a este (máx. 50 por módulo), por clave de módulo. */
  related: Record<string, { id: string; data: Record<string, unknown> }[]>;
  /** Registros a los que apunta este registro, por clave de campo de relación. */
  refs: Record<string, { id: string; module: string; data: Record<string, unknown> }>;
  now: string;
  tz: string;
}

/** Prepara los datos (solo de la propia organización) que recibe el script. */
export async function buildScriptInput(svc: RecordService, rec: StoredRecord, ctx: { trigger: string; previous?: Record<string, unknown> }): Promise<ScriptInput> {
  const { blueprint, store, now, tz } = svc.ctx;
  const mod = findModule(blueprint, rec.moduleKey);
  const refs: ScriptInput['refs'] = {};
  const related: ScriptInput['related'] = {};
  if (mod) {
    for (const f of mod.fields) {
      const v = rec.data[f.key];
      if (f.type !== 'relation' || f.archived || typeof v !== 'string') continue;
      const target = await store.get(v);
      if (target) refs[f.key] = { id: target.id, module: target.moduleKey, data: target.data };
    }
    for (const m of activeModules(blueprint)) {
      for (const f of m.fields) {
        if (f.type !== 'relation' || f.archived || f.relation?.module !== mod.key) continue;
        const { items } = await store.list(
          m,
          { filters: [{ field: f.key, operator: 'eq', value: rec.id }], limit: SCRIPT_LIMITS.relatedPerModule, offset: 0, sort: { field: 'created_at', direction: 'desc' } },
          { now: now(), tz },
        );
        const list = (related[m.key] ??= []);
        for (const r of items) if (!list.some((x) => x.id === r.id)) list.push({ id: r.id, data: r.data });
      }
    }
  }
  return {
    record: { id: rec.id, module: rec.moduleKey, data: rec.data, createdAt: rec.createdAt, updatedAt: rec.updatedAt, lastActivityAt: rec.lastActivityAt },
    previous: ctx.previous ?? null,
    trigger: ctx.trigger,
    related,
    refs,
    now: now().toISOString(),
    tz,
  };
}

/** Contrato que se muestra al modelo que escribe el código y en la documentación. */
export const SCRIPT_CONTRACT = `// Se ejecuta en un sandbox aislado (QuickJS en WebAssembly): sin red, sin archivos, sin require/import,
// sin acceso al servidor. Máx. ${SCRIPT_LIMITS.memoryBytes / 1048576} MB y el tiempo configurado (por defecto ${SCRIPT_LIMITS.defaultTimeoutMs} ms).
// Define una función PURA y síncrona:
function run(input) {
  // input.record   → { id, module, data: { campo: valor }, createdAt, updatedAt, lastActivityAt }
  // input.previous → datos anteriores del registro (en actualizaciones) o null
  // input.trigger  → 'record_created' | 'record_updated' | 'date_reached' | 'inactivity' | ...
  // input.related  → { [modulo]: [{ id, data }] } registros de otros módulos que apuntan a este (máx. ${SCRIPT_LIMITS.relatedPerModule} por módulo)
  // input.refs     → { [campo_relacion]: { id, module, data } } registros a los que apunta este
  // input.now      → fecha y hora ISO; input.tz → zona horaria de la organización
  return {
    update: { /* campo: valor */ },                        // opcional: cambios en el registro que dispara
    create: [ /* { module: 'tasks', values: { ... } } */ ],  // opcional: nuevos registros (máx. 10)
    notify: [ /* { to: { type: 'user_field', field: 'owner' } | { type: 'role', role: 'admin' } | { type: 'all' }, title, body? } */ ], // máx. 5
    log: [ /* trazas visibles en el historial de ejecuciones */ ],
  };
}
// Las fechas sin hora son cadenas 'AAAA-MM-DD'; las relaciones guardan el id del registro.
// console.log(...) también queda en el historial. Los cambios se validan con las reglas del módulo.`;
