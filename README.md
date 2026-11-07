# IHG rate checker: early structured adapter

A general-purpose, browser-assisted IHG reward-rate checking prototype. Supply your own official hotel code, official brand URL slug, dates, adults and rooms. No personal itinerary is bundled.

**Current status:** request construction and fail-closed evidence validation work offline. The browser collector reads page snapshots through an injected authorized browser tab and extracts unverified candidates. End-to-end exact-room live rate extraction is not yet validated. This is not an official IHG API, booking agent, or error-free service.

## Usage

Put private inputs outside the repository. A request needs `hotel`, `brand`, `checkin`, `checkout`, `adults`, and `rooms`; dates are ISO strings. Obtain hotel code and brand slug from the requested hotel's official IHG page. The current implementation supports pure-points rates with no children.

Run `python3 skills/check-ihg-rates/scripts/adapter.py request /path/to/private-input.json` to construct an official search URL. The browser module accepts an authorized tab and that structured request output. The validation CLI accepts an object containing `request` and `evidence`; see the skill's contract reference for the schema.

Statuses distinguish AVAILABLE, explicit UNAVAILABLE, BLOCKED, UNKNOWN and STALE. Schema-valid JSON is not proof of a genuine quote: the caller must independently verify current official browser evidence. Do not compare different room types, cancellation policies, occupancies or total scopes.

## Test

- `python3 -m unittest discover -s skills/check-ihg-rates/scripts -v`
- `node --test skills/check-ihg-rates/scripts/test_browser_adapter.mjs`

All checked-in fixtures are fictional. Offline tests do not establish live availability.

## Privacy and operation

Never commit real trip inputs, booking references, credentials, cookies, browser profiles, screenshots or traces, even to test fixtures. Do not bypass login or access controls. No booking or payment capability is provided. No daily live monitor is installed by this repository. A daily health check needs a separately authorized browser-capable scheduler and verified execution; a skill file alone cannot schedule work.

The design draws on the publicly documented OpenAI skill-creator structure and Playwright snapshot workflow, with original implementation. Refer to the skill's maintenance reference for source links and repair policy.

### Live-test finding

Generated room-rate deep links returned an official 404 during testing. The constructor therefore returns a working public reservation entry URL and structured parameters, not a claim that the search is already applied. The current browser collector does not automatically populate hotel/date/occupancy controls. That integration and exact room-detail extraction remain unfinished. A homepage marketing points amount must never be reported as a hotel quote.

### Experimental form runner

The development version adds `submitSearchForm(tab, search, destination)` using observed English-language controls, explicit calendar month/year matching, exact input-control checks, reward selection confirmation, and origin checks before entering data and after submission. It returns UNKNOWN at SEARCH_SUBMITTED. The assembled runner still needs an end-to-end live test; exact hotel selection and room-detail extraction are unfinished. The original browser interactions reached search submission, but the browser backend timed out before reading results.
