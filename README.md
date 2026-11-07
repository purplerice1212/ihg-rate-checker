# IHG rate checker: early structured adapter

A general-purpose, browser-assisted IHG reward-rate checking prototype. Supply your own official hotel code, official brand URL slug, dates, adults and rooms. No personal itinerary is bundled.

**Current status:** experimental browser-backed query components, not a standalone hosted API. Input validation, property search-form submission, and selected-room detail extraction are implemented. One live property search and selected-room extraction matched the official full-stay points total. A loaded-results extraction took about three seconds, which is not an end-to-end benchmark. Repeated multi-property validation and unattended recovery remain unfinished. This is not an official IHG API, booking agent, or error-free service.

## Usage

Put private inputs outside the repository. A request needs `hotel`, `brand`, `checkin`, `checkout`, `adults`, and `rooms`; dates are ISO strings. Obtain hotel code and brand slug from the requested hotel's official IHG page. The current implementation supports pure-points rates with no children.

Run `python3 skills/check-ihg-rates/scripts/adapter.py request /path/to/private-input.json` to construct an official search URL. The browser module accepts an authorized tab and that structured request output. The validation CLI accepts an object containing `request` and `evidence`; see the skill's contract reference for the schema.

Statuses distinguish AVAILABLE, explicit UNAVAILABLE, BLOCKED, UNKNOWN and STALE. Schema-valid JSON is not proof of a genuine quote: the caller must independently verify current official browser evidence. Do not compare different room types, cancellation policies, occupancies or total scopes.

## Test

- `python3 -m unittest discover -s skills/check-ihg-rates/scripts -v`
- `node --test skills/check-ihg-rates/scripts/test_*.mjs`

All checked-in fixtures are fictional. Offline tests do not establish live availability.

## Privacy and operation

Never commit real trip inputs, booking references, credentials, cookies, browser profiles, screenshots or traces, even to test fixtures. Do not bypass login or access controls. No booking or payment capability is provided. No daily live monitor is installed by this repository. A daily health check needs a separately authorized browser-capable scheduler and verified execution; a skill file alone cannot schedule work.

The design draws on the publicly documented OpenAI skill-creator structure and Playwright snapshot workflow, with original implementation. Refer to the skill's maintenance reference for source links and repair policy.

### Browser integration

Generated room-rate deep links returned official 404 responses. Use the actual official property page and its rendered date/occupancy/reward controls instead. `submitSearchForm` supports an exact property URL plus `propertyName`, verifying the heading and submitting View Prices. `readSelectedRate` requires an exact `roomName`, checks result URL and rendered stay context, opens that card's rate details, and reads its full-stay total and terms. Never trust average nightly prices or radio-label prices as totals.

`check_rate.mjs` is an experimental orchestration layer with stage timings and bounded recovery. It still needs repeated live end-to-end verification. It requires an injected browser tab implementing the supported accessibility/locator interface; ordinary Node alone does not supply a browser session. No credentials or session data are included.

Returned fee narratives do not establish zero cash liability. `cash_total` remains null. Browser failures return UNKNOWN, not sold out. Missing dates in calendar discovery are also not proof of unavailability. The current extractor targets observed English-language IHG layouts; other layouts must fail closed until verified.

### Next milestones

1. Repeated end-to-end checks across two property layouts and interrupted/loading/error cases.
2. Matched official-browser parity benchmarks, including exact occupancy, bedding, full-stay totals and terms.
3. A verified private daily runner with regression tests and safe repair/retest reporting.
4. User-facing search and comparison UI, followed by separately labelled area/global discovery.
