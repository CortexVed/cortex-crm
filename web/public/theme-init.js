/*
 * Antes del primer pintado (script bloqueante en <head>, permitido por la CSP por ser del mismo origen): aplica el
 * tema claro u oscuro, el color-scheme de los controles nativos y los colores de la última organización usada en este
 * navegador. Sin él se pinta primero el fondo claro y la paleta por defecto, y cambian medio segundo después.
 * Lee lo mismo que web/src/lib/hooks.ts (useTheme) y web/src/lib/theme.ts (cacheAppearance).
 */
(function () {
  try {
    var root = document.documentElement;
    var path = window.location.pathname;
    var authOrPublic = /^\/(login|register|forgot-password|reset-password|verify-email|invite|f)(\/|$)/.test(path);
    var cached = null;
    if (!authOrPublic) {
      try {
        cached = JSON.parse(localStorage.getItem('cortex-appearance') || 'null');
      } catch (e) {
        cached = null;
      }
    }
    var stored = localStorage.getItem('evolve-theme');
    var explicit = stored === 'light' || stored === 'dark' ? stored : stored === 'system' && localStorage.getItem('evolve-theme-explicit') === '1' ? 'system' : null;
    var orgDefault = cached && cached.a && /^(light|dark|system)$/.test(cached.a.defaultTheme) ? cached.a.defaultTheme : null;
    var theme = explicit || orgDefault || 'system';
    var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) root.classList.add('dark');
    root.style.colorScheme = dark ? 'dark' : 'light';
    if (cached && cached.vars && typeof cached.vars === 'object') {
      for (var k in cached.vars) {
        var v = cached.vars[k];
        // Solo variables CSS con valores sencillos (lo que guarda theme.ts: colores, radios, tipografías, espaciado).
        if (/^--[a-z0-9-]{1,60}$/.test(k) && typeof v === 'string' && v.length < 300 && !/[;{}<>]/.test(v)) root.style.setProperty(k, v);
      }
    }
  } catch (e) {
    /* sin almacenamiento: se aplica al cargar la aplicación */
  }
})();
