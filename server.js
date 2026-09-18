/* Local/production Node server for the Blackboard Integration Partner marketing site.
 *
 * Serves the static files AND owns the entire Salesforce login flow behind one API
 * route, POST /api/login, plus the lead-capture relay, POST /api/lead. The browser
 * never talks to Salesforce directly.
 *
 * Why the login flow lives server-side rather than in the browser (same reasoning
 * as the FSC reference implementation this file mirrors, primary-capital-website/server.js):
 *   - /services/oauth2/singleaccess (the last leg) does NOT support CORS at all. It
 *     is not on Salesforce's CORS-enabled OAuth endpoint list, so it can only ever
 *     be called server-to-server. A backend is mandatory anyway.
 *   - Doing the earlier legs here too means no CORS allowlist entry and no "Enable
 *     CORS for OAuth endpoints" master switch to misconfigure.
 *   - The web-scoped access token never reaches the browser.
 *   - The Salesforce host is a server-side constant — no caller can point this
 *     server at an arbitrary host and have it relay a bearer token there.
 *
 * Flow (see README.md "How login works" for the sequence diagram):
 *   1. POST /services/oauth2/authorize — Basic auth = username:password,
 *      Auth-Request-Type: Named-User, response_type=code_credentials, PKCE.
 *      Salesforce validates the credentials and returns { code }.
 *   2. POST /services/oauth2/token     — code + PKCE code_verifier -> access_token.
 *   3. GET  /services/oauth2/singleaccess — Single Access UI Bridge API. Exchanges
 *      the access token for a one-time, ~1-minute frontdoor_uri that logs the
 *      browser into the real portal UI. Requires the token to carry the `web`
 *      (or `full`) OAuth scope, and a RELATIVE redirect_uri.
 *
 * No dependencies beyond Node's built-ins (Node 18+, for global fetch).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5500;

/* Where the site's files actually live at runtime.
 *
 * `public/` is the one layout that works in both places at once:
 *   - Locally, this server reads the files from it directly.
 *   - On Vercel, `server.js` is auto-detected as a Node backend entrypoint and
 *     bundled into a single function. That bundle contains only the JS reachable
 *     by require() — never the HTML/CSS/assets — which is why the first deploy
 *     404'd on every page. Vercel serves `public/` from the CDN automatically,
 *     so those requests now never reach this function at all.
 *
 * Kept as a probe rather than a constant so a host that relocates the entrypoint
 * away from the site files still finds them instead of 404ing everything. */
const ROOT_CANDIDATES = [
    path.join(__dirname, 'public'),
    path.join(process.cwd(), 'public'),
    __dirname
];

const ROOT = (() => {
    for (const candidate of ROOT_CANDIDATES) {
        try {
            if (fs.existsSync(path.join(candidate, 'index.html'))) {
                return candidate;
            }
        } catch (_) { /* unreadable candidate is simply not the root */ }
    }
    // Nothing matched. Keep the conventional path so behaviour is unchanged, but say
    // so loudly — a silent fallback here is what makes this class of bug hard to find.
    console.error(
        '[startup] Could not locate index.html in any of: ' + ROOT_CANDIDATES.join(', ')
        + '. Static files will 404. __dirname=' + __dirname + ' cwd=' + process.cwd()
    );
    return path.join(__dirname, 'public');
})();

/* ---- Salesforce configuration -------------------------------------------
 * Server-side only. These deliberately do NOT come from the page — a route that
 * accepted the target host from the request body would let any caller relay an
 * access token anywhere.
 *
 * All of these (except SF_CLIENT_ID) have defaults that are the verified facts
 * for the BlackBoarDemo scratch org, probed live during planning. They are
 * defaults, not constants: set the env var to point this server at a different
 * org, and update SF_CLIENT_ID (no default — see below) to match.
 */

// Origin of the Experience Cloud site, no trailing slash, no site path.
const SF_ORIGIN = process.env.SF_ORIGIN
    || 'https://agility-power-1332-dev-ed.scratch.my.site.com';

/* The Experience Cloud site's browsable URL path prefix — "partnerhub", NOT the
 * "partnerhubvforcesite" prefix the Network metadata's <urlPathPrefix> stores.
 * That belongs to the auto-generated Visualforce-hosting companion site. All
 * three OAuth calls (authorize, token, singleaccess) go to the browsable prefix;
 * only the registered callback URL (below) uses the vforcesite form. Mixing the
 * two up is the single most common setup failure for this flow.
 */
const SF_SITE_PATH = process.env.SF_SITE_PATH || 'partnerhub';

const SF_SITE_URL = `${SF_ORIGIN}/${SF_SITE_PATH}`;

/* Must match the Callback URL registered on the External Client App byte for
 * byte, or Salesforce answers redirect_uri_mismatch. It is registered under the
 * "vforcesite" prefix on this org (see SF_SITE_PATH above for why that prefix is
 * NOT what the OAuth calls themselves use). This value is NEVER navigated to —
 * Salesforce answers the authorization code via its own internal "echo" handling
 * for the Authorization Code and Credentials flow, not a real browser redirect.
 */
const SF_CALLBACK_URL = process.env.SF_CALLBACK_URL
    || `${SF_ORIGIN}/partnerhubvforcesite/services/oauth2/echo`;

/* Space-separated, per the OAuth spec and Salesforce's own docs — commas do not
 * work. `web` is what /singleaccess checks for; without it that call fails with
 * Invalid_Scope. Every scope listed here must also be selected on the External
 * Client App itself — requesting a scope the app doesn't have makes Salesforce
 * stop treating the request as headless and answer an HTML login page instead.
 */
const SF_SCOPES = process.env.SF_SCOPES || 'openid api web';

/* The LWR route the visitor lands on, appended to the site prefix. Empty by
 * design here: the Partner Hub's portal HOME forwards a signed-in visitor to the
 * dashboard on its own, so there is no route name to hardcode (and nothing to
 * keep in sync if that forwarding route is ever renamed).
 */
const SF_LANDING_ROUTE = process.env.SF_LANDING_ROUTE || '';

/* Consumer Key of the External Client App "Blackboard_Partner_Website", issued by
 * the org named in SF_ORIGIN. Deliberately has NO default and NO fallback — a
 * hardcoded key here would either be a secret committed to source (this flow is a
 * public client, PKCE-only, so the key itself isn't sensitive, but it is still
 * per-org and per-environment) or, worse, a stale key from a different org that
 * fails with a misleading error (a key from the wrong org answers
 * redirect_uri_mismatch or invalid_client_id, NOT "wrong org", so silently
 * running with the wrong default is actively confusing). Fail loudly at startup
 * instead. Read the live value from Setup -> External Client App Manager ->
 * Blackboard_Partner_Website -> Settings -> OAuth -> Manage Consumer Details,
 * after the metadata deploys.
 */
const SF_CLIENT_ID = process.env.SF_CLIENT_ID || '';

const MISSING_CLIENT_ID_MESSAGE =
    '[startup] SF_CLIENT_ID is not set. Copy it from Setup -> External Client App Manager -> '
    + 'Blackboard_Partner_Website -> Settings -> OAuth -> Manage Consumer Details. Locally that '
    + 'goes in .env; on Vercel it is a Project Settings -> Environment Variables entry, because '
    + '.env is gitignored and never reaches the deploy.';

/* Running standalone (npm run dev) we still fail loudly and immediately: a missing
 * client id turns every login into a confusing Salesforce error instead of one clear
 * one. But on a serverless host the same process.exit() aborts the whole invocation,
 * so a missing variable takes down the MARKETING PAGES too and surfaces as an opaque
 * FUNCTION_INVOCATION_FAILED. There, stay up and fail only /api/login — a visitor can
 * still read the tiers and submit the lead form. */
if (!SF_CLIENT_ID) {
    console.error(MISSING_CLIENT_ID_MESSAGE);
    // Exit only on a developer's own machine. On a hosted deploy (Vercel sets VERCEL=1)
    // this same exit takes the whole site down and surfaces as an opaque platform error,
    // so there we stay up, serve the marketing pages, and fail only /api/login.
    if (require.main === module && !process.env.VERCEL) {
        process.exit(1);
    }
}

/* Full URL of the guest Apex REST endpoint that creates the Lead. A complete URL
 * rather than assembled path segments — this org's guest Site prefix and Apex
 * namespace were confirmed live during planning (see the work-stream README), so
 * there is nothing left to derive and one env var is simplest to get right.
 */
const SF_LEAD_ENDPOINT = process.env.SF_LEAD_ENDPOINT
    || 'https://agility-power-1332-dev-ed.scratch.my.site.com/services/apexrest/Chgon/bb/v1/lead';

/* The token response carries `sfdc_community_url` — Salesforce's own answer for
 * where this user's Experience Cloud site lives. Trust it over our configured
 * guess for the UI bridge call, so a mismatched site path prefix can't produce a
 * Wrong_Org / No_Access failure. Falls back to the configured URL if absent. */
function resolveSiteUrl(tokenResult) {
    const fromToken = tokenResult && tokenResult.sfdc_community_url;
    if (!fromToken) {
        return SF_SITE_URL;
    }
    return fromToken.replace(/\/+$/, '');
}

/* singleaccess requires a RELATIVE path (an absolute URL returns Invalid_Param),
 * resolved from the domain root — so it must include the site's path prefix. */
function buildLandingPath(siteUrl) {
    let prefix = new URL(siteUrl).pathname.replace(/^\/+|\/+$/g, '');
    // If Salesforce hands back the Visualforce-companion prefix, fold it to the
    // browsable one — LWR routes only exist under the short form.
    prefix = prefix.replace(/vforcesite$/, '');
    const route = SF_LANDING_ROUTE.replace(/^\/+|\/+$/g, '');
    if (!route) {
        return prefix || '/';
    }
    return prefix ? `${prefix}/${route}` : route;
}

/* ---- Static file serving --------------------------------------------------- */

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

// Files that live in this folder but must never be served over HTTP. Blocking
// traversal out of the root is not enough on its own: .env sits INSIDE the root,
// and serving it would hand every visitor the org's Consumer Key. server.js is
// listed for the same reason its source has no business being public, and it
// cannot be excluded by extension because the three browser modules are .js too.
const PRIVATE_FILES = new Set([
    'server.js',
    'package.json',
    'package-lock.json',
    'vercel.json',
    'readme.md'
]);

function isPrivatePath(requestPath) {
    const segments = requestPath.split('/').filter(Boolean);
    // Any dotfile, at any depth: .env, .env.example, .gitignore, .git/...
    if (segments.some((segment) => segment.startsWith('.'))) {
        return true;
    }
    return segments.length === 1 && PRIVATE_FILES.has(segments[0].toLowerCase());
}

function serveStatic(req, res) {
    let requestPath = decodeURIComponent(req.url.split('?')[0]);
    if (requestPath === '/') {
        requestPath = '/index.html';
    }
    const filePath = path.join(ROOT, requestPath);

    // Prevent path traversal outside the site root (e.g. /../server.js).
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    // ...and prevent serving the private files that legitimately live inside it.
    if (isPrivatePath(requestPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

/* ---- Body parsing ----------------------------------------------------------- */

// Shared by both POST routes. maxBytes lets /api/lead enforce a tighter cap than
// the default while still sharing one implementation.
function readJsonBody(req, maxBytes) {
    const limit = maxBytes || 65536;
    return new Promise((resolve, reject) => {
        let raw = '';
        let tooLarge = false;
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > limit) {
                tooLarge = true;
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooLarge) {
                reject(new Error('body_too_large'));
                return;
            }
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                // Malformed JSON must produce a 400, not an uncaught throw that
                // takes the request handler down.
                reject(new Error('malformed_json'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function base64Url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair() {
    const codeVerifier = base64Url(crypto.randomBytes(64));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
}

/* ---- Outbound calls to Salesforce ------------------------------------------
 *
 * A small timeout on every call: without one, a stalled Salesforce connection
 * (or a firewall that silently drops the packet instead of refusing it) hangs
 * the request indefinitely and the visitor is left staring at a spinner with no
 * way to know whether to wait or retry.
 */
const SF_FETCH_TIMEOUT_MS = Number(process.env.SF_FETCH_TIMEOUT_MS || '15000');

class UpstreamUnavailableError extends Error {
    constructor(label, cause) {
        super('Could not reach the login service. Please try again in a moment.');
        this.name = 'UpstreamUnavailableError';
        this.isNetwork = true;
        this.label = label;
        this.cause = cause;
    }
}

// One timeout policy for every Salesforce call. An HTTP error response (4xx/5xx)
// is NOT a transport failure — it is a real answer from Salesforce and is handled
// by the caller, not here.
async function sfFetch(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SF_FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        const cause = err.cause || err;
        console.error(`[${label}] transport error: ${cause.code || err.message}`);
        throw new UpstreamUnavailableError(label, cause);
    } finally {
        clearTimeout(timer);
    }
}

async function readResponse(resp) {
    const raw = await resp.text();
    let data = null;
    try {
        data = JSON.parse(raw);
    } catch {
        // Salesforce returns an HTML login page when it stops treating a request
        // as headless — keep the raw text so that shows up in the logs.
    }
    return { data, raw };
}

/* Salesforce reports failures in several shapes: OAuth's {error, error_description},
 * the UI Bridge API's {error} codes (Invalid_Scope, Invalid_Param, Bad_OAuth_Token,
 * Missing_OAuth_Token, No_Access, Wrong_Org), or a bare HTML login page. Surface
 * whichever we got, in the server log, rather than flattening everything. */
function describeFailure(step, resp, data, raw) {
    if (data && (data.error_description || data.error)) {
        const code = data.error && data.error_description ? ` [${data.error}]` : '';
        return `${step}: ${data.error_description || data.error}${code}`;
    }
    if (/<html/i.test(raw || '')) {
        return `${step}: Salesforce returned an HTML login page (HTTP ${resp.status}) instead of a headless `
            + 'response — the request was not accepted as headless. Check that every scope in SF_SCOPES is '
            + 'selected on the External Client App, that credentials-in-body is NOT required (this server sends '
            + 'them in the Authorization header), and that "Allow Authorization Code and Credentials Flows" is on.';
    }
    return `${step}: HTTP ${resp.status} ${(raw || '').trim().slice(0, 300)}`;
}

// Leg 1 — exchange the user's credentials for an authorization code.
// Credentials go in the Authorization header, never the POST body: the External
// Client App is configured with "Require user credentials in the POST body"
// UNCHECKED, so a body-based credential would simply be ignored and the request
// would fall back to interactive login (an HTML page, not a headless response).
async function requestAuthorizationCode(username, password, codeChallenge) {
    const body = new URLSearchParams({
        response_type: 'code_credentials',
        client_id: SF_CLIENT_ID,
        redirect_uri: SF_CALLBACK_URL,
        code_challenge: codeChallenge,
        scope: SF_SCOPES
    });

    const resp = await sfFetch(`${SF_SITE_URL}/services/oauth2/authorize`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Auth-Request-Type': 'Named-User',
            'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
        },
        body: body.toString()
    }, 'login/authorize');

    const { data, raw } = await readResponse(resp);
    console.log(`[login] authorize -> ${resp.status}`, data ? Object.keys(data).join(',') : raw.slice(0, 300));
    if (!resp.ok || !data || !data.code) {
        // Only invalid_grant means the credentials themselves were rejected.
        // Every other 400 here is a misconfiguration (wrong client id, wrong
        // callback, disabled flow) and must NOT be reported to the visitor as a
        // bad password — that sends them re-typing a password that was fine.
        if (resp.status === 400 && data && data.error === 'invalid_grant') {
            throw new Error('Invalid username or password.');
        }
        throw new Error(describeFailure('Authorization request failed', resp, data, raw));
    }
    return data;
}

// Leg 2 — exchange the authorization code for an access token.
async function requestAccessToken(code, codeVerifier) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: SF_CLIENT_ID,
        redirect_uri: SF_CALLBACK_URL,
        code_verifier: codeVerifier
    });

    const resp = await sfFetch(`${SF_SITE_URL}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    }, 'login/token');

    const { data, raw } = await readResponse(resp);
    console.log(`[login] token -> ${resp.status} scope="${(data && data.scope) || ''}"`
        + ` sfdc_community_url="${(data && data.sfdc_community_url) || ''}"`);
    if (!resp.ok || !data || !data.access_token) {
        throw new Error(describeFailure('Token request failed', resp, data, raw));
    }
    // Hard-fail here rather than letting singleaccess return a cryptic
    // Invalid_Scope later — a missing `web` scope is the single most common
    // cause of the next leg failing, and this message says exactly what to fix.
    const granted = (data.scope || '').split(/\s+/);
    if (!granted.includes('web') && !granted.includes('full')) {
        throw new Error(
            `The access token was issued with scope "${data.scope || '(none)'}", which includes neither `
            + '"web" nor "full". The Single Access UI Bridge API requires one of them. Add the Web scope to '
            + 'the External Client App, then wait ~10 minutes for the change to propagate before retesting.'
        );
    }
    return data;
}

// Leg 3 — bridge the access token into a real logged-in browser session.
// /services/oauth2/singleaccess does not support CORS at all (see the header
// comment), which is the reason this whole flow must be server-side.
async function requestFrontdoorUri(accessToken, siteUrl, landingPath) {
    const url = `${siteUrl}/services/oauth2/singleaccess`
        + `?redirect_uri=${encodeURIComponent(landingPath)}`;

    const resp = await sfFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
    }, 'login/singleaccess');

    const { data, raw } = await readResponse(resp);
    console.log(`[login] singleaccess -> ${resp.status}`, raw.slice(0, 300));
    if (!resp.ok || !data || !data.frontdoor_uri) {
        throw new Error(describeFailure('UI bridge failed', resp, data, raw));
    }
    return data.frontdoor_uri;
}

async function handleLogin(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch {
        sendJson(res, 400, { error: 'Malformed request.' });
        return;
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
        sendJson(res, 400, { error: 'Enter both a username and a password.' });
        return;
    }

    try {
        const { codeVerifier, codeChallenge } = generatePkcePair();
        const authResult = await requestAuthorizationCode(username, password, codeChallenge);
        const tokenResult = await requestAccessToken(authResult.code, codeVerifier);
        const siteUrl = resolveSiteUrl(tokenResult);
        const landingPath = buildLandingPath(siteUrl);
        const frontdoorUri = await requestFrontdoorUri(tokenResult.access_token, siteUrl, landingPath);
        // Single-use, valid for about a minute — the browser must navigate now.
        sendJson(res, 200, { frontdoor_uri: frontdoorUri });
    } catch (err) {
        // A network failure is not a bad password and must not be reported as
        // one — surfacing Node's raw transport error, or a 401, would send a
        // visitor re-typing a password that was never the problem.
        if (err.isNetwork) {
            console.error(`[login] upstream unreachable (${err.label}): ${(err.cause && err.cause.message) || err.message}`);
            sendJson(res, 503, { error: err.message });
            return;
        }
        // Never relay a raw Salesforce error string to the browser — but do log
        // the full thing here so failures stay diagnosable.
        console.error('[login] failed:', err.message);
        if (err.message === 'Invalid username or password.') {
            sendJson(res, 401, { error: err.message });
            return;
        }
        sendJson(res, 401, { error: 'Could not complete login. Please try again.' });
    }
}

/* ---- Lead capture ------------------------------------------------------------
 *
 * Relays the "Become a partner" form to the guest-accessible Apex REST endpoint,
 * with no OAuth at all — the endpoint is a guest Site, exactly like ChargeOn's
 * own Type 1 gateway payment pages (see CLAUDE.md). No client to register, no
 * secret to manage.
 *
 * The honeypot field (websiteUrl) is passed through UNTOUCHED. This server does
 * not try to detect bots itself — that job belongs to Apex, which re-validates
 * everything anyway (anything reachable over HTTP is eventually called
 * directly, so client-side and even this relay's own filtering is only ever a
 * convenience, never a guarantee).
 */
const LEAD_BODY_MAX_BYTES = 65536; // ~64KB, per the task's cap

async function postLeadToSalesforce(payload) {
    const resp = await sfFetch(SF_LEAD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }, 'lead/apexrest');
    const { data, raw } = await readResponse(resp);
    return { status: resp.status, data, raw };
}

async function handleLead(req, res) {
    let body;
    try {
        body = await readJsonBody(req, LEAD_BODY_MAX_BYTES);
    } catch (err) {
        if (err.message === 'body_too_large') {
            sendJson(res, 413, { ok: false, error: 'Request too large.' });
            return;
        }
        sendJson(res, 400, { ok: false, error: 'Malformed request.' });
        return;
    }

    const payload = {
        firstName: body.firstName,
        lastName: body.lastName,
        company: body.company,
        email: body.email,
        phone: body.phone,
        country: body.country,
        tier: body.tier,
        message: body.message,
        websiteUrl: body.websiteUrl // honeypot — passed through untouched, never inspected here
    };

    try {
        const { status, data, raw } = await postLeadToSalesforce(payload);
        if (data && data.ok) {
            console.log(`[lead] created ${data.leadId}`);
            sendJson(res, 200, { ok: true, leadId: data.leadId });
            return;
        }
        // Never relay Apex's raw error text to the browser — log it here so it
        // stays diagnosable, and answer with a generic message.
        console.error(`[lead] rejected (HTTP ${status}): ${(data && data.error) || raw.slice(0, 300)}`);
        sendJson(res, 200, { ok: false, error: 'We could not submit your application. Please try again.' });
    } catch (err) {
        if (err.isNetwork) {
            console.error(`[lead] upstream unreachable (${err.label}): ${(err.cause && err.cause.message) || err.message}`);
        } else {
            console.error('[lead] failed:', err.message);
        }
        sendJson(res, 502, { ok: false, error: 'We could not submit your application right now. Please try again shortly.' });
    }
}

/* ---- Routing ------------------------------------------------------------- */

function requestHandler(req, res) {
    const routePath = req.url.split('?')[0];

    if (req.method === 'POST' && routePath === '/api/login') {
        if (!SF_CLIENT_ID) {
            sendJson(res, 503, { error: 'Login is not configured on this deployment yet.' });
            return;
        }
        handleLogin(req, res);
        return;
    }
    if (req.method === 'POST' && routePath === '/api/lead') {
        handleLead(req, res);
        return;
    }
    // Fallback for a visitor who already has a session elsewhere, or who wants
    // to bypass the marketing site's modal — lands on the portal HOME (not
    // /login), so someone already signed in goes straight to the dashboard.
    /* Diagnostic for hosted deploys. Reports only which of the site's own public
     * files the server can see, plus the resolved root — never file CONTENT, and
     * never an environment value beyond whether the client id is configured. It
     * exists because a 404 on styles.css is indistinguishable, from the outside,
     * between "wrong root", "file missing from the bundle" and "route not reached". */
    if (req.method === 'GET' && routePath === '/__health') {
        const expected = [
            'index.html', 'tiers.html', 'become-a-partner.html',
            'styles.css', 'main.js', 'headless-login.js', 'lead-form.js',
            'assets/bbLogoGreen.svg'
        ];
        const readable = {};
        for (const rel of expected) {
            try {
                readable[rel] = fs.existsSync(path.join(ROOT, rel));
            } catch (_) {
                readable[rel] = false;
            }
        }
        let rootListing = [];
        try {
            rootListing = fs.readdirSync(ROOT).slice(0, 40);
        } catch (e) {
            rootListing = ['<unreadable: ' + e.code + '>'];
        }
        sendJson(res, 200, {
            root: ROOT,
            dirname: __dirname,
            cwd: process.cwd(),
            onVercel: !!process.env.VERCEL,
            clientIdConfigured: !!SF_CLIENT_ID,
            readable,
            rootListing
        });
        return;
    }

    if (req.method === 'GET' && routePath === '/portal-login') {
        res.writeHead(302, { Location: `${SF_SITE_URL}/` });
        res.end();
        return;
    }
    if (req.method === 'GET') {
        serveStatic(req, res);
        return;
    }
    res.writeHead(405);
    res.end('Method not allowed');
}

/* Two ways this file gets used, and they need opposite things:
 *
 *   npm run dev  -> a long-lived process that owns a port and calls listen().
 *   Vercel       -> a serverless function that must EXPORT a (req, res) handler
 *                   and must never call listen(); a file that only listens
 *                   exports nothing, and the platform reports the resulting
 *                   empty module as FUNCTION_INVOCATION_FAILED.
 *
 * Exporting the handler satisfies the host, and gating listen() on require.main
 * keeps the local server behaving exactly as before. */
module.exports = requestHandler;

if (require.main === module) {
    http.createServer(requestHandler).listen(PORT, () => {
        console.log(`Blackboard partner website running at http://localhost:${PORT}`);
        console.log(`Salesforce site:   ${SF_SITE_URL}`);
        console.log(`Requested scopes:  ${SF_SCOPES}`);
        console.log(`Lead endpoint:     ${SF_LEAD_ENDPOINT}`);
    });
}
