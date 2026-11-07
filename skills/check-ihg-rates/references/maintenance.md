# Maintenance and testing

Use one daily authorized monitor, with a defined time zone and existing-monitor deduplication. Scheduling requires the product's supported automation tools; this package does not create a schedule. Run offline tests and one low-volume live official-browser smoke check. Rotate synthetic future dates so an expired test stay does not appear to be a site failure.

Classify failures before repair: malformed input, stale observation, page change, transient network problem, login requirement, access restriction or explicit no availability. Retry a transient failure at most once. Stop on security/access blocks and request the needed user action. Never disguise a failed check using an old price.

For a page-change repair, preserve a sanitized regression fixture, make a small isolated change, run all tests and independently recheck the live page. Keep published fixtures synthetic. Do not weaken evidence checks just to make tests pass. Push an authorized repair to a branch/draft PR; merging or changing production schedules requires appropriate authorization. Pin any future dependencies and maintain rollback versions.

Notify on actionable failures, meaningful rate changes and recovery; suppress repetitive healthy reports. A scheduler may be delayed or fail, and browser availability or authentication may expire. Verify the next scheduled run and actual execution before saying daily checks work.

Design sources inspected, not copied wholesale: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md and https://github.com/openai/skills/blob/main/skills/.curated/playwright/SKILL.md . The former's Apache 2.0 license was verified. Retain license and notices if copying upstream material in future. Do not auto-install arbitrary community skills.
