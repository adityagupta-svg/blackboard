/* ===== Blackboard Partner Website — lead-form.js =====
 *
 * Thin client for the "Become a Partner" lead form. Collects the fields, posts
 * them as JSON to our own POST /api/lead, and shows a success state. All
 * Salesforce specifics (the guest Apex REST endpoint, the Lead shape) live in
 * server.js — this module only knows the form's own field ids and the small
 * { ok, leadId } / { ok, error } contract of /api/lead.
 *
 * Element id contract (owned by the markup, not by this file):
 *   #leadForm, #leadFirstName, #leadLastName, #leadCompany, #leadEmail,
 *   #leadPhone, #leadCountry, #leadTier, #leadMessage, #leadWebsiteUrl,
 *   #leadSubmit, #leadError, #leadSuccess
 *
 * #leadWebsiteUrl is a honeypot: a field no human visitor can see or fill in.
 * It is collected and sent exactly like every other field — detecting or
 * short-circuiting on it here would just teach a bot what to avoid. Apex
 * decides what to do with it.
 */
(function () {
    function fieldValue(id) {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    }

    async function submitLead(payload) {
        const resp = await fetch('/api/lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        let data = null;
        try {
            data = await resp.json();
        } catch {
            // Fall through to the generic message below.
        }

        if (!resp.ok || !data || !data.ok) {
            throw new Error((data && data.error) || 'We could not submit your application. Please try again.');
        }
        return data;
    }

    function initForm() {
        const form = document.getElementById('leadForm');
        if (!form) {
            return;
        }
        const submitBtn = document.getElementById('leadSubmit');
        const errorEl = document.getElementById('leadError');
        const successEl = document.getElementById('leadSuccess');

        let submitting = false;

        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            // Guard against double-submit.
            if (submitting) {
                return;
            }

            const payload = {
                firstName: fieldValue('leadFirstName'),
                lastName: fieldValue('leadLastName'),
                company: fieldValue('leadCompany'),
                email: fieldValue('leadEmail'),
                phone: fieldValue('leadPhone'),
                country: fieldValue('leadCountry'),
                tier: fieldValue('leadTier'),
                message: fieldValue('leadMessage'),
                websiteUrl: fieldValue('leadWebsiteUrl') // honeypot — collected untouched
            };

            submitting = true;
            if (errorEl) {
                errorEl.hidden = true;
                errorEl.textContent = '';
            }
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting…';
            }

            try {
                await submitLead(payload);
                form.hidden = true;
                if (successEl) {
                    successEl.hidden = false;
                }
                // Left disabled: the form is now hidden, so there is nothing
                // left to resubmit.
            } catch (err) {
                submitting = false;
                if (errorEl) {
                    errorEl.textContent = err.message;
                    errorEl.hidden = false;
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit';
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
