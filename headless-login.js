/* ===== Blackboard Partner Website — headless-login.js =====
 *
 * Thin client for the "Client Login" modal. The entire Salesforce login flow
 * lives in server.js: this module posts the entered credentials to our own
 * POST /api/login and navigates to the single-use frontdoor_uri it returns,
 * which drops the visitor straight into the Partner Hub dashboard, already
 * logged in.
 *
 * Nothing Salesforce-specific belongs here — no OAuth endpoints, no scopes, no
 * client id. That is deliberate: calling Salesforce's OAuth endpoints directly
 * from page JS would need a CORS allowlist entry, would expose a web-scoped
 * access token to page JS, and still wouldn't work end-to-end anyway, because
 * /services/oauth2/singleaccess (the last leg) does not support CORS at all.
 * See server.js and README.md "How login works".
 *
 * Element id contract (owned by the markup, not by this file):
 *   #loginForm, #loginUsername, #loginPassword, #loginSubmit, #loginError
 */
(function () {
    async function login(username, password) {
        const resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        let data = null;
        try {
            data = await resp.json();
        } catch {
            // Fall through to the generic message below.
        }

        if (!resp.ok || !data || !data.frontdoor_uri) {
            throw new Error((data && data.error) || 'Could not complete login. Please try again.');
        }
        return data.frontdoor_uri;
    }

    function initForm() {
        const form = document.getElementById('loginForm');
        if (!form) {
            return;
        }
        const usernameEl = document.getElementById('loginUsername');
        const passwordEl = document.getElementById('loginPassword');
        const submitBtn = document.getElementById('loginSubmit');
        const errorEl = document.getElementById('loginError');

        let submitting = false;

        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            // Guard against double-submit (e.g. a fast double click, or Enter
            // pressed while the first request is still in flight).
            if (submitting) {
                return;
            }

            const username = usernameEl ? usernameEl.value.trim() : '';
            const password = passwordEl ? passwordEl.value : '';
            if (!username || !password) {
                return;
            }

            submitting = true;
            if (errorEl) {
                errorEl.hidden = true;
                errorEl.textContent = '';
            }
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Signing in…';
            }

            try {
                const frontdoorUri = await login(username, password);
                // Single-use and valid for only about a minute — navigate
                // immediately, and leave the button disabled: the page is
                // navigating away, so there is nothing left for the user to do.
                window.location.href = frontdoorUri;
            } catch (err) {
                submitting = false;
                if (passwordEl) {
                    passwordEl.value = '';
                }
                if (errorEl) {
                    errorEl.textContent = err.message;
                    errorEl.hidden = false;
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Log In';
                }
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initForm);
    } else {
        initForm();
    }
})();
