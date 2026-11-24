import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runScript, SCRIPT_LIMITS, SCRIPT_POOL, ScriptError, scriptPoolStats, shutdownScriptPool } from '../src/crm/scripts';

/**
 * Endurecimiento del sandbox de scripts: se ejecuta en un pool de worker_threads (nunca en el hilo
 * principal), con plazo duro, pila segura, tope real de memoria, cola acotada y recuperación cuando un
 * hilo falla. Los hilos se crean con la clase real de node:worker_threads; la prueba solo la envuelve
 * para poder simular fallos del motor y caídas del hilo.
 */
const tracked = vi.hoisted(() => ({ workers: [] as import('node:worker_threads').Worker[], corruptNextJob: false }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class TrackedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      tracked.workers.push(this);
    }
    override postMessage(value: unknown, transferList?: Parameters<InstanceType<typeof actual.Worker>['postMessage']>[1]): void {
      if (tracked.corruptNextJob && value && typeof value === 'object' && 'inputJson' in value) {
        // Entrada no textual: vm.newString() lanza en el propio motor (fallo interno, no del script).
        tracked.corruptNextJob = false;
        value = { ...value, inputJson: undefined };
      }
      super.postMessage(value, transferList);
    }
  }
  return { ...actual, Worker: TrackedWorker, default: { ...actual, Worker: TrackedWorker } };
});

const input = { record: { id: 'r1', module: 'deals', data: { amount: 42000 } }, previous: null, trigger: 'record_created', related: {}, refs: {}, now: '2026-11-23T10:00:00.000Z', tz: 'Europe/Madrid' };
const NORMAL = 'function run(input) { var s = 0; for (var i = 0; i < 1000; i++) s += i; return { update: { s: s, amount: input.record.data.amount } }; }';
async function expectNormalWorks() {
  expect((await runScript(NORMAL, input)).output).toEqual({ update: { s: 499500, amount: 42000 } });
}
/** Espera a que el pool esté completo (tras descartar un hilo, el sustituto tarda en cargar QuickJS). */
async function waitForFullPool() {
  for (let i = 0; i < 400 && scriptPoolStats().ready < SCRIPT_POOL.workers; i++) await new Promise((r) => setTimeout(r, 25));
  expect(scriptPoolStats().ready).toBe(SCRIPT_POOL.workers);
}

beforeAll(async () => {
  await expectNormalWorks(); // arranca el pool
});
afterAll(async () => {
  await shutdownScriptPool();
});

describe('plazo duro: bucles internos de los built-ins que QuickJS no interrumpe', () => {
  it.each(['indexOf', 'includes', 'lastIndexOf', 'join'])('Array.prototype.%s sobre { length: 2 ** 53 - 1 } se corta y el hilo principal sigue respondiendo', async (fn) => {
    const timeoutMs = 200;
    const replaced = scriptPoolStats().replaced;
    const arg = fn === 'join' ? '""' : '1';
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    try {
      await expect(runScript(`function run() { Array.prototype.${fn}.call({ length: 2 ** 53 - 1 }, ${arg}); return {}; }`, input, { timeoutMs })).rejects.toThrow(
        `Tiempo máximo de ejecución superado (${timeoutMs} ms)`,
      );
    } finally {
      clearInterval(timer);
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
    expect(elapsed).toBeLessThan(timeoutMs + 1500);
    // El bucle de eventos del hilo principal no se ha bloqueado mientras el script corría.
    expect(ticks).toBeGreaterThanOrEqual(10);
    // El hilo atascado se ha terminado y sustituido; el siguiente script funciona.
    expect(scriptPoolStats().replaced).toBe(replaced + 1);
    await expectNormalWorks();
  });

  it('un script atascado en un hilo no retrasa a los demás: se atienden en el otro', async () => {
    await waitForFullPool();
    const stuck = runScript('function run() { Array.prototype.includes.call({ length: 2 ** 53 - 1 }, 1); return {}; }', input, { timeoutMs: 1000 });
    const stuckRejected = expect(stuck).rejects.toThrow('Tiempo máximo de ejecución superado (1000 ms)');
    const t0 = Date.now();
    const out = await Promise.all(Array.from({ length: 10 }, (_, n) => runScript('function run(input) { return { update: { n: input.n } }; }', { n })));
    expect(out.map((r) => r.output.update?.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Date.now() - t0).toBeLessThan(1000); // antes de que venza el plazo duro del atascado
    await stuckRejected;
  });
});

describe('pila: las recursiones profundas no corrompen el motor', () => {
  it('50 recursiones profundas seguidas y después un script normal, sin descartar ningún hilo', async () => {
    await waitForFullPool();
    const before = scriptPoolStats();
    for (let i = 0; i < 50; i++) {
      const r = await runScript('function run() { try { (function f() { f(); })(); } catch (e) {} return { log: ["sobrevive"] }; }', input);
      expect(r.output.log).toEqual(['sobrevive']);
    }
    await expectNormalWorks();
    const after = scriptPoolStats();
    // Si el motor se hubiese roto, el pool habría descartado hilos: no debe haber pasado.
    expect(after.replaced).toBe(before.replaced);
    expect(after.started).toBe(before.started);
  });

  it('los desbordamientos son errores limpios del script (también en el analizador sintáctico)', async () => {
    const replaced = scriptPoolStats().replaced;
    await expect(runScript('function run() { (function f() { f(); })(); }', input)).rejects.toThrow('Error en el script: InternalError: stack overflow');
    await expect(runScript('function run() { var o = { get x() { return this.x; } }; return o.x; }', input)).rejects.toThrow(/stack overflow/);
    await expect(runScript('function run() { var o = { toJSON: function () { return JSON.stringify(o); } }; JSON.stringify(o); }', input)).rejects.toThrow(/stack overflow/);
    // El analizador gasta ~20 veces más pila nativa que pila de QuickJS: con la pila del hilo por
    // defecto (4 MB) estos casos desbordaban V8 antes de que QuickJS los detectase.
    await expect(runScript('function run() { eval("(".repeat(100000) + "1" + ")".repeat(100000)); }', input)).rejects.toThrow(/SyntaxError: stack overflow/);
    await expect(runScript('function run() { Function("return " + "[".repeat(100000) + "]".repeat(100000)); }', input)).rejects.toThrow(/SyntaxError: stack overflow/);
    await expect(runScript('function run() { JSON.parse("[".repeat(200000) + "]".repeat(200000)); }', input)).rejects.toThrow(/stack overflow/);
    // Compilar funciones anidadas no comprueba la pila C de QuickJS (~875 B por nivel; a ~5850 niveles la
    // desbordaba): el tope de memoria WebAssembly lo corta antes.
    await expect(runScript('function run() { eval("function a(){".repeat(5852) + "}".repeat(5852)); }', input, { timeoutMs: 3000 })).rejects.toThrow(/Memoria máxima/);
    expect(scriptPoolStats().replaced).toBe(replaced);
    await expectNormalWorks();
  });

  it('queda margen de recursión para scripts legítimos', async () => {
    const r = await runScript('function run() { var d = 0; function f() { d++; f(); } try { f(); } catch (e) {} return { update: { depth: d } }; }', input);
    expect(SCRIPT_LIMITS.stackBytes).toBeLessThanOrEqual(256 * 1024);
    expect(r.output.update?.depth).toBeGreaterThan(1000);
  });
});

describe('recuperación cuando un hilo falla', () => {
  it('un fallo interno del motor rechaza esa llamada con ScriptError, descarta el hilo y lo siguiente funciona', async () => {
    const replaced = scriptPoolStats().replaced;
    tracked.corruptNextJob = true;
    const err = await runScript(NORMAL, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as Error).message).toMatch(/^El sandbox de scripts ha fallado y se ha reiniciado/);
    expect(scriptPoolStats().replaced).toBe(replaced + 1);
    await expectNormalWorks();
    await Promise.all(Array.from({ length: 4 }, () => expectNormalWorks()));
  });

  it('si los hilos mueren mientras ejecutan, la llamada en curso falla con ScriptError y las siguientes funcionan', async () => {
    const replaced = scriptPoolStats().replaced;
    const pending = runScript('function run() { var t = Date.now(); while (Date.now() - t < 2500) {} return {}; }', input, { timeoutMs: 3000 });
    const pendingError = pending.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 150));
    expect(scriptPoolStats().busy).toBe(1);
    // Caída de todos los hilos desde fuera (terminate() resuelve cuando el hilo ya ha salido).
    await Promise.all(tracked.workers.map((w) => w.terminate()));
    const err = await pendingError;
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as Error).message).toMatch(/^El sandbox de scripts ha fallado y se ha reiniciado \(el hilo ha terminado/);
    expect(scriptPoolStats().replaced).toBeGreaterThan(replaced);
    await expectNormalWorks();
  });

  it("un evento 'error' del hilo lo descarta y el pool sigue atendiendo", async () => {
    await expectNormalWorks();
    const replaced = scriptPoolStats().replaced;
    // Solo a los hilos vivos (Node quita los manejadores de un hilo que ya ha salido).
    for (const w of tracked.workers) if (w.listenerCount('error') > 0) w.emit('error', new Error('fallo simulado'));
    expect(scriptPoolStats().replaced).toBeGreaterThan(replaced);
    await expectNormalWorks();
  });
});

describe('concurrencia y cola', () => {
  it('10 scripts en paralelo terminan bien y cada uno recibe su propia entrada', async () => {
    const code = 'function run(input) { var s = 0; for (var i = 0; i < 20000; i++) s += i % 7; console.log("n", input.n); return { update: { n: input.n * 2, s: s } }; }';
    const out = await Promise.all(Array.from({ length: 10 }, (_, n) => runScript(code, { n })));
    expect(out.map((r) => r.output.update?.n)).toEqual(Array.from({ length: 10 }, (_, n) => n * 2));
    expect(out.map((r) => r.logs[0])).toEqual(Array.from({ length: 10 }, (_, n) => `n ${n}`));
    expect(out.every((r) => typeof r.ms === 'number' && r.ms >= 0)).toBe(true);
  });

  it(`con todos los hilos ocupados encola hasta ${SCRIPT_POOL.maxQueued} y rechaza el resto`, async () => {
    await waitForFullPool();
    const slow = 'function run() { var t = Date.now(); while (Date.now() - t < 20) {} return {}; }';
    const total = SCRIPT_POOL.workers + SCRIPT_POOL.maxQueued + 3;
    const results = await Promise.allSettled(Array.from({ length: total }, () => runScript(slow, input)));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.length).toBe(3);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ScriptError);
      expect((r.reason as Error).message).toBe('Demasiados scripts en ejecución; inténtalo de nuevo');
    }
    expect(results.length - rejected.length).toBeGreaterThanOrEqual(SCRIPT_POOL.maxQueued);
    await expectNormalWorks();
  });
});

describe('comportamiento de siempre del sandbox', () => {
  it('corta los bucles infinitos por la interrupción de QuickJS sin necesidad de descartar el hilo', async () => {
    const replaced = scriptPoolStats().replaced;
    const t0 = Date.now();
    await expect(runScript('function run() { while (true) {} }', input, { timeoutMs: 100 })).rejects.toThrow('Tiempo máximo de ejecución superado (100 ms)');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(scriptPoolStats().replaced).toBe(replaced);
  });

  it('corta el consumo excesivo de memoria (también el que el límite de QuickJS no acumula)', async () => {
    const replaced = scriptPoolStats().replaced;
    await expect(runScript('function run() { var a = []; while (true) a.push(new Float64Array(1e6)); }', input, { timeoutMs: 3000 })).rejects.toThrow('Memoria máxima del script superada');
    // 10 × 10 MB: cada asignación pasa el límite de 16 MB de QuickJS, pero el total no cabe en el tope.
    await expect(runScript('function run() { var a = []; for (var i = 0; i < 10; i++) a.push(new Uint8Array(1e7)); return {}; }', input, { timeoutMs: 3000 })).rejects.toThrow(/Memoria máxima/);
    expect(scriptPoolStats().replaced).toBe(replaced);
    await expectNormalWorks();
  });

  it('valida la salida, exige run() y convierte los fallos del script en ScriptError', async () => {
    await expect(runScript('function run() { return { borrarTodo: true }; }', input)).rejects.toThrow(/Resultado no válido/);
    await expect(runScript('var x = 1;', input)).rejects.toThrow(/function run/);
    await expect(runScript('function run() { return [1, 2]; }', input)).rejects.toThrow(/debe devolver un objeto/);
    await expect(runScript('function run() { throw new Error("fallo previsto"); }', input)).rejects.toThrow('Error en el script: fallo previsto');
    await expect(runScript('function run() { throw new TypeError("tipo"); }', input)).rejects.toThrow('Error en el script: TypeError: tipo');
    await expect(runScript('function run() { return { log: ["x".repeat(70000)] }; }', input)).rejects.toThrow('La respuesta del script es demasiado grande');
    await expect(runScript('function run() { JSON.stringify = function () { return "null"; }; return {}; }', input)).rejects.toThrow('El script no devolvió un resultado válido');
    await expect(runScript('', input)).rejects.toThrow('El script no tiene código');
    await expect(runScript('x'.repeat(SCRIPT_LIMITS.maxCodeChars + 1), input)).rejects.toThrow(/supera/);
  });

  it('los valores lanzados raros se describen sin copiar objetos enteros fuera del sandbox', async () => {
    const replaced = scriptPoolStats().replaced;
    await expect(runScript('function run() { throw Promise.resolve(1); }', input)).rejects.toThrow('Error en el script: [object Promise]');
    await expect(runScript('function run() { throw null; }', input)).rejects.toThrow('Error en el script: null');
    await expect(runScript('function run() { throw { name: "MiError", message: "algo falló" }; }', input)).rejects.toThrow('Error en el script: MiError: algo falló');
    await expect(runScript('function run() { throw Symbol("s"); }', input)).rejects.toThrow('Error en el script: error sin descripción');
    // Error con datos que comparten referencias: su JSON ocuparía ~14 MB fuera del sandbox.
    await expect(
      runScript('function run() { var row = []; for (var i = 0; i < 1000; i++) row.push(0); var a = []; for (var j = 0; j < 7000; j++) a.push(row); var e = new Error("grande"); e.data = a; throw e; }', input),
    ).rejects.toThrow('Error en el script: grande');
    await expect(runScript('function run() { throw { get message() { while (true) {} } }; }', input, { timeoutMs: 200 })).rejects.toThrow(/Tiempo máximo/);
    expect(scriptPoolStats().replaced).toBe(replaced);
  });
});

describe('ciclo de vida del pool', () => {
  it('shutdownScriptPool termina los hilos, rechaza lo pendiente y un script posterior vuelve a arrancar el pool', async () => {
    await expectNormalWorks();
    const inflight = runScript('function run() { var t = Date.now(); while (Date.now() - t < 1000) {} return {}; }', input, { timeoutMs: 2000 });
    const inflightRejected = expect(inflight).rejects.toThrow('El sandbox de scripts se ha detenido');
    await new Promise((r) => setTimeout(r, 50));
    await shutdownScriptPool();
    await inflightRejected;
    expect(scriptPoolStats().workers).toBe(0);
    await expectNormalWorks();
    expect(scriptPoolStats().workers).toBeGreaterThan(0);
  });

  it('los hilos inactivos no mantienen vivo el proceso', async () => {
    const scriptsUrl = new URL('../src/crm/scripts.ts', import.meta.url).href;
    const program = `import { runScript } from ${JSON.stringify(scriptsUrl)};
const r = await runScript('function run(input) { return { update: { ok: input.ok } }; }', { ok: true });
console.log(JSON.stringify(r.output));`;
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const killer = setTimeout(() => child.kill(), 20_000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    clearTimeout(killer);
    // Sin shutdownScriptPool(): el proceso termina solo en cuanto acaba el trabajo.
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe('{"update":{"ok":true}}');
  });
});
