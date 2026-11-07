import {submitSearchForm,readSelectedRate,parseSnapshot} from './browser_adapter.mjs';

function knownTransportTimeout(error) {
  const message=String(error?.message??'');
  if(/denied|forbidden|unauthori[sz]ed|captcha|verify.*human|authentication|sign.?in|security warning/i.test(message)) return false;
  return /^(?:Runtime\.evaluate|DOMSnapshot\.captureSnapshot) timed out\.(?:\s|$)/.test(message);
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
  const started=Date.now(); const stages=[]; let reloaded=false;
  const result=value=>({...value,timing:{total_ms:Date.now()-started,stages},reloaded});
  const blocked=()=>result({status:'BLOCKED',reason:'Official page requires access verification',requires_verification:true});
  const phase=async(name,fn)=>{const t=Date.now();try{return await fn();}finally{stages.push({name,elapsed_ms:Date.now()-t});}};
  const reload=async error=>{
    if(reloaded||!knownTransportTimeout(error)||typeof tab.reload!=='function') throw error;
    reloaded=true;
    await phase('ordinary_reload',()=>tab.reload());
  };
  try {
    let submitted, recoveredAX;
    const submit=()=>submitSearchForm(tab,search,options.destination??'',options);
    try { submitted=await phase('search_form',submit); }
    catch(error) {
      if(!knownTransportTimeout(error)||reloaded||typeof tab.reload!=='function') throw error;
      // A timeout after Search may mean submission succeeded. Inspect before
      // and after reload so recovery never repeats an already applied search.
      const beforeReload=new URL(await tab.url());
      if(beforeReload.origin!=='https://www.ihg.com'||beforeReload.username||beforeReload.password) throw new Error('Unexpected recovery source');
      const alreadyApplied=exactResultURL(beforeReload.href,search.request);
      await reload(error);
      recoveredAX=await phase('search_recovery_readiness',()=>tab.getAXState({disableDiffing:true,emit:false}));
      if(parseSnapshot(recoveredAX).status==='BLOCKED') return blocked();
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
    try { ax=await phase('results_readiness',()=>recoveredAX??tab.getAXState({disableDiffing:true,emit:false})); }
    catch(error) {
      await reload(error);
      ax=await phase('results_readiness_after_reload',()=>tab.getAXState({disableDiffing:true,emit:false}));
    }
    if(parseSnapshot(ax).status==='BLOCKED') return blocked();
    if(!/container ROOM_CODE[A-Z0-9]+/.test(ax)) return result({status:'UNKNOWN',reason:'Exact room results not ready or unsupported; no availability inference',requires_verification:true});
    return result(await phase('selected_rate',()=>readSelectedRate(tab,search,options)));
  } catch(error) {
    // Do not include the exception text: it may embed private URL/query values.
    return result({status:'UNKNOWN',reason:'Query could not establish a verified quote',error_type:error?.name==='TypeError'?'TYPE_ERROR':'QUERY_FAILED',requires_verification:true});
  }
}
