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

const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
export function calendarIndex(months,years,iso) {
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error('ISO date required');
  const year=Number(m[1]), month=Number(m[2]), day=Number(m[3]);
  const dt=new Date(Date.UTC(year,month-1,day));
  if(dt.getUTCFullYear()!==year || dt.getUTCMonth()!==month-1 || dt.getUTCDate()!==day) throw new Error('Invalid calendar date');
  return months.findIndex((name,i)=>name.trim()===MONTHS[month-1] && Number(years[i]?.trim())===year);
}

/** Apply the observed English reservation-page controls, then submit a read-only search.
 * Exact hotel selection and rate-detail extraction still require subsequent work.
 */
export async function submitSearchForm(tab,search,destination) {
  if (typeof destination!=='string' || !destination.trim()) throw new Error('Destination text is required');
  if(search?.adapter_status!=='BROWSER_REQUIRED') throw new Error('Validated adapter request required');
  const req=search.request;
  if(!req || !req.checkin || !req.checkout || req.children!==0) throw new Error('Validated zero-child request required');
  if(typeof req.hotel!=='string'||typeof req.brand!=='string'||!/^[A-Z0-9]{5}$/.test(req.hotel)||!/^[a-z][a-z0-9-]{0,39}$/.test(req.brand)||req.rate_type!=='PURE_POINTS') throw new Error('Invalid canonical hotel/rate request');
  calendarIndex([],[],req.checkin); calendarIndex([],[],req.checkout);
  if(!Number.isInteger(req.nights)||req.nights!==(Date.parse(req.checkout)-Date.parse(req.checkin))/86400000) throw new Error('Invalid night count');
  if(req.checkout<=req.checkin) throw new Error('Checkout must follow checkin');
  if(!Number.isInteger(req.rooms)||req.rooms<1||!Number.isInteger(req.adults)||req.adults<1) throw new Error('Invalid occupancy');
  const url=new URL(search.search_url);
  if(url.username||url.password||url.origin!=='https://www.ihg.com' || url.pathname!=='/hotels/us/en/reservation') throw new Error('Expected supported reservation entry');
  await tab.goto(url.href);
  const entered=new URL(await tab.url());
  if(entered.username||entered.password||entered.origin!=='https://www.ihg.com') throw new Error('Unexpected redirect before input');
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('combobox',{name:'Destination',exact:true}).fill(destination);
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('button',{name:/^Stay:/}).click();
  await tab.playwright.domSnapshot();
  for(const iso of [req.checkin,req.checkout]) {
    let selected=false;
    for(let attempt=0;attempt<24;attempt++) {
      const months=await tab.playwright.getByRole('button',{name:'Choose Month',exact:true}).allTextContents({});
      const years=await tab.playwright.getByRole('button',{name:'Choose Year',exact:true}).allTextContents({});
      const idx=calendarIndex(months,years,iso);
      if(idx>=0) {
        const day=String(Number(iso.slice(8,10)));
        const cell=tab.playwright.getByRole('grid').nth(idx).getByRole('gridcell',{name:day,exact:true}).filter({hasText:new RegExp('^\\s*'+day+'\\s*$')});
        if(await cell.count()!==1) throw new Error('Ambiguous visible calendar day');
        await cell.click(); await tab.playwright.domSnapshot(); selected=true; break;
      }
      const first=(Number(years[0]?.trim())*12)+MONTHS.indexOf(months[0]?.trim());
      const wanted=Number(iso.slice(0,4))*12+Number(iso.slice(5,7))-1;
      if(!Number.isFinite(first)||MONTHS.indexOf(months[0]?.trim())<0) throw new Error('Unrecognized calendar header');
      await tab.playwright.getByRole('button',{name:wanted<first?'Previous Month':'Next Month',exact:true}).click();
      await tab.playwright.domSnapshot();
    }
    if(!selected) throw new Error('Calendar navigation bound reached');
  }
  await tab.playwright.getByRole('combobox',{name:'Rooms & Guests',exact:true}).click();
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('textbox',{name:'rooms',exact:true}).fill(String(req.rooms));
  await tab.playwright.getByRole('textbox',{name:'adults',exact:true}).fill(String(req.adults));
  await tab.playwright.getByRole('textbox',{name:'children',exact:true}).fill('0');
  for(const [field,value] of [['rooms',req.rooms],['adults',req.adults],['children',0]]) {
    const actual=await tab.playwright.getByRole('textbox',{name:field,exact:true}).evaluate(el=>el.value);
    if(String(actual)!==String(value)) throw new Error('Occupancy control mismatch');
  }
  await tab.playwright.getByRole('button',{name:'Best Available',exact:true}).click();
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('menuitemradio',{name:'Reward Nights',exact:true}).click();
  const applied=await tab.playwright.domSnapshot();
  if(!await tab.playwright.getByRole('button',{name:'Reward Nights',exact:true}).isVisible()) throw new Error('Reward option not selected in control');
  const format=iso=>`${iso.slice(5,7)}/${iso.slice(8,10)}/${iso.slice(0,4)}`;
  const visibleDestination=await tab.playwright.getByRole('combobox',{name:'Destination',exact:true}).evaluate(el=>el.value);
  const visibleDates=await tab.playwright.getByRole('button',{name:/^Stay:/}).getByRole('textbox').evaluateAll(els=>els.map(el=>el.value));
  if(visibleDestination!==destination || visibleDates.length!==2 || visibleDates[0]!==format(req.checkin) || visibleDates[1]!==format(req.checkout)) throw new Error('Search input control mismatch');
  const occupancy=`${req.rooms} Room${req.rooms===1?'':'s'}, ${req.adults} Guest${req.adults===1?'':'s'}`;
  if(!applied.includes(destination) || !applied.includes(occupancy) || !applied.includes(format(req.checkin)) || !applied.includes(format(req.checkout)) || !applied.includes('Reward Nights')) throw new Error('Applied search context not confirmed');
  await tab.playwright.getByRole('button',{name:'Search',exact:true}).click();
  const destinationUrl=await tab.url();
  const finalUrl=new URL(destinationUrl);
  if(finalUrl.username||finalUrl.password||finalUrl.origin!=='https://www.ihg.com') throw new Error('Unexpected destination after submission');
  const snapshot=await tab.playwright.domSnapshot();
  return {schema_version:1,...parseSnapshot(snapshot),request:req,checked_at:new Date().toISOString(),source_url:await tab.url(),observation:snapshot,requires_verification:true,stage:'SEARCH_SUBMITTED'};
}

/** Parse a selected rate-detail AX panel; never use room-card radio labels.
 * Caller must still verify hotel, dates, room, selected pure-points option and fees.
 */
export function parseRatePanel(ax, expected) {
  const unknown=reason=>({status:'UNKNOWN',reason});
  if(typeof ax!=='string') return unknown('Missing rate panel');
  const headings=[...ax.matchAll(/PRICE FOR\s+(\d+)\s+ROOMS?\s*,\s*(\d+)\s+NIGHTS?/gi)];
  if(!headings.length || headings.some(m=>Number(m[1])!==expected.rooms || Number(m[2])!==expected.nights)) return unknown('Rate panel room/night context mismatch');
  const lines=ax.split('\n').map(line=>line.replace(/^\s*\d+\s+text\s+/,'').trim());
  const totals=[];
  for(let i=0;i<lines.length-1;i++) {
    if(lines[i]==='Estimated Total Price') {
      const match=/^([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\s+PTS$/.exec(lines[i+1]);
      if(match) totals.push(Number(match[1].replaceAll(',','')));
      else return unknown('Estimated total is not an explicit pure-points amount');
    }
  }
  if(totals.length!==1) return unknown('Missing or ambiguous selected panel total');
  return {status:'UNKNOWN',reason:'Selected panel candidate parsed; remaining exact-stay evidence required',
    details_candidate:{points_total:totals[0],total_scope:'FULL_STAY',rooms:expected.rooms,nights:expected.nights},requires_verification:true};
}
