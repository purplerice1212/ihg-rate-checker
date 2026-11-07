/** Browser-backed structured collection, using an injected authorized browser tab.
 * No credentials, network interception, private APIs, or booking actions.
 * Caller retains snapshots privately; never commit real observations.
 */
export function parseSnapshot(snapshot) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) return {status:'UNKNOWN', reason:'Empty browser observation', candidates:[]};
  const blocked = /access denied|verify (?:you are|you're) human|captcha|unusual traffic|sign in to continue/i.test(snapshot);
  if (blocked) return {status:'BLOCKED',reason:'Access or authentication challenge visible',candidates:[]};
  if (/\b404\b|page not found|something went wrong|technical difficulties/i.test(snapshot)) return {status:'UNKNOWN',reason:'Website error visible',candidates:[]};
  const lines = snapshot.split('\n');
  const candidates = [];
  for (let i=0; i<lines.length; i++) {
    const matches = [...lines[i].matchAll(/\b([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\s*(?:points|pts)\b/gi)];
    for (const match of matches) {
      candidates.push({points:Number(match[1].replaceAll(',','')),text:lines[i].trim(),
        context:lines.slice(Math.max(0,i-2),Math.min(lines.length,i+3)).join('\n'),
        scope:/per night|nightly|average/i.test(lines[i])?'NIGHTLY':/total|stay/i.test(lines[i])?'TOTAL_CANDIDATE':'UNKNOWN'});
    }
  }
  return {status:'UNKNOWN', reason:candidates.length?'Rate candidates collected; exact stay, room, fees and total require verification':'No verified points quote found',candidates};
}

export async function collectSearch(tab, search, {clock=()=>new Date().toISOString()}={}) {
  if (!search || search.adapter_status !== 'BROWSER_REQUIRED' || !search.request) throw new Error('Use the structured request constructor first');
  const url = new URL(search.search_url);
  if (url.protocol !== 'https:' || url.hostname !== 'www.ihg.com' || url.username || url.password) throw new Error('Official IHG HTTPS URL required');
  await tab.goto(url.href);
  const snapshot = await tab.playwright.domSnapshot();
  const source_url = await tab.url();
  const actual = new URL(source_url);
  if (actual.protocol !== 'https:' || !['www.ihg.com','ihg.com'].includes(actual.hostname)) return {schema_version:1,status:'BLOCKED',reason:'Unexpected destination',request:search.request,checked_at:clock()};
  return {schema_version:1,...parseSnapshot(snapshot),request:search.request,checked_at:clock(),source_url,
    observation:snapshot, provenance:'BROWSER_SNAPSHOT', requires_verification:true};
}
