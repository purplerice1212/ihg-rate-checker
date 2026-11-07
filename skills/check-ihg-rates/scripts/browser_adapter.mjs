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
  if(await tab.url()!==url.href) await tab.goto(url.href);
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
export async function submitSearchForm(tab,search,destination,{propertyName=null,entryMode=null}={}) {
  if(entryMode!==null&&entryMode!=='RESULTS_FORM') throw new Error('Unsupported entry mode');
  const resultsForm=entryMode==='RESULTS_FORM';
  if(resultsForm&&(typeof propertyName!=='string'||!propertyName.trim())) throw new Error('Exact property name required for results form');
  if (!propertyName && (typeof destination!=='string' || !destination.trim())) throw new Error('Destination text is required');
  if(search?.adapter_status!=='BROWSER_REQUIRED') throw new Error('Validated adapter request required');
  const req=search.request;
  if(!req || !req.checkin || !req.checkout || req.children!==0) throw new Error('Validated zero-child request required');
  if(typeof req.hotel!=='string'||typeof req.brand!=='string'||!/^[A-Z0-9]{5}$/.test(req.hotel)||!/^[a-z][a-z0-9-]{0,39}$/.test(req.brand)||req.rate_type!=='PURE_POINTS') throw new Error('Invalid canonical hotel/rate request');
  calendarIndex([],[],req.checkin); calendarIndex([],[],req.checkout);
  if(!Number.isInteger(req.nights)||req.nights!==(Date.parse(req.checkout)-Date.parse(req.checkin))/86400000) throw new Error('Invalid night count');
  if(req.checkout<=req.checkin) throw new Error('Checkout must follow checkin');
  if(!Number.isInteger(req.rooms)||req.rooms<1||!Number.isInteger(req.adults)||req.adults<1) throw new Error('Invalid occupancy');
  const url=new URL(search.search_url);
  const propertyPath=new RegExp('^/'+req.brand+'/hotels/(?:us|gb)/en/[^/]+/'+req.hotel.toLowerCase()+'/hoteldetail/?$');
  const resultsPath=new RegExp('^/'+req.brand+'/hotels/(?:us|gb)/en/find-hotels/select-roomrate$');
  const validResultsEntry=value=>resultsPath.test(value.pathname)&&value.searchParams.getAll('qSlH').length===1&&value.searchParams.get('qSlH')===req.hotel;
  if(url.username||url.password||url.origin!=='https://www.ihg.com' || (resultsForm?!validResultsEntry(url):propertyName?!propertyPath.test(url.pathname):url.pathname!=='/hotels/us/en/reservation')) throw new Error('Expected supported reservation entry');
  if(propertyName && (typeof propertyName!=='string'||!propertyName.trim())) throw new Error('Exact property name required');
  if(await tab.url()!==url.href) await tab.goto(url.href);
  const entered=new URL(await tab.url());
  if(entered.username||entered.password||entered.origin!=='https://www.ihg.com') throw new Error('Unexpected redirect before input');
  if(resultsForm&&!validResultsEntry(entered)) throw new Error('Unexpected results form context after redirect');
  await tab.playwright.domSnapshot();
  if(propertyName) {
    if(!await tab.playwright.getByRole('heading',{name:propertyName,exact:true}).isVisible()) throw new Error('Property heading mismatch');
  } else await tab.playwright.getByRole('combobox',{name:'Destination',exact:true}).fill(destination);
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
      await tab.playwright.getByRole('button',{name:wanted<first?/^Previous month$/i:/^Next month$/i}).click();
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
  const format=iso=>(resultsForm?entered:url).pathname.includes('/gb/en/')?`${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}`:`${iso.slice(5,7)}/${iso.slice(8,10)}/${iso.slice(0,4)}`;
  const visibleDestination=propertyName?null:await tab.playwright.getByRole('combobox',{name:'Destination',exact:true}).evaluate(el=>el.value);
  const visibleDates=await tab.playwright.getByRole('button',{name:/^Stay:/}).getByRole('textbox').evaluateAll(els=>els.map(el=>el.value));
  if((!propertyName && visibleDestination!==destination) || visibleDates.length!==2 || visibleDates[0]!==format(req.checkin) || visibleDates[1]!==format(req.checkout)) throw new Error('Search input control mismatch');
  const occupancy=`${req.rooms} Room${req.rooms===1?'':'s'}, ${req.adults} Guest${req.adults===1?'':'s'}`;
  if(!applied.includes(propertyName||destination) || !applied.includes(occupancy) || !applied.includes(format(req.checkin)) || !applied.includes(format(req.checkout)) || !applied.includes('Reward Nights')) throw new Error('Applied search context not confirmed');
  await tab.playwright.getByRole('button',{name:propertyName&&!resultsForm?'View Prices':'Search',exact:true}).click();
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

export function roomCard(ax,roomName) {
  if(typeof ax!=='string'||typeof roomName!=='string'||!roomName.trim()) throw new Error('Full AX snapshot and exact room name required');
  const lines=ax.split('\n');const starts=[];
  for(let i=0;i<lines.length;i++) if(/^\s*\d+ container ROOM_CODE[A-Z0-9]+\s*$/.test(lines[i])) starts.push(i);
  const matches=[];
  for(let i=0;i<starts.length;i++) {
    const start=starts[i], indent=/^([ \t]*)/.exec(lines[start])[1].length;
    let end=start+1;
    for(;end<lines.length;end++) {
      const node=/^([ \t]*)\d+ /.exec(lines[end]);
      if(node&&node[1].length<=indent) break;
    }
    const block=lines.slice(start,end).join('\n');
    const heads=[...block.matchAll(/^\s*\d+ heading (.*), Value: 3(?:,.*)?$/gm)].map(m=>m[1]);
    if(heads.includes(roomName)) matches.push(block);
  }
  if(matches.length!==1) throw new Error('Exact room card missing or ambiguous');
  const block=matches[0];
  const buttons=[...block.matchAll(/^\s*(\d+) button Rate Details\s*$/gm)];
  if(buttons.length!==1 || !block.includes('Reward Nights available')) throw new Error('Reward rate details missing or ambiguous');
  const selected=[...block.matchAll(/^\s*\d+ radio button .* Value: 1\s*$/gm)].map(m=>m[0]);
  if(selected.length!==1 || !/radio button (?:\([^)]*\) )?Select a payment option (?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*) points\*?, Value: 1\s*$/.test(selected[0])) throw new Error('Selected pure-points option not confirmed');
  return {detailsButton:Number(buttons[0][1]),roomName,block};
}

function selectedPanel(ax) {
  const lines=ax.split('\n');const matches=[];
  for(let i=0;i<lines.length;i++) {
    const start=/^(\s*)\d+ container Reward Nights\s*$/.exec(lines[i]);
    if(!start) continue;
    let end=i+1;
    for(;end<lines.length;end++) {
      const node=/^(\s*)\d+ /.exec(lines[end]);
      if(node&&node[1].length<=start[1].length) break;
    }
    const block=lines.slice(i,end).join('\n');
    if(block.includes('button Close rate details information')) matches.push(block);
  }
  if(matches.length!==1) throw new Error('Selected rate detail panel missing or ambiguous');
  return matches[0];
}

function panelSection(ax,label) {
  const lines=ax.split('\n');
  const start=lines.findIndex(line=>new RegExp('^\\s*\\d+ heading '+label+', Value:').test(line));
  if(start<0) return '';
  const result=[];
  for(let i=start+1;i<lines.length;i++) {
    if(/^\s*\d+ heading /.test(lines[i])) break;
    const m=/^\s*\d+ text (.*)$/.exec(lines[i]);
    if(m&&m[1]!==label) result.push(m[1]);
  }
  return result.join(' ').trim();
}

/** Read-only detail-panel inspection after exact property search. No booking selection. */
export async function readSelectedRate(tab,search,{propertyName,roomName}) {
  const req=search?.request;
  if(!req||typeof req.hotel!=='string'||typeof req.brand!=='string'||!/^[A-Z0-9]{5}$/.test(req.hotel)||!/^[a-z][a-z0-9-]{0,39}$/.test(req.brand)||req.rate_type!=='PURE_POINTS'||req.children!==0) throw new Error('Invalid canonical quote request');
  calendarIndex([],[],req.checkin); calendarIndex([],[],req.checkout);
  if(req.checkout<=req.checkin||!Number.isInteger(req.rooms)||req.rooms<1||!Number.isInteger(req.adults)||req.adults<1||!Number.isInteger(req.nights)||req.nights!==(Date.parse(req.checkout)-Date.parse(req.checkin))/86400000) throw new Error('Invalid quote dates or occupancy');
  if(typeof propertyName!=='string'||!propertyName.trim()||typeof roomName!=='string'||!roomName.trim()) throw new Error('Exact hotel and room names required');
  const source=new URL(await tab.url());
  if(source.origin!=='https://www.ihg.com'||source.username||source.password) throw new Error('Unexpected rate source');
  const q=source.searchParams;
  // Reject duplicate request fields even when repeated values agree: servers
  // differ on first/last-value semantics, so the context must be unambiguous.
  for(const key of ['qSlH','qAdlt','qRms','qChld','qCiD','qCiMy','qCoD','qCoMy','qRtP']) {
    if(q.getAll(key).length!==1) throw new Error('Missing or duplicate result URL context parameter: '+key);
  }
  for(const [prefix,iso] of [['qCi',req.checkin],['qCo',req.checkout]]) {
    const monthYear=String(Number(iso.slice(5,7))-1).padStart(2,'0')+iso.slice(0,4);
    if(q.get(prefix+'D')!==String(Number(iso.slice(8,10)))||q.get(prefix+'My')!==monthYear) throw new Error('Result URL dates mismatch');
  }
  if(q.get('qRtP')!=='RWD01') throw new Error('Reward rate context mismatch');
  for(const [key,value] of [['qSlH',req.hotel],['qAdlt',req.adults],['qRms',req.rooms],['qChld',req.children]]) if(q.get(key)!==String(value)) throw new Error('Result URL context mismatch');
  let ax=await tab.getAXState({disableDiffing:true,emit:false});
  if(ax.includes('Close rate details information')) {
    await tab.playwright.getByRole('button',{name:'Close rate details information',exact:true}).click();
    ax=await tab.getAXState({disableDiffing:true,emit:false});
  }
  const format=iso=>source.pathname.includes('/gb/en/')?`${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}`:`${iso.slice(5,7)}/${iso.slice(8,10)}/${iso.slice(0,4)}`;
  // Match complete AX nodes, not text embedded in unrelated labels. These
  // English role/metadata shapes are deliberately narrow and fail closed.
  const nodes=ax.split('\n').map(line=>/^[ \t]*\d+ (.*)$/.exec(line)?.[1]).filter(Boolean);
  const headings=nodes.map(node=>/^heading (.*), Value: [1-6]$/.exec(node)?.[1]);
  const dates=nodes.map(node=>/^text field (.*)$/.exec(node)?.[1]);
  if(headings.filter(name=>name===propertyName).length!==1 ||
     dates.filter(value=>value===format(req.checkin)).length!==1 ||
     dates.filter(value=>value===format(req.checkout)).length!==1) throw new Error('Rendered hotel/date context mismatch');
  const occupancy=`${req.rooms} Room${req.rooms===1?'':'s'}, ${req.adults} Guest${req.adults===1?'':'s'}`;
  const guestControls=nodes.map(node=>/^combo box \((?:collapsed|expanded), settable\) ROOMS & GUESTS, Value: (.*), ID: room-and-guest, Secondary Actions: (?:Expand|Collapse)$/.exec(node)?.[1]).filter(value=>value!==undefined);
  if(guestControls.length!==1||guestControls[0]!==occupancy) throw new Error('Rendered occupancy mismatch');
  const card=roomCard(ax,roomName);
  await tab.click(card.detailsButton);
  const detail=selectedPanel(await tab.getAXState({disableDiffing:true,emit:false}));
  const parsed=parseRatePanel(detail,req);
  if(!parsed.details_candidate) return parsed;
  const cancellation=panelSection(detail,'CANCELLATION POLICY');
  const fees=panelSection(detail,'TAXES AND ADDITIONAL CHARGES');
  const deposit=panelSection(detail,'SECURITY DEPOSIT');
  const bedding=/^\d+\s+(?:Twin|King|Queen|Double)\b/i.exec(roomName)?.[0];
  if(!cancellation||!fees||!bedding) return {status:'UNKNOWN',reason:'Missing cancellation, fees or explicit bedding',details_candidate:parsed.details_candidate};
  const finalSource=new URL(await tab.url());
  if(finalSource.href!==source.href) throw new Error('Source changed during detail extraction');
  return {schema_version:1,status:'AVAILABLE',request:req,checked_at:new Date().toISOString(),source_url:source.href,
    evidence_ref:'current-session-full-AX-observation',provenance:'OFFICIAL_BROWSER_OBSERVED',
    quote:{room:roomName,bedding,cancellation,fees_description:fees,deposit_description:deposit,rate_type:'PURE_POINTS',
      total_scope:'FULL_STAY',points_total:parsed.details_candidate.points_total,fees_checked:true,available:true},
    cash_total:null,cash_total_reason:'Fee narrative is reported; zero cash liability is not established'};
}
