/* ============================================================
   Buggy — site behaviour
   No dependencies. Everything degrades when motion is reduced.
   ============================================================ */
'use strict';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

/* ------------------------------------------------------------
   Sticky nav + mobile menu
   ------------------------------------------------------------ */
(function nav() {
  const bar    = $('#nav');
  const burger = $('#burger');
  const menu   = $('#nav-mobile');
  if (!bar) return;

  const onScroll = () => bar.classList.toggle('is-stuck', window.scrollY > 8);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });

  if (!burger || !menu) return;

  const setOpen = (open) => {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menu.hidden = !open;
  };

  burger.addEventListener('click', () =>
    setOpen(burger.getAttribute('aria-expanded') !== 'true'));

  menu.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') setOpen(false);
  });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      burger.focus();
    }
  });
})();

/* ------------------------------------------------------------
   Scroll progress bar
   ------------------------------------------------------------ */
(function progress() {
  const bar = $('#scrollBar');
  if (!bar) return;

  let queued = false;
  const paint = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = (max > 0 ? (scrollY / max) * 100 : 0) + '%';
    queued = false;
  };

  addEventListener('scroll', () => {
    if (!queued) { queued = true; requestAnimationFrame(paint); }
  }, { passive: true });

  paint();
})();

/* ------------------------------------------------------------
   Reveal on scroll (staggered)
   ------------------------------------------------------------ */
(function reveals() {
  const items = $$('.reveal');
  if (!items.length) return;

  items.forEach((el) => {
    const d = el.dataset.revealDelay;
    if (d) el.style.setProperty('--reveal-delay', d);
  });

  if (REDUCED || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

  items.forEach((el) => io.observe(el));
})();

/* ------------------------------------------------------------
   Hero canvas — drifting proof lattice
   ------------------------------------------------------------ */
(function lattice() {
  const cv = $('#lattice');
  if (!cv) return;

  const ctx = cv.getContext('2d');
  if (!ctx) return;

  let w = 0, h = 0, dpr = 1, nodes = [], raf = 0, visible = true;

  const LINK   = 136;   // px distance under which two nodes connect
  const DENSITY = 15000; // one node per N css pixels

  function resize() {
    const rect = cv.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    cv.width  = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const target = Math.max(26, Math.min(74, Math.round((w * h) / DENSITY)));
    nodes = Array.from({ length: target }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.5 + 0.9,
      t: Math.random() * Math.PI * 2,
    }));
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);

    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy; n.t += 0.012;
      if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20;
      if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20;
    }

    // links
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        const alpha = (1 - Math.sqrt(d2) / LINK) * 0.3;
        ctx.strokeStyle = `rgba(83,224,166,${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // nodes
    for (const n of nodes) {
      const pulse = 0.55 + Math.sin(n.t) * 0.3;
      ctx.fillStyle = `rgba(140,220,255,${pulse.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  }

  function start() { if (!raf && visible && !REDUCED) raf = requestAnimationFrame(frame); }
  function stop()  { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  resize();

  if (REDUCED) {
    frame();      // one static frame
    stop();
  } else {
    start();
  }

  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); if (REDUCED) { frame(); stop(); } }, 160);
  });

  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    visible ? start() : stop();
  });

  // Stop burning cycles once the hero is scrolled past.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting && !document.hidden;
      visible ? start() : stop();
    }, { threshold: 0 }).observe(cv);
  }
})();

/* ------------------------------------------------------------
   Terminal typewriter + certificate ticks
   ------------------------------------------------------------ */
(function terminal() {
  const out   = $('#termOut');
  const caret = $('#caret');
  const cert  = $('#cert');
  const term  = $('#term');
  if (!out) return;

  const S = (text, cls) => ({ text, cls });
  const PAUSE = (ms) => ({ pause: ms });

  const script = [
    S('$ ', 'dim'), S("buggy investigate budget_usage -f budget.py\n", 'hl'),
    PAUSE(380),
    S('\n'),
    S('  budget_usage  '), S('(budget.py)\n', 'dim'),
    PAUSE(200),
    S('  ─────────────────────────────────────\n', 'dim'),
    S('  status  '), S('proven\n', 'ok'),
    PAUSE(260),
    S('\n  Certificate of failure\n', 'hl'),
    S('    input      '), S('[0, 0]\n', 'warn'),
    S('    broke      '), S('must not raise ZeroDivisionError\n', 'key'),
    S('    detail     '), S('ZeroDivisionError: division by zero\n', 'bad'),
    PAUSE(340),
    S('    ✓ admissible    '), S('the input satisfied every precondition\n', 'dim'),
    PAUSE(220),
    S('    ✓ sound         '), S('re-observed in a fresh process\n', 'dim'),
    PAUSE(220),
    S('    ✓ reproduced    '), S('3/3 re-runs failed identically\n', 'dim'),
    PAUSE(380),
    S('\n  Call it yourself to see it fail:\n', 'hl'),
    S('    budget_usage(0, 0)\n', 'key'),
  ];

  // Reduced motion: render it all at once, no typing.
  if (REDUCED) {
    out.innerHTML = script
      .filter((s) => s.text)
      .map((s) => (s.cls ? `<span class="${s.cls}">${esc(s.text)}</span>` : esc(s.text)))
      .join('');
    cert && cert.classList.add('is-on');
    $$('.cert__list li').forEach((li) => li.classList.add('is-on'));
    return;
  }

  let html = '';
  let tokenIdx = 0;
  let charIdx = 0;
  let started = false;

  function esc(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function tick() {
    if (tokenIdx >= script.length) return finish();

    const token = script[tokenIdx];

    if (token.pause !== undefined) {
      tokenIdx++;
      return setTimeout(tick, token.pause);
    }

    const ch = token.text[charIdx];
    const open  = token.cls && charIdx === 0 ? `<span class="${token.cls}">` : '';
    const close = token.cls && charIdx === token.text.length - 1 ? '</span>' : '';

    html += open + esc(ch) + close;
    out.innerHTML = html;
    charIdx++;

    if (charIdx >= token.text.length) { tokenIdx++; charIdx = 0; }

    // Newlines get a beat; everything else types fast.
    setTimeout(tick, ch === '\n' ? 26 : 9);
  }

  function finish() {
    caret && caret.remove();
    if (!cert) return;
    cert.classList.add('is-on');
    $$('.cert__list li').forEach((li, i) =>
      setTimeout(() => li.classList.add('is-on'), 180 + i * 220));
  }

  function begin() {
    if (started) return;
    started = true;
    setTimeout(tick, 420);
  }

  if ('IntersectionObserver' in window && term) {
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { begin(); io.disconnect(); }
    }, { threshold: 0.25 });
    io.observe(term);
  } else {
    begin();
  }
})();

/* ------------------------------------------------------------
   Animated counters
   ------------------------------------------------------------ */
(function counters() {
  const els = $$('.count');
  if (!els.length) return;

  const fmt = (n) => n.toLocaleString('en-US');

  const run = (el) => {
    const to = Number(el.dataset.to || 0);
    if (REDUCED) { el.textContent = fmt(to); return; }

    const dur = 1250;
    const t0 = performance.now();

    const step = (now) => {
      const p = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);          // easeOutCubic
      el.textContent = fmt(Math.round(to * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  if (REDUCED || !('IntersectionObserver' in window)) { els.forEach(run); return; }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      run(entry.target);
      io.unobserve(entry.target);
    });
  }, { threshold: 0.5 });

  els.forEach((el) => io.observe(el));
})();

/* ------------------------------------------------------------
   Pipeline — ARIA tabs with autoplay
   ------------------------------------------------------------ */
(function pipeline() {
  const root = $('#pipe');
  if (!root) return;

  const tabs   = $$('.pipe__tab', root);
  const panels = $$('.pipe__panel', root);
  const fill   = $('#pipeFill');
  if (!tabs.length) return;

  let current = 0;
  let timer = 0;
  let auto = !REDUCED;

  function select(index, focus) {
    current = (index + tabs.length) % tabs.length;

    tabs.forEach((tab, i) => {
      const on = i === current;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });

    panels.forEach((panel, i) => {
      const on = i === current;
      panel.classList.toggle('is-active', on);
      panel.hidden = !on;
    });

    if (fill) {
      const pct = 100 / tabs.length;
      fill.style.width = pct + '%';
      fill.style.transform = `translateX(${current * 100}%)`;
    }

    if (focus) tabs[current].focus();
  }

  function schedule() {
    clearTimeout(timer);
    if (!auto) return;
    timer = setTimeout(() => { select(current + 1); schedule(); }, 4200);
  }

  function stopAuto() { auto = false; clearTimeout(timer); }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => { stopAuto(); select(i); });

    tab.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (keys[e.key]) {
        e.preventDefault(); stopAuto(); select(current + keys[e.key], true);
      } else if (e.key === 'Home') {
        e.preventDefault(); stopAuto(); select(0, true);
      } else if (e.key === 'End') {
        e.preventDefault(); stopAuto(); select(tabs.length - 1, true);
      }
    });
  });

  root.addEventListener('mouseenter', () => clearTimeout(timer));
  root.addEventListener('mouseleave', schedule);
  root.addEventListener('focusin', stopAuto);

  select(0);

  // Only autoplay while the section is actually on screen.
  if (auto && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      entries[0].isIntersecting ? schedule() : clearTimeout(timer);
    }, { threshold: 0.3 }).observe(root);
  }
})();

/* ------------------------------------------------------------
   Usage tabs — ARIA tabs
   ------------------------------------------------------------ */
(function usageTabs() {
  const list = $('.tabs__list');
  if (!list) return;

  const tabs   = $$('.tabs__btn');
  const panels = $$('.tabs__panel');
  let current = 0;

  function select(index, focus) {
    current = (index + tabs.length) % tabs.length;

    tabs.forEach((tab, i) => {
      const on = i === current;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });

    panels.forEach((panel, i) => {
      const on = i === current;
      panel.classList.toggle('is-active', on);
      panel.hidden = !on;
    });

    if (focus) tabs[current].focus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i));
    tab.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1 };
      if (keys[e.key]) { e.preventDefault(); select(current + keys[e.key], true); }
      else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
      else if (e.key === 'End')  { e.preventDefault(); select(tabs.length - 1, true); }
    });
  });

  select(0);
})();

/* ------------------------------------------------------------
   Copy-to-clipboard
   ------------------------------------------------------------ */
(function copy() {
  const toast = $('#toast');
  let toastTimer = 0;

  const flash = (msg) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1900);
  };

  async function write(text) {
    if (navigator.clipboard && isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Fallback for non-secure contexts (e.g. plain http preview).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const block = btn.closest('.code');
      const code = block && block.querySelector('code');
      if (!code) return;

      // Strip comment lines so what you paste actually runs.
      const text = code.innerText
        .split('\n')
        .filter((line) => !/^\s*(\/\/|#)/.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      try {
        await write(text);
        const label = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('is-done');
        flash('Copied to clipboard');
        setTimeout(() => { btn.textContent = label; btn.classList.remove('is-done'); }, 1600);
      } catch {
        flash('Copy failed — select the text manually');
      }
    });
  });
})();

/* ------------------------------------------------------------
   Subtle pointer tilt on feature cards
   ------------------------------------------------------------ */
(function tilt() {
  if (REDUCED || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  $$('[data-tilt]').forEach((card) => {
    let frame = 0;

    const move = (e) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width  - 0.5;
        const py = (e.clientY - r.top)  / r.height - 0.5;
        card.style.transform =
          `perspective(850px) rotateY(${(px * 5).toFixed(2)}deg) rotateX(${(-py * 5).toFixed(2)}deg) translateY(-3px)`;
        frame = 0;
      });
    };

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      card.style.transform = '';
    };

    card.addEventListener('pointermove', move);
    card.addEventListener('pointerleave', reset);
  });
})();

/* ------------------------------------------------------------
   Active section highlight in the nav
   ------------------------------------------------------------ */
(function activeLink() {
  if (!('IntersectionObserver' in window)) return;

  const links = new Map();
  $$('.nav__links a[href^="#"]').forEach((a) => {
    const target = document.getElementById(a.hash.slice(1));
    if (target) links.set(target, a);
  });
  if (!links.size) return;

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const link = links.get(entry.target);
      if (!link) return;
      if (entry.isIntersecting) {
        links.forEach((l) => l.removeAttribute('aria-current'));
        link.setAttribute('aria-current', 'true');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });

  links.forEach((_link, section) => io.observe(section));
})();
