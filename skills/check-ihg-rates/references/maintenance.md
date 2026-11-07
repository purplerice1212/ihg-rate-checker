# Maintenance and testing

Use one daily authorized monitor, with a defined time zone and existing-monitor deduplication. Scheduling requires the product's supported automation tools; this package does not create a schedule. Run offline tests and one low-volume live official-browser smoke check. Rotate synthetic future dates so an expired test stay does not appear to be a site failure.

Classify failures before repair: malformed input, stale observation, page change, transient network problem, login requirement, access restriction or explicit no availability. Retry a transient failure at most once. Stop on security/access blocks and request the needed user action. Never disguise a failed check using an old price.

For a page-change repair, preserve a sanitized regression fixture, make a small isolated change, run all tests and independently recheck the live page. Keep published fixtures synthetic. Do not weaken evidence checks just to make tests pass. Push an authorized repair to a branch/draft PR; merging or changing production schedules requires appropriate authorization. Pin any future dependencies and maintain rollback versions.

Notify on actionable failures, meaningful rate changes and recovery; suppress repetitive healthy reports. A scheduler may be delayed or fail, and browser availability or authentication may expire. Verify the next scheduled run and actual execution before saying daily checks work.

Design sources inspected, not copied wholesale: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md and https://github.com/openai/skills/blob/main/skills/.curated/playwright/SKILL.md . The former's Apache 2.0 license was verified. Retain license and notices if copying upstream material in future. Do not auto-install arbitrary community skills.

## Provider roadmap

Keep exact-stay verification separate from discovery. A future discovery provider can return candidate hotels/dates, but cannot produce an official verified quote without matching occupancy, room, full-stay pricing, fees, freshness and source evidence. The documented rooms.aero partner API is a research candidate: https://developers.seats.aero/reference/rooms-getting-started and https://developers.seats.aero/reference/rooms-search . Do not assume access, freshness, commercial reuse rights or suitable occupancy support. Do not connect accounts, generate API credentials or subscribe without required authorization.

Build the reliable exact-stay backend before area/global deal exploration or a polished frontend. A later UI should make inputs explicit, retain comparable filters, show full-stay totals and source timestamps, distinguish unknown from unavailable, and make error recovery understandable. No current UI or speed improvement has been verified. Benchmark matched successful searches, accuracy and failure rates rather than timing only the happy path.

## Browser transport diagnostics

Record only fixed operation-stage names and elapsed milliseconds in public diagnostics. Keep exception bodies, URLs, snapshots and input values private: browser errors may embed itinerary data. The wrapper's `last_form_stage` identifies where a failure occurred without exposing the stay. A protocol timeout is not evidence that the website denied access or that rooms sold out.

The query uses at most one ordinary reload for the specifically observed Runtime.evaluate or DOMSnapshot.captureSnapshot timeout prefixes. Authentication, CAPTCHA, denial and unexpected-origin conditions never qualify. Check whether the exact result URL already exists before repeating a form submission. Missing results alone trigger at most one loading-state observation follow-up, never an unbounded loop or automatic reload.

Validate transport repairs separately from price accuracy. A successfully opened calendar is not a successful quote. Count a complete query only when the requested property, dates, occupancy, selected room, full-stay total and terms are verified together. Include failed attempts and recovery time in benchmark reports. Do not describe a loaded-panel extraction time as full-search latency.
