// Cortex CRM — web del proyecto: menú móvil, apariciones al hacer scroll y peticiones de ejemplo que rotan.
(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Menú móvil
  var header = document.getElementById('cabecera');
  var button = header && header.querySelector('.menu-button');
  if (button) {
    var setOpen = function (open) {
      header.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Cerrar el menú' : 'Abrir el menú');
    };
    button.addEventListener('click', function () {
      setOpen(!header.classList.contains('is-open'));
    });
    header.querySelectorAll('.nav-links a').forEach(function (a) {
      a.addEventListener('click', function () {
        setOpen(false);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.classList.contains('is-open')) {
        setOpen(false);
        button.focus();
      }
    });
  }

  // Apariciones al hacer scroll
  var items = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    items.forEach(function (el) {
      el.classList.add('is-visible');
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    items.forEach(function (el) {
      io.observe(el);
    });
  }

  // Peticiones de ejemplo en la barra del hero (decorativa: aria-hidden)
  var prompt = document.querySelector('.prompt-text');
  if (prompt && !reduceMotion) {
    var list = [];
    try {
      list = JSON.parse(prompt.getAttribute('data-prompts') || '[]');
    } catch (e) {
      list = [];
    }
    var i = 0;
    if (list.length > 1) {
      setInterval(function () {
        if (document.hidden) return;
        prompt.classList.add('is-changing');
        setTimeout(function () {
          i = (i + 1) % list.length;
          prompt.textContent = list[i];
          prompt.classList.remove('is-changing');
        }, 350);
      }, 3600);
    }
  }
})();
