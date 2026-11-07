import {submitSearchForm,readSelectedRate,parseSnapshot,FORM_STAGES} from './browser_adapter.mjs';

function knownTransportTimeout(error) {
  const message=String(error?.message??'');
  if(/denied|forbidden|unauthori[sz]ed|captcha|verify.*human|authentication|sign.?in|security warning/i.test(message)) return false;
  return /^(?:Runtime\.evaluate|DOMSnapshot\.captureSnapshot) timed out\.(?:\s|$)/.test(message);
}

/** Fixed diagnostics only: never return exception text, selectors, or URLs. */
export function classifyQueryError(error) {
  if(error?.message==='Accessibility capture changed before it was committed') return 'SNAPSHOT_CHANGED';
  if(knownTransportTimeout(error)) return 'PROTOCOL_TIMEOUT';
  const message=String(error?.message??'');
  if(/\btarget closed\b|\btarget (?:page|context|browser).*\bclosed\b|\bsession closed\b/i.test(message)) return 'TARGET_CLOSED';
  if(/\b(?:locator|selector|waiting for (?:element|locator|selector))\b/i.test(message)&&/timeout|timed out|deadline|time limit/i.test(message)) return 'SELECTOR_DEADLINE';
  return 'GENERIC';
}

function exactResultURL(value,request) {
  try {
    const url=new URL(value), req=request;
    if(url.origin!=='https://www.ihg.com'||url.username||url.password) return false;
    const expected={qSlH:req.hotel,qAdlt:req.adults,qRms:req.rooms,qChld:req.children,qRtP:'RWD01'};
    for(const [prefix,iso] of [['qCi',req.checkin],['qCo',req.checkout]]) {
      expected[prefix+'D']=Number(iso.slice(8,10));
      expected[prefix+'My']=String(Number(iso.slice(5,7))-1).padStart(2,'0')+iso.slice(0,4);
    }
    const path=new RegExp('^/'+req.brand+'/hotels/(?:us|gb)/en/(?:find-hotels/select-roomrate|[^/]+/'+req.hotel.toLowerCase()+'/hoteldetail/rooms)/?$');
    return path.test(url.pathname)&&Object.entries(expected).every(([key,expectedValue])=>url.searchParams.getAll(key).length===1&&url.searchParams.get(key)===String(expectedValue));
  } catch { return false; }
}

/** Bounded browser-backed query. No endpoint bypasses, booking actions, or raw logs. */
export async function checkRate(tab,search,options) {
  const started=Date.now(); const stages=[]; let reloaded=false,last_form_stage=null,snapshot_refreshed=false;
  const result=value=>({...value,timing:{total_ms:Date.now()-started,stages},reloaded,last_form_stage,snapshot_refreshed});
  const notReady=()=>result({status:'UNKNOWN',reason:'Exact room results not ready or unsupported; no availability inference',requires_verification:true});
  const websiteError=ax=>parseSnapshot(ax).reason==='Website error visible';
  const hasCards=ax=>/^[ \t]*\d+ container ROOM_CODE[A-Z0-9]+[ \t]*$/m.test(ax);
  const blocked=()=>result({status:'BLOCKED',reason:'Official page requires access verification',requires_verification:true});
  const phase=async(name,fn)=>{const t=Date.now();let error_code;try{return await fn();}catch(error){error_code=classifyQueryError(error);throw error;}finally{stages.push({name,elapsed_ms:Date.now()-t,...(error_code?{error_code}:{})});}};
  const readinessAX=async()=>{
    try { return await tab.getAXState({disableDiffing:true,emit:false}); }
    catch(error) {
      if(error?.message!=='Accessibility capture changed before it was committed'||snapshot_refreshed) throw error;
      snapshot_refreshed=true;
      // Observation-only race: one immediate fresh capture across readiness
      // phases. Never rerun form actions or reload for this error.
      return phase('snapshot_changed_refresh',()=>tab.getAXState({disableDiffing:true,emit:false}));
    }
  };
  const reload=async error=>{
    if(reloaded||!knownTransportTimeout(error)||typeof tab.reload!=='function') throw error;
    reloaded=true;
    await phase('ordinary_reload',()=>tab.reload());
  };
  try {
    let submitted, recoveredAX;
    const submit=()=>submitSearchForm(tab,search,options.destination??'',{...options,onStage:async name=>{
      if(FORM_STAGES.includes(name)) last_form_stage=name;
      if(typeof options.onStage==='function') await options.onStage(name);
    }});
    try { submitted=await phase('search_form',submit); }
    catch(error) {
      if(!knownTransportTimeout(error)||reloaded||typeof tab.reload!=='function') throw error;
      // A timeout after Search may mean submission succeeded. Inspect before
      // and after reload so recovery never repeats an already applied search.
      const beforeReload=new URL(await tab.url());
      if(beforeReload.origin!=='https://www.ihg.com'||beforeReload.username||beforeReload.password) throw new Error('Unexpected recovery source');
      const alreadyApplied=exactResultURL(beforeReload.href,search.request);
      await reload(error);
      recoveredAX=await phase('search_recovery_readiness',readinessAX);
      if(parseSnapshot(recoveredAX).status==='BLOCKED') return blocked();
      if(websiteError(recoveredAX)) return notReady();
      const appliedAfterReload=exactResultURL(await tab.url(),search.request);
      if(!appliedAfterReload) {
        // If an applied search changed unexpectedly, do not navigate it away.
        if(alreadyApplied) throw new Error('Applied result changed during recovery');
        const current=new URL(await tab.url());
        if(current.origin!=='https://www.ihg.com'||current.username||current.password) throw new Error('Unexpected recovery destination');
        submitted=await phase('search_form_after_reload',submit);
        recoveredAX=undefined;
      }
    }
    if(submitted?.status==='BLOCKED') return blocked();
    let ax;
    try { ax=await phase('results_readiness',()=>recoveredAX??readinessAX()); }
    catch(error) {
      await reload(error);
      ax=await phase('results_readiness_after_reload',readinessAX);
    }
    if(parseSnapshot(ax).status==='BLOCKED') return blocked();
    if(websiteError(ax)) return notReady();
    if(!hasCards(ax)) {
      // One observation-driven follow-up for a loading shell. No sleeps,
      // polling loop, or reload merely because data is absent.
      if(typeof tab.getScreenshot!=='function') return notReady();
      await phase('results_loading_screenshot',()=>tab.getScreenshot({emit:false}));
      ax=await phase('results_readiness_followup',readinessAX);
      if(parseSnapshot(ax).status==='BLOCKED') return blocked();
      if(websiteError(ax)||!hasCards(ax)) return notReady();
    }
    return result(await phase('selected_rate',()=>readSelectedRate(tab,search,options)));
  } catch(error) {
    // Do not include the exception text: it may embed private URL/query values.
    return result({status:'UNKNOWN',reason:'Query could not establish a verified quote',error_type:error?.name==='TypeError'?'TYPE_ERROR':'QUERY_FAILED',error_code:classifyQueryError(error),requires_verification:true});
  }
}
