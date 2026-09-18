/* =====================================================================
   Blackboard Integration Partnership Program — main.js
   Owns: sticky header behaviour, mobile nav toggle, FAQ accordion,
   and opening/closing the shared login modal (focus trap, Escape to
   close, restore focus on close).

   Does NOT perform the login network call — that is headless-login.js,
   written separately. This file only shows/hides the modal and manages
   focus; headless-login.js listens for its own form submit event.
   ===================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------
     Sticky header — add a shadow once the page has scrolled past
     the top, same threshold pattern used across the site family.
     --------------------------------------------------------------- */
  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------------------------------------------------------------
     Mobile nav toggle
     --------------------------------------------------------------- */
  var hamburger = document.getElementById('navHamburger');
  var mobileNav = document.getElementById('mobileNav');

  function closeMobileNav() {
    if (!mobileNav || !hamburger) return;
    mobileNav.classList.remove('is-open');
    hamburger.classList.remove('is-open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  function openMobileNav() {
    if (!mobileNav || !hamburger) return;
    mobileNav.classList.add('is-open');
    hamburger.classList.add('is-open');
    hamburger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  if (hamburger && mobileNav) {
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.addEventListener('click', function () {
      var isOpen = mobileNav.classList.contains('is-open');
      if (isOpen) {
        closeMobileNav();
      } else {
        openMobileNav();
      }
    });

    mobileNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeMobileNav);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mobileNav.classList.contains('is-open')) {
        closeMobileNav();
        hamburger.focus();
      }
    });
  }

  /* ---------------------------------------------------------------
     FAQ accordion — accessible: aria-expanded on the trigger,
     keyboard operable (native <button>, so Enter/Space work for free),
     animates max-height, single-item-open is NOT enforced (each
     question is independent, matching blackboard.com's own FAQ).
     --------------------------------------------------------------- */
  document.querySelectorAll('.faq-question').forEach(function (btn) {
    var answerId = btn.getAttribute('aria-controls');
    var answer = answerId ? document.getElementById(answerId) : null;
    if (!answer) return;

    btn.setAttribute('aria-expanded', 'false');
    answer.style.maxHeight = '0px';

    btn.addEventListener('click', function () {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      var next = !expanded;
      btn.setAttribute('aria-expanded', String(next));
      answer.style.maxHeight = next ? answer.scrollHeight + 'px' : '0px';
    });
  });

  /* Recalculate open FAQ heights on resize (fluid type scale can
     reflow answer text and change its natural height). */
  window.addEventListener('resize', function () {
    document.querySelectorAll('.faq-question[aria-expanded="true"]').forEach(function (btn) {
      var answer = document.getElementById(btn.getAttribute('aria-controls'));
      if (answer) answer.style.maxHeight = answer.scrollHeight + 'px';
    });
  });

  /* ---------------------------------------------------------------
     Login modal — open/close, focus trap, Escape to close, restore
     focus to the element that opened it. The actual authentication
     POST is wired up separately in headless-login.js via the
     loginForm's submit event; this module never calls the network.
     --------------------------------------------------------------- */
  var loginModal = document.getElementById('loginModal');
  var loginModalBackdrop = loginModal ? loginModal.querySelector('.login-modal-backdrop') : null;
  var loginClose = document.getElementById('loginClose');
  var loginUsername = document.getElementById('loginUsername');
  var lastFocusedBeforeModal = null;

  function getFocusableInModal() {
    if (!loginModal) return [];
    return Array.prototype.slice.call(
      loginModal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(function (el) { return el.offsetParent !== null; });
  }

  function openLoginModal(triggerEl) {
    if (!loginModal) return;
    lastFocusedBeforeModal = triggerEl || document.activeElement;
    loginModal.classList.add('is-open');
    loginModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var errorBox = document.getElementById('loginError');
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = '';
    }
    window.setTimeout(function () {
      if (loginUsername) loginUsername.focus();
    }, 10);
  }

  function closeLoginModal() {
    if (!loginModal) return;
    loginModal.classList.remove('is-open');
    loginModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      lastFocusedBeforeModal.focus();
    }
    lastFocusedBeforeModal = null;
  }

  document.querySelectorAll('.js-login-trigger').forEach(function (trigger) {
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      openLoginModal(trigger);
    });
  });

  if (loginClose) {
    loginClose.addEventListener('click', closeLoginModal);
  }
  if (loginModalBackdrop) {
    loginModalBackdrop.addEventListener('click', closeLoginModal);
  }

  document.addEventListener('keydown', function (e) {
    if (!loginModal || !loginModal.classList.contains('is-open')) return;

    if (e.key === 'Escape') {
      closeLoginModal();
      return;
    }

    if (e.key === 'Tab') {
      var focusable = getFocusableInModal();
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  /* Expose open/close for headless-login.js (e.g. to close the modal
     itself on a successful login) without it needing to know the
     modal's internal class-toggling details. */
  window.BbLoginModal = {
    open: openLoginModal,
    close: closeLoginModal
  };
})();

/* ---- Scroll reveal ---------------------------------------------------------
 * Fades blocks in as they enter the viewport. Deliberately fails OPEN: the
 * .reveal class starts elements at opacity 0, so if IntersectionObserver is
 * missing (or this script never runs) the content would be permanently
 * invisible. Both guards below reveal everything immediately instead.
 * prefers-reduced-motion is handled in CSS, which forces .reveal visible. */
(function () {
  var nodes = document.querySelectorAll('.reveal');
  if (!nodes.length) { return; }

  function revealAll() {
    nodes.forEach(function (el) { el.classList.add('is-visible'); });
  }

  if (!('IntersectionObserver' in window)) { revealAll(); return; }

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealAll();
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });

  nodes.forEach(function (el) { observer.observe(el); });
})();

/* ---- App Catalog tier filter ----------------------------------------------
 * Progressive enhancement: the markup ships every card visible, so with JS off
 * the catalogue is still a complete, readable list — the chips simply do nothing.
 * Filtering uses the [hidden] attribute (plus a CSS rule, since display:flex on
 * .app-card would otherwise beat the UA's [hidden] { display: none }), which
 * keeps hidden cards out of the accessibility tree rather than just out of sight. */
(function () {
  var grid = document.getElementById('appGrid');
  if (!grid) { return; }

  var chips = document.querySelectorAll('.filter-chip');
  var cards = grid.querySelectorAll('.app-card');
  var empty = document.getElementById('appEmpty');

  function apply(filter) {
    var shown = 0;
    cards.forEach(function (card) {
      var match = filter === 'all' || card.getAttribute('data-category') === filter;
      card.hidden = !match;
      if (match) { shown++; }
    });
    if (empty) { empty.hidden = shown !== 0; }
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) {
        var active = c === chip;
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      apply(chip.getAttribute('data-filter'));
    });
  });
})();
