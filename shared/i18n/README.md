# Idiomas de Cortex CRM

La interfaz, los mensajes del servidor, los correos, el CRM inicial de cada organización y las respuestas de la IA
están en **español, inglés, portugués de Brasil, francés, alemán, italiano y japonés**.

- **El texto en español es la clave.** `t('Guardar')` busca «Guardar» en el catálogo del idioma activo
  (`shared/i18n/locales/<idioma>.json`) y, si no hay traducción, muestra el español. El código se lee igual que
  antes y una traducción pendiente nunca rompe nada.
- **Idioma de cada persona:** el que elige en *Ajustes › Mi cuenta*; si no elige ninguno, el de su organización
  (*Ajustes › Organización › Idioma y región*, que también decide el formato de fechas y números). Antes de iniciar
  sesión, el del navegador (con un selector en las pantallas de acceso).
- **Servidor:** cada petición responde en el idioma que pide su cabecera `Accept-Language` (la web envía siempre el
  que está usando) o, si no pide ninguno de los siete, en el de la persona identificada. Los trabajos en segundo
  plano usan el idioma de quien los encoló (`jobs.locale`) o el de la organización.

## Funciones

| Dónde | Importar desde |
|---|---|
| Web | `web/src/lib/i18n.tsx` (además: `tx`, `useLocale`, `setLocale`, `getIntlTag`) |
| Servidor | `server/src/i18n.ts` (además: `withLocale`, `currentLocale`, `promptLanguage`) |
| Código compartido | `shared/i18n/index.ts` (además: `activeIntlTag`) |

```ts
t('Guardar')                                   // texto fijo
t('Hola, {name}', { name })                    // con datos: siempre variables, nunca concatenar
tp(n, '{count} registro', '{count} registros') // plurales ({count} sale con el formato del idioma)
tx('Escribe <b>{name}</b> para confirmar', { name, b: (c) => <strong>{c}</strong> }) // web: con elementos
msg('Borrador')                                // marca un texto fijo de una constante; se traduce al mostrarlo…
tk(STATUS_LABELS[s])                           // …con tk(), que traduce un texto que llega en una variable
listFormat(['A', 'B', 'C'])                    // «A, B y C» / «A, B, and C»
t('Media@@agregado')                           // contexto: se ve «Media», pero se traduce aparte de t('Media') (nivel)
```

**Palabras con dos sentidos.** Si una misma palabra en español necesita traducciones distintas según dónde se use
(«Media» como nivel y como promedio, «Subir» un archivo y subir de posición), añade un contexto tras `@@`: en español
se ve igual y quien traduce sabe a qué se refiere.

## Reglas

1. **El primer argumento de `t`, `tx` y `msg` (y las dos formas de `tp`) es un literal.** Así
   `scripts/i18n.mjs` puede extraer las claves. Nada de `` t(`Hola ${name}`) `` ni `t(variable)`: para un texto que
   viene en una variable usa `tk()`, y márcalo con `msg()` donde se define.
2. **Frases completas.** No se traducen trozos para unirlos después: el orden de las palabras cambia de un idioma a
   otro. `t('Eliminar {name}', { name })`, no `t('Eliminar') + ' ' + name`. Tampoco `registro(s)` ni
   `` `${n} campo${n === 1 ? '' : 's'}` ``: usa `tp`.
3. **Se traduce al pintar, no al cargar el módulo.** Una constante de módulo se evalúa una vez, con el idioma de
   ese momento. Para tablas de etiquetas, conviértelas en función (`const statusLabel = (s) => ({ draft: t('Borrador') })[s]`)
   o márcalas con `msg()` y usa `tk()` al mostrarlas. Los valores por defecto de las props
   (`confirmLabel = t('Confirmar')`) sí sirven: se evalúan al pintar.
4. **Mismo español que antes.** La clave es el texto que ya había (los tests y la interfaz en español no cambian).
5. **No se traducen:** valores de código (claves, estados, tipos, `value` de opciones), clases CSS, URLs, registros
   (logs), nombres propios (Cortex CRM, EVOLVE AI ENGINE, WhatsApp, Railway…) ni los **datos** de cada
   organización (nombres de módulos y campos, registros, lo que escribe la gente): esos ya están en su idioma.
6. **No llames `t`, `tp`, `tk`, `tx` o `msg` a ninguna variable** en un archivo que las importa (por ejemplo
   `for (const t of tokens)`): taparía la función. `scripts/i18n.mjs check` lo detecta.
7. **Fechas y números** con `lib/format.ts` en la web o con `activeIntlTag()` / `getIntlTag()`; nunca `'es-ES'` fijo.
   Para ordenar texto: `a.localeCompare(b, getIntlTag())`.

### Servidor

- **Errores:** los mensajes fijos se dejan como están (`badRequest('El nombre es obligatorio')`): el manejador de
  errores los traduce al idioma de la petición porque son claves del catálogo. Si llevan datos, se traducen al
  crearlos: `badRequest(t('El campo {field} no existe', { field }))`. Un mensaje fijo guardado en una constante de
  módulo se marca con `msg()`.
- **Validación con zod:** los mensajes propios con `msg()` (`z.string().min(10, msg('Mínimo 10 caracteres'))`);
  los de zod por defecto ya salen en el idioma de la petición.
- **Correos:** con `t()` dentro de la petición (salen en el idioma de quien la hace). Para escribir a otra persona
  en su idioma: `withLocale(locale, () => …)`.
- **IA:** los prompts se escriben en español, pero **el idioma de la respuesta** se indica con
  `promptLanguage()`: «Responde en ${promptLanguage()}». Las etiquetas que la IA crea para la organización (módulos,
  campos, opciones) van en el idioma de la organización.
- **Textos que se guardan** (planes de EVOLVE, avisos, resultados de pruebas) se generan con `t()` en el idioma de
  quien hizo la petición, y se guardan ya traducidos.

## Catálogos

```bash
node scripts/i18n.mjs untranslated web/src/pages/X.tsx   # textos que parecen visibles y no pasan por t()
node scripts/i18n.mjs sync                                # añade las claves nuevas (vacías) y quita las que ya no se usan
node scripts/i18n.mjs missing de pendientes-de.json       # claves sin traducir de un idioma, con dónde se usan
node scripts/i18n.mjs status                              # cuántas faltan por idioma
npm run i18n:check                                        # todo traducido y sin textos sueltos (lo ejecuta la CI)
```

Formato: un objeto JSON plano `{ "texto en español": "traducción" }`. Los plurales tienen por clave las dos formas
en español separadas por `|` y por valor las formas del idioma: `{ "one": "{count} record", "other": "{count} records" }`
(en japonés basta `{ "other": "…" }`). Una traducción conserva **las mismas variables `{x}` y etiquetas `<b>…</b>`**
que el original (la CI lo comprueba).

### Añadir un idioma

1. Añádelo a `LOCALES` y `LOCALE_INFO` en `shared/i18n/index.ts`, y su catálogo al servidor (`server/src/i18n.ts`,
   incluido el idioma de zod) y a `TARGETS` en `scripts/i18n.mjs`.
2. `node scripts/i18n.mjs sync` crea `shared/i18n/locales/<idioma>.json` con las claves vacías; tradúcelas.
3. `npm run i18n:check` y `npm test`.
