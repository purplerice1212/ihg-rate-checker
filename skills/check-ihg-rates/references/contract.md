# Structured interface, version 1

The program uses only Python's standard library. It constructs an official website URL and validates supplied observations; it makes no network requests and has no live pricing fetch method.

Request fields: hotel (official five-character uppercase code), brand (official URL slug), checkin and checkout (ISO date), adults (positive integer, default 2), rooms (positive integer, default 1), children (must be 0). The request output includes normalized request, nights, search_url and BROWSER_REQUIRED. Hotel/brand existence must be verified externally.

For validate, pass an object with request and evidence fields. Evidence contains status, the exact normalized request, checked_at (timezone-aware ISO datetime), source_url (official HTTPS IHG), evidence_ref (private observation reference) and quote. A quote contains room, bedding, cancellation, fees_description, rate_type=PURE_POINTS, total_scope=FULL_STAY, points_total (positive integer), fees_checked=true and available=true. UNAVAILABLE requires explicit_no_availability=true and valid exact-stay evidence. BLOCKED or UNKNOWN can carry a reason.

AVAILABLE means supplied fields meet the contract; callers must additionally establish browser provenance. A fabricated JSON object can pass schema validation and must never be treated as genuine evidence. Observations older than one hour are STALE by default. Comparison requires matching request, room, bedding, rate type and cancellation conditions. Fees may still be payable even on a pure-points room rate; report their description.

Fixtures use fictional hotel ABCDE, fictional brand example-brand and synthetic dates/prices. They are not search recommendations or user travel data.

## Browser collection module

`scripts/browser_adapter.mjs` exports `collectSearch(tab, search)` for an injected authorized browser tab with `goto`, `url` and `playwright.domSnapshot`. It navigates, observes the rendered page and returns timestamped structured candidate rates plus a private snapshot. It does not open or control browsers outside the authorized browser tool. Candidate numbers may be marketing text, nightly rates or unrelated offers, so collection intentionally never certifies AVAILABLE. The exact-stay validator and independent browser evidence review remain mandatory. Do not publish returned observations.

Run `node --test scripts/test_browser_adapter.mjs` for six synthetic collection/parser tests. Those tests use an injected fake browser; they are not live hotel-rate verification.

Live-test correction: generated brand room-rate deep links returned an official 404. The constructor now returns the verified public reservation entry URL, structured query_parameters for reference, and UI_FORM_REQUIRED. These parameters are not applied by navigating to the entry URL. The caller must populate and verify the live form before rate collection. No generic automatic form-filling implementation is validated yet.

## Experimental form submission

`submitSearchForm(tab, search, destination)` implements the observed English reservation controls: destination, calendar dates (month and year verified), room/guest inputs and Reward Nights. Input control values are checked before submission. Each control interaction was exercised in the live browser, but the assembled function has not completed an end-to-end real quote run. Browser backend timeouts prevented result extraction during that test. The returned SEARCH_SUBMITTED stage is UNKNOWN, not a hotel match or rate confirmation. Selecting and confirming the exact requested hotel, opening its selected room's details and extracting the verified total are still required.

Observed warning: room-card radio accessibility labels can repeat a cheaper rate from another room. Never establish price from those labels. Use the selected room's actual detail panel and whole-stay Estimated Total Price, and retain room identity throughout.

`parseRatePanel(ax, expected)` parses a selected rate-detail accessibility panel, checking its room/night count and unique explicit Estimated Total Price in PTS. Its structure was grounded in an observed official panel; published fixtures replace all prices and trip details with synthetic values. It returns only an UNKNOWN details candidate. It deliberately ignores room-card radio prices and does not reject generic explanatory Points+Cash prose. A selected cash-plus-points amount, mismatched nights or ambiguous totals is rejected. A live assembled extractor still needs separate validation.
