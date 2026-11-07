import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSnapshot,collectSearch} from './browser_adapter.mjs';
test('extract synthetic points without certifying price',()=>{
  const r=parseSnapshot('Twin room\n90,000 points total stay\nRefundable');
  assert.equal(r.status,'UNKNOWN');assert.equal(r.candidates[0].points,90000);assert.equal(r.candidates[0].scope,'TOTAL_CANDIDATE');
});
test('nightly is not a total',()=>assert.equal(parseSnapshot('30,000 points per night').candidates[0].scope,'NIGHTLY'));
test('blocks stay blocked',()=>assert.equal(parseSnapshot('Verify you are human CAPTCHA').status,'BLOCKED'));
test('errors are not unavailable',()=>assert.equal(parseSnapshot('404 Page not found').status,'UNKNOWN'));
test('collection drives browser and returns structured private observation',async()=>{
  let visited;
  const tab={goto:async u=>{visited=u},url:async()=>visited,playwright:{domSnapshot:async()=> '90,000 points total stay'}};
  const result=await collectSearch(tab,{adapter_status:'BROWSER_REQUIRED',request:{hotel:'ABCDE'},search_url:'https://www.ihg.com/example'}, {clock:()=> '2030-01-01T00:00:00Z'});
  assert.equal(visited,'https://www.ihg.com/example');assert.equal(result.candidates[0].points,90000);assert.equal(result.requires_verification,true);
});
test('reject nonofficial source before navigation',async()=>{
  await assert.rejects(()=>collectSearch({}, {adapter_status:'BROWSER_REQUIRED',request:{},search_url:'https://other.example'}));
});
import {calendarIndex} from './browser_adapter.mjs';
test('calendar matches year and month across December/January',()=>{
  assert.equal(calendarIndex([' December ',' January '],['2029','2030'],'2030-01-19'),1);
  assert.equal(calendarIndex([' January '],['2029'],'2030-01-19'),-1);
});
test('invalid calendar date is rejected',()=>assert.throws(()=>calendarIndex(['February'],['2030'],'2030-02-30')));

import {submitSearchForm} from './browser_adapter.mjs';
const validSearch=()=>({adapter_status:'BROWSER_REQUIRED',search_url:'https://www.ihg.com/hotels/us/en/reservation',
  request:{hotel:'ABCDE',brand:'example-brand',checkin:'2030-01-19',checkout:'2030-01-21',adults:2,rooms:1,children:0,nights:2,rate_type:'PURE_POINTS'}});

// Deterministic DOM-shaped mock: evaluate callbacks inspect state set by actual
// form actions. No network, real browser, credentials, or live observations.
function formBrowser(options={}) {
  const state={visited:[],fills:[],clicks:[],values:{},selectedDates:[],submitted:false,monthMoves:0,reward:false};
  const displayDate=day=>options.locale==='gb'?`${String(day).padStart(2,'0')}/01/2030`:`01/${String(day).padStart(2,'0')}/2030`;
  const nodeFor=(role,name,index)=>{
    if(role==='combobox' && name==='Destination') return {value:options.destinationValue??state.values.Destination??''};
    if(role==='textbox' && typeof name==='string') return {value:options.badOccupancy===name?'99':state.values[name]??''};
    if(role==='textbox') return {value:displayDate(state.selectedDates[index??0])};
    if(role==='button' && name instanceof RegExp) {
      const inputs=state.selectedDates.map(day=>({value:displayDate(day)}));
      return {textContent:`Stay: ${inputs.map(x=>x.value).join(' - ')}`,querySelectorAll:()=>inputs,querySelector:()=>inputs[0]};
    }
    if(name==='Reward Nights') return {textContent:'Reward Nights',getAttribute:key=>key==='aria-checked'?String(state.reward):null};
    throw new Error(`Unimplemented mock DOM node: ${role} ${name}`);
  };
  const locator=(role,name,parent,index)=>({
    async fill(value){state.fills.push([name,value]);state.values[name]=value;},
    async click(){
      state.clicks.push(String(name));
      if(role==='gridcell')state.selectedDates.push(Number(name));
      if(name==='Next Month'||name==='Previous Month')state.monthMoves++;
      if(name instanceof RegExp && (name.test(options.nextLabel??'Next Month')||name.test(options.previousLabel??'Previous Month'))) {
        const label=options.unreachableMonth?(options.previousLabel??'Previous Month'):(options.nextLabel??'Next Month');
        assert.ok(name.test(label),'calendar navigation must match the visible exact button label');
        assert.ok(!name.test('Other '+label)&&!name.test(label+' Extra'),'calendar selector must be anchored');
        state.monthMoves++;
      }
      if(role==='menuitemradio' && name==='Reward Nights' && !options.ignoreRewardSelection)state.reward=true;
      if(name==='Search'||name==='View Prices')state.submitted=true;
    },
    async allTextContents(){
      if(name==='Choose Month')return [options.unreachableMonth?'February':options.startDecember&&state.monthMoves===0?'December':'January'];
      if(name==='Choose Year')return [options.startDecember&&state.monthMoves===0?'2029':'2030'];
      throw new Error(`Unexpected allTextContents: ${name}`);
    },
    async count(){return role==='gridcell'?(options.dayCount??1):1;},
    async isVisible(){
      if(role==='heading'){assert.equal(name,options.propertyName);return !options.wrongProperty;}
      assert.equal(role,'button');assert.equal(name,'Reward Nights');return state.reward;
    },
    nth(i){return locator(role,name,parent,i);},
    getByRole(childRole,opts={}){return locator(childRole,opts.name,{role,name},undefined);},
    filter(){return this;},
    async evaluate(callback,arg){return callback(nodeFor(role,name,index),arg);},
    async evaluateAll(callback){
      assert.equal(role,'textbox');assert.equal(parent?.role,'button');assert.ok(parent.name instanceof RegExp);
      return callback((options.dateValues??state.selectedDates.map(displayDate)).map(value=>({value})));
    },
    async inputValue(){return nodeFor(role,name,index).value;},
    async getAttribute(key){return nodeFor(role,name,index).getAttribute(key);},
    async textContent(){return nodeFor(role,name,index).textContent;}
  });
  const tab={
    async goto(url){state.visited.push(url);},
    async url(){return state.submitted?(options.afterUrl??'https://www.ihg.com/results'):(options.beforeUrl??state.visited.at(-1));},
    playwright:{
      getByRole:(role,opts={})=>locator(role,opts.name),
      async domSnapshot(){return state.submitted?(options.submittedSnapshot??'Twin room\n90,000 points total stay'):
        `${options.propertyName??'Example destination'}\n1 Room, 2 Guests\n${displayDate(19)}\n${displayDate(21)}\nReward Nights`;}
    }
  };
  return {tab,state};
}

test('submitSearchForm applies synthetic controls but keeps quote UNKNOWN',async()=>{
  const {tab,state}=formBrowser();const search=validSearch();
  const result=await submitSearchForm(tab,search,'Example destination');
  assert.equal(result.status,'UNKNOWN');assert.equal(result.stage,'SEARCH_SUBMITTED');
  assert.equal(result.requires_verification,true);assert.deepEqual(result.request,search.request);
  assert.deepEqual(state.selectedDates,[19,21]);
  assert.deepEqual(state.fills,[['Destination','Example destination'],['rooms','1'],['adults','2'],['children','0']]);
  assert.equal(state.reward,true);assert.equal(state.submitted,true);
});

test('submitSearchForm rejects redirect before entering trip data',async()=>{
  const {tab,state}=formBrowser({beforeUrl:'https://other.example/reservation'});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/redirect|destination|origin/i);
  assert.equal(state.fills.length,0);assert.equal(state.submitted,false);
});
test('submitSearchForm rejects redirect after submission',async()=>{
  const {tab,state}=formBrowser({afterUrl:'https://other.example/results'});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/redirect|destination|origin/i);
  assert.equal(state.submitted,true);
});

test('submitSearchForm rejects invalid requests before navigating',async()=>{
  const mutations=[
    s=>s.adapter_status='READY',s=>delete s.adapter_status,
    s=>s.request.checkin='2030-02-30',s=>s.request.checkin='01/19/2030',
    s=>s.request.checkout=s.request.checkin,s=>s.request.checkout='2030-01-18',
    s=>s.request.rooms=0,s=>s.request.rooms=true,s=>s.request.rooms=1.5,
    s=>s.request.adults='2',s=>s.request.adults=-1,s=>s.request.children=1,
    s=>s.request.nights=3,s=>s.request.hotel='invalid',s=>s.request.brand='../bad',
    s=>s.request.rate_type='CASH_PLUS_POINTS',
    s=>s.request.hotel=12345,s=>s.request.hotel=['ABCDE'],s=>s.request.brand=['example-brand'],
    s=>s.search_url='https://user:pass@www.ihg.com/hotels/us/en/reservation'
  ];
  for(const mutate of mutations){
    const search=validSearch();mutate(search);const {tab,state}=formBrowser();
    await assert.rejects(()=>submitSearchForm(tab,search,'Example destination'),undefined,JSON.stringify(search));
    assert.equal(state.visited.length,0,'invalid request must not navigate');
  }
});
test('submitSearchForm rejects ambiguous calendar days without submitting',async()=>{
  const {tab,state}=formBrowser({dayCount:2});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/ambiguous/i);
  assert.equal(state.selectedDates.length,0);assert.equal(state.submitted,false);
});
test('submitSearchForm bounds calendar navigation',async()=>{
  const {tab,state}=formBrowser({unreachableMonth:true});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/bound/i);
  assert.equal(state.monthMoves,24);assert.equal(state.submitted,false);
});
test('submitSearchForm checks actual destination value, not matching snapshot text',async()=>{
  const {tab,state}=formBrowser({destinationValue:'Wrong destination'});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/context|destination|value|control/i);
  assert.equal(state.submitted,false);
});
test('submitSearchForm checks actual occupancy value, not matching snapshot text',async()=>{
  const {tab,state}=formBrowser({badOccupancy:'adults'});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/context|occupancy|value/i);
  assert.equal(state.submitted,false);
});

test('submitSearchForm checks actual dates, not matching snapshot text',async()=>{
  const {tab,state}=formBrowser({dateValues:['01/19/2030','01/20/2030']});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/control|context/i);
  assert.equal(state.submitted,false);
});

test('submitSearchForm rejects a reward menu click that did not change the selected control',async()=>{
  const {tab,state}=formBrowser({ignoreRewardSelection:true});
  await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/reward option not selected/i);
  assert.ok(state.clicks.includes('Reward Nights'));assert.equal(state.reward,false);assert.equal(state.submitted,false);
});
test('submitSearchForm rejects redirected URLs containing userinfo',async()=>{
  for(const field of ['beforeUrl','afterUrl']) {
    for(const url of ['https://user:pass@www.ihg.com/results','https://user@www.ihg.com/results']) {
      const {tab,state}=formBrowser({[field]:url});
      await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/redirect|destination/i);
      if(field==='beforeUrl'){assert.equal(state.fills.length,0);assert.equal(state.submitted,false);}
      else assert.equal(state.submitted,true);
    }
  }
});
import {parseRatePanel} from './browser_adapter.mjs';
const syntheticPanel='850 heading PRICE FOR 1 ROOM,3 NIGHTS, Value:3\n 851 text PRICE FOR 1 ROOM , 3 NIGHTS\n852 text Room subtotal\n853 button Display rates for each night 90,000 PTS\n858 text Estimated Total Price\n859 text 90,000 PTS\n860 heading DESCRIPTION\n861 text Generic Points+Cash explanation';
test('selected detail panel total ignores unrelated card radio rates',()=>{
  const r=parseRatePanel('1 radio 20,000 points per night\n'+syntheticPanel,{rooms:1,nights:3});
  assert.equal(r.details_candidate.points_total,90000);assert.equal(r.status,'UNKNOWN');
});
test('selected detail panel rejects wrong nights, multiple totals and cash split',()=>{
  assert.equal(parseRatePanel(syntheticPanel,{rooms:1,nights:2}).details_candidate,undefined);
  assert.equal(parseRatePanel(syntheticPanel+'\n900 text Estimated Total Price\n901 text 80,000 PTS',{rooms:1,nights:3}).details_candidate,undefined);
  assert.equal(parseRatePanel(syntheticPanel.replace('859 text 90,000 PTS','859 text 70,000 PTS + 100 USD'),{rooms:1,nights:3}).details_candidate,undefined);
});

import {roomCard,readSelectedRate} from './browser_adapter.mjs';
const syntheticRoom='2 Twin Beds Standard';
const syntheticProperty='Example Hotel';
function cardAX({room=syntheticRoom,selected='90,000 points',code='ABCD',button=120}={}) {
  return `100 container ROOM_CODE${code}\n  101 heading ${room}, Value: 3\n  102 text Reward Nights available\n  103 radio button Select a payment option ${selected}, Value: 1\n  ${button} button Rate Details`;
}
function resultAX(card=cardAX()) {
  return `1 heading ${syntheticProperty}, Value: 1\n2 text field 01/19/2030\n3 text field 01/21/2030\n4 combo box (collapsed, settable) ROOMS & GUESTS, Value: 1 Room, 2 Guests, ID: room-and-guest, Secondary Actions: Expand\n${card}`;
}
function panelAX({rooms=1,nights=2,fees=true,total='90,000 PTS',cancellation=true}={}) {
  return `200 container Reward Nights\n201 button Close rate details information\n202 heading PRICE FOR ${rooms} ROOM, ${nights} NIGHTS, Value: 2\n203 text Estimated Total Price\n204 text ${total}\n${cancellation?'205 heading CANCELLATION POLICY, Value: 3\n206 text Cancel before arrival per fixture terms.':''}\n${fees?'207 heading TAXES AND ADDITIONAL CHARGES, Value: 3\n208 text Local tax may be payable.':''}\n209 heading SECURITY DEPOSIT, Value: 3\n210 text No fixture deposit.`.split('\n').map((line,i)=>i?'  '+line:line).join('\n');
}
function rateBrowser(options={}) {
  const req=validSearch().request;
  const query=new URLSearchParams({qSlH:req.hotel,qAdlt:String(req.adults),qRms:String(req.rooms),qChld:'0',
    qCiD:'19',qCiMy:'002030',qCoD:'21',qCoMy:'002030',qRtP:'RWD01'});
  const source=options.source??`https://www.ihg.com/example-brand/hotels/us/en/example/abcde/hoteldetail/rooms?${query}`;
  const state={open:options.alreadyOpen??false,clicks:[],closed:0};
  const tab={
    async url(){return state.clicks.length?(options.finalSource??source):source;},
    async getAXState(opts){assert.deepEqual(opts,{disableDiffing:true,emit:false});return state.open?(options.detail??panelAX()):(options.ax??resultAX());},
    async click(id){state.clicks.push(id);state.open=true;},
    playwright:{getByRole(role,opts){assert.equal(role,'button');assert.equal(opts.name,'Close rate details information');return {async click(){state.open=false;state.closed++;}};}}
  };
  return {tab,state};
}
const readRate=(tab,overrides={})=>readSelectedRate(tab,validSearch(),{propertyName:syntheticProperty,roomName:syntheticRoom,...overrides});

test('roomCard identifies exactly one selected pure-points card and its details button',()=>{
  const card=roomCard(resultAX(),syntheticRoom);assert.equal(card.detailsButton,120);assert.equal(card.roomName,syntheticRoom);
});
test('roomCard rejects wrong room, duplicate cards, ambiguous details and points-plus-cash',()=>{
  for(const ax of [resultAX(),resultAX(cardAX()+'\n'+cardAX({code:'EFGH',button:220})),
    resultAX(cardAX()+'\n 121 button Rate Details'),resultAX(cardAX({selected:'70,000 points + USD 100'}))]) {
    assert.throws(()=>roomCard(ax,ax===resultAX()?'1 King Bed Standard':syntheticRoom),/missing|ambiguous|pure-points/i);
  }
});
test('readSelectedRate extracts synthetic selected total with fee liability unresolved',async()=>{
  const {tab,state}=rateBrowser({alreadyOpen:true});const r=await readRate(tab);
  assert.equal(r.status,'AVAILABLE');assert.equal(r.quote.points_total,90000);assert.equal(r.quote.total_scope,'FULL_STAY');
  assert.equal(r.quote.bedding,'2 Twin');assert.equal(r.cash_total,null);assert.match(r.quote.fees_description,/Local tax/);
  assert.equal(state.closed,1);assert.deepEqual(state.clicks,[120]);
});
test('readSelectedRate rejects rendered hotel/date/occupancy mismatch before opening details',async()=>{
  for(const ax of [resultAX().replace(syntheticProperty,'Wrong Hotel'),resultAX().replace('01/21/2030','01/22/2030'),resultAX().replace('2 Guests','3 Guests')]){
    const {tab,state}=rateBrowser({ax});await assert.rejects(()=>readRate(tab),/context|occupancy/i);assert.equal(state.clicks.length,0);
  }
});
test('readSelectedRate rejects wrong requested room before clicking',async()=>{
  const {tab,state}=rateBrowser();await assert.rejects(()=>readRate(tab,{roomName:'1 King Bed Standard'}),/room card/i);assert.equal(state.clicks.length,0);
});
test('readSelectedRate returns UNKNOWN for mismatched panel nights/rooms and cash-plus-points total',async()=>{
  for(const detail of [panelAX({nights:3}),panelAX({rooms:2}),panelAX({total:'70,000 PTS + USD 100'})]){
    const {tab}=rateBrowser({detail});assert.equal((await readRate(tab)).status,'UNKNOWN');
  }
});
test('readSelectedRate returns UNKNOWN without fees, cancellation, or explicit bedding',async()=>{
  for(const detail of [panelAX({fees:false}),panelAX({cancellation:false})]){
    const {tab}=rateBrowser({detail});assert.equal((await readRate(tab)).status,'UNKNOWN');
  }
  const room='Standard Room';const {tab}=rateBrowser({ax:resultAX(cardAX({room}))});
  assert.equal((await readRate(tab,{roomName:room})).status,'UNKNOWN');
});
test('readSelectedRate rejects changed source during detail extraction',async()=>{
  for(const finalSource of ['https://other.example/results','https://www.ihg.com/other-result']){
    const {tab}=rateBrowser({finalSource});await assert.rejects(()=>readRate(tab),/Source changed/i);
  }
});
test('readSelectedRate rejects cash-plus-points selection and ambiguous cards before opening details',async()=>{
  for(const card of [cardAX({selected:'70,000 points + USD 100'}),cardAX()+'\n'+cardAX({code:'EFGH',button:220})]){
    const {tab,state}=rateBrowser({ax:resultAX(card)});await assert.rejects(()=>readRate(tab),/pure-points|ambiguous/i);assert.equal(state.clicks.length,0);
  }
});
test('readSelectedRate rejects malformed result source context before detail clicks',async()=>{
  const baseline=await rateBrowser().tab.url();
  for(const [key,value] of [['qSlH','FGHIJ'],['qAdlt','3'],['qRms','2'],['qChld','1'],['qCiD','20'],['qCoMy','012030'],['qRtP','CASH']]){
    const url=new URL(baseline);url.searchParams.set(key,value);const {tab,state}=rateBrowser({source:url.href});
    await assert.rejects(()=>readRate(tab),/context|dates/i);assert.equal(state.clicks.length,0);
  }
  for(const source of ['http://www.ihg.com/results','https://other.example/results','https://user:pass@www.ihg.com/results']){
    const {tab,state}=rateBrowser({source});await assert.rejects(()=>readRate(tab),/source/i);assert.equal(state.clicks.length,0);
  }
});
test('readSelectedRate rejects non-plus cash labels as selected points options',async()=>{
  for(const selected of ['70,000 points and USD 100','70,000 points USD 100','70,000 points cash']){
    const {tab,state}=rateBrowser({ax:resultAX(cardAX({selected}))});
    await assert.rejects(()=>readRate(tab),/pure-points/i);assert.equal(state.clicks.length,0);
  }
});
test('readSelectedRate scopes totals and fees to unique selected rate panel',async()=>{
  const unrelated='300 container Other content\n  301 text Estimated Total Price\n  302 text 1 PTS\n  303 heading TAXES AND ADDITIONAL CHARGES, Value: 3\n  304 text Unrelated free fees';
  const {tab}=rateBrowser({detail:panelAX()+'\n'+unrelated});assert.equal((await readRate(tab)).quote.points_total,90000);
  const missing=rateBrowser({detail:panelAX({fees:false})+'\n'+unrelated});assert.equal((await readRate(missing.tab)).status,'UNKNOWN');
  const duplicate=rateBrowser({detail:panelAX()+'\n'+panelAX()});await assert.rejects(()=>readRate(duplicate.tab),/panel.*ambiguous/i);
});
test('property search verifies heading and uses View Prices without a destination field',async()=>{
  const search=validSearch();search.search_url='https://www.ihg.com/example-brand/hotels/us/en/example/abcde/hoteldetail';
  const {tab,state}=formBrowser({propertyName:syntheticProperty});
  const r=await submitSearchForm(tab,search,null,{propertyName:syntheticProperty});
  assert.equal(r.status,'UNKNOWN');assert.equal(r.stage,'SEARCH_SUBMITTED');
  assert.ok(state.clicks.includes('View Prices'));assert.ok(!state.fills.some(([name])=>name==='Destination'));
});
test('property search rejects wrong heading and mismatched property URL',async()=>{
  const search=validSearch();search.search_url='https://www.ihg.com/example-brand/hotels/us/en/example/abcde/hoteldetail';
  const {tab,state}=formBrowser({propertyName:syntheticProperty,wrongProperty:true});
  await assert.rejects(()=>submitSearchForm(tab,search,null,{propertyName:syntheticProperty}),/heading mismatch/i);assert.equal(state.fills.length,0);
  search.search_url=search.search_url.replace('abcde','fghij');const wrong= formBrowser({propertyName:syntheticProperty});
  await assert.rejects(()=>submitSearchForm(wrong.tab,search,null,{propertyName:syntheticProperty}),/entry/i);assert.equal(wrong.state.visited.length,0);
});
test('readSelectedRate rejects duplicate query fields, including equal duplicates',async()=>{
  const baseline=await rateBrowser().tab.url();
  for(const key of ['qSlH','qAdlt','qRms','qChld','qCiD','qCiMy','qCoD','qCoMy','qRtP']) {
    for(const conflicting of [false,true]) {
      const url=new URL(baseline);url.searchParams.append(key,conflicting?'wrong':url.searchParams.get(key));
      const {tab,state}=rateBrowser({source:url.href});await assert.rejects(()=>readRate(tab),/duplicate/i);assert.equal(state.clicks.length,0);
    }
  }
});
test('roomCard stops at sibling containers and cannot borrow their rates or headings',()=>{
  const sibling='300 container Unrelated\n  301 heading '+syntheticRoom+', Value: 3\n  302 text Reward Nights available\n  303 radio button Select a payment option 90,000 points, Value: 1\n  304 button Rate Details';
  const valid=roomCard(cardAX()+'\n'+sibling,syntheticRoom);assert.equal(valid.detailsButton,120);assert.ok(!valid.block.includes('Unrelated'));
  const incomplete=cardAX().replace('  120 button Rate Details','');assert.throws(()=>roomCard(incomplete+'\n'+sibling,syntheticRoom),/details missing/i);
  assert.throws(()=>roomCard(cardAX({room:'1 King Bed Standard'})+'\n'+sibling,syntheticRoom),/room card missing/i);
});
test('readSelectedRate rejects substring lookalikes and duplicate rendered context nodes',async()=>{
  for(const ax of [
    resultAX().replace('heading Example Hotel, Value: 1','heading Example Hotel, Annex, Value: 1'),
    resultAX().replace('1 heading Example Hotel, Value: 1','1 text heading Example Hotel, Value: 1'),
    resultAX().replace('text field 01/19/2030','text field 01/19/20301'),
    resultAX().replace('2 text field 01/19/2030','2 text text field 01/19/2030'),
    resultAX().replace('Value: 1 Room, 2 Guests, ID:','Value: 11 Room, 2 Guests, ID:'),
    resultAX().replace('1 Room, 2 Guests','1 Room, 2 Guests extra'),
    resultAX()+'\n500 heading Example Hotel, Value: 2',
    resultAX()+'\n501 text field 01/19/2030',
    resultAX()+'\n502 combo box (collapsed, settable) ROOMS & GUESTS, Value: 1 Room, 2 Guests, ID: room-and-guest, Secondary Actions: Expand'
  ]) {
    const {tab,state}=rateBrowser({ax});await assert.rejects(()=>readRate(tab),/context|occupancy/i);assert.equal(state.clicks.length,0);
  }
});

import {checkRate} from './check_rate.mjs';
async function queryBrowser(options={}) {
  const rate=rateBrowser();const source=await rate.tab.url();
  const form=formBrowser({afterUrl:source,submittedSnapshot:options.submittedSnapshot});
  const state={reads:0,reloads:0};
  const tab={...form.tab,
    async getAXState(args){
      const n=state.reads++;
      const error=options.readErrors?.[n];if(error)throw error;
      if(options.readiness!==undefined&&n===0)return options.readiness;
      return rate.tab.getAXState(args);
    },
    click:rate.tab.click,
    async reload(){state.reloads++;if(options.reloadError)throw options.reloadError;},
    playwright:{...form.tab.playwright,getByRole(role,opts){
      if(opts?.name==='Close rate details information')return rate.tab.playwright.getByRole(role,opts);
      return form.tab.playwright.getByRole(role,opts);
    }}
  };
  return {tab,state,formState:form.state};
}
async function propertyQueryBrowser(options={}) {
  const q=await queryBrowser(options);
  // Use property mode with its observed heading and property entry URL.
  const old=q.tab.playwright.getByRole;
  q.tab.playwright.getByRole=(role,opts)=>role==='heading'?{async isVisible(){return opts.name===syntheticProperty;}}:old(role,opts);
  const snapshot=q.tab.playwright.domSnapshot;
  q.tab.playwright.domSnapshot=async()=>String(await snapshot()).replace('Example destination',syntheticProperty);
  return q;
}
const querySearch=()=>({...validSearch(),search_url:'https://www.ihg.com/example-brand/hotels/us/en/example/abcde/hoteldetail'});
const runPropertyQuery=tab=>checkRate(tab,querySearch(),{propertyName:syntheticProperty,roomName:syntheticRoom});
const timeout=message=>Object.assign(new Error(message),{name:'TimeoutError'});
test('checkRate completes synthetic workflow with measured stages',async()=>{
  const {tab,state}=await propertyQueryBrowser();const r=await runPropertyQuery(tab);
  assert.equal(r.status,'AVAILABLE');assert.equal(r.reloaded,false);assert.equal(state.reloads,0);
  assert.deepEqual(r.timing.stages.map(s=>s.name),['search_form','results_readiness','selected_rate']);
  assert.ok(r.timing.total_ms>=0);assert.ok(r.timing.stages.every(s=>s.elapsed_ms>=0));
});
test('checkRate permits one readiness timeout reload and never loops',async()=>{
  const recovered=await propertyQueryBrowser({readErrors:[new Error('Runtime.evaluate timed out. Increase the protocolTimeout setting in launch/connect calls for a higher timeout if needed.')]});
  const r=await runPropertyQuery(recovered.tab);assert.equal(r.status,'AVAILABLE');assert.equal(r.reloaded,true);assert.equal(recovered.state.reloads,1);
  const failed=await propertyQueryBrowser({readErrors:[new Error('Runtime.evaluate timed out. Increase the protocolTimeout setting in launch/connect calls for a higher timeout if needed.'),new Error('Runtime.evaluate timed out. Increase the protocolTimeout setting in launch/connect calls for a higher timeout if needed.')]});
  const unknown=await runPropertyQuery(failed.tab);assert.equal(unknown.status,'UNKNOWN');assert.equal(failed.state.reloads,1);
  assert.ok(unknown.timing.stages.some(s=>s.name==='results_readiness_after_reload'));
});
test('checkRate does not reload denials or arbitrary errors containing timeout',async()=>{
  for(const error of [timeout('Access denied: timeout'),timeout('CAPTCHA timeout'),new Error('Application timeout'),timeout('Transport timed out'),new Error('Runtime.evaluate timed out. Access denied')]){
    const {tab,state}=await propertyQueryBrowser({readErrors:[error]});const r=await runPropertyQuery(tab);
    assert.equal(r.status,'UNKNOWN');assert.equal(state.reloads,0);
  }
});
test('checkRate preserves BLOCKED from submitted snapshot and readiness',async()=>{
  const submitted=await propertyQueryBrowser({submittedSnapshot:'CAPTCHA verify you are human'});
  assert.equal((await runPropertyQuery(submitted.tab)).status,'BLOCKED');assert.equal(submitted.state.reads,0);
  const readiness=await propertyQueryBrowser({readiness:'Access denied'});
  assert.equal((await runPropertyQuery(readiness.tab)).status,'BLOCKED');assert.equal(readiness.state.reloads,0);
});
test('checkRate keeps missing results UNKNOWN and hides private exception messages',async()=>{
  const missing=await propertyQueryBrowser({readiness:'No supported room cards in this fixture'});
  assert.equal((await runPropertyQuery(missing.tab)).status,'UNKNOWN');assert.equal(missing.state.reloads,0);
  const privateError=await propertyQueryBrowser({readErrors:[new TypeError('private-trip-and-secret-query')]});
  const r=await runPropertyQuery(privateError.tab);assert.equal(r.error_type,'TYPE_ERROR');assert.ok(!JSON.stringify(r).includes('private-trip'));
});

test('checkRate also recognizes the observed DOMSnapshot protocol timeout',async()=>{
  const {tab,state}=await propertyQueryBrowser({readErrors:[new Error('DOMSnapshot.captureSnapshot timed out. Increase the protocolTimeout setting in launch/connect calls for a higher timeout if needed.')]});
  const r=await runPropertyQuery(tab);assert.equal(r.status,'AVAILABLE');assert.equal(state.reloads,1);
});
const resultsSearch=locale=>({...validSearch(),search_url:`https://www.ihg.com/example-brand/hotels/${locale}/en/find-hotels/select-roomrate?qSlH=ABCDE&qCiD=1&qCoD=2`});
const resultsOptions={propertyName:syntheticProperty,entryMode:'RESULTS_FORM'};
test('RESULTS_FORM edits stale inputs, verifies locale, skips destination and clicks Search',async()=>{
  for(const locale of ['us','gb']) {
    const {tab,state}=formBrowser({propertyName:syntheticProperty,locale});
    const r=await submitSearchForm(tab,resultsSearch(locale),null,resultsOptions);
    assert.equal(r.status,'UNKNOWN');assert.equal(r.stage,'SEARCH_SUBMITTED');
    assert.deepEqual(state.selectedDates,[19,21]);assert.ok(state.clicks.includes('Search'));assert.ok(!state.clicks.includes('View Prices'));
    assert.ok(!state.fills.some(([name])=>name==='Destination'));
  }
});
test('RESULTS_FORM rejects unsupported paths, origins, hotel and duplicate hotel query before navigation',async()=>{
  const base=resultsSearch('gb').search_url;
  for(const search_url of [base.replace('ABCDE','FGHIJ'),base+'&qSlH=ABCDE',base+'&qSlH=FGHIJ',
    base.replace('example-brand','other-brand'),base.replace('select-roomrate','select-hotel'),base.replace('/gb/','/fr/'),
    base.replace('www.ihg.com','other.example'),base.replace('https://','https://user@'),base.replace('qSlH=ABCDE','other=ABCDE')]) {
    const {tab,state}=formBrowser({propertyName:syntheticProperty,locale:'gb'});
    await assert.rejects(()=>submitSearchForm(tab,{...validSearch(),search_url},null,resultsOptions),/entry/i);assert.equal(state.visited.length,0);
  }
});
test('RESULTS_FORM requires exact heading and rejects redirected wrong hotel before edits',async()=>{
  const wrongHeading=formBrowser({propertyName:syntheticProperty,wrongProperty:true});
  await assert.rejects(()=>submitSearchForm(wrongHeading.tab,resultsSearch('us'),null,resultsOptions),/heading/i);assert.equal(wrongHeading.state.fills.length,0);
  const redirected=formBrowser({propertyName:syntheticProperty,beforeUrl:resultsSearch('us').search_url.replace('ABCDE','FGHIJ')});
  await assert.rejects(()=>submitSearchForm(redirected.tab,resultsSearch('us'),null,resultsOptions),/context/i);assert.equal(redirected.state.fills.length,0);
  const noHeading=formBrowser();await assert.rejects(()=>submitSearchForm(noHeading.tab,resultsSearch('us'),'Example destination',{entryMode:'RESULTS_FORM'}),/property name/i);
  assert.equal(noHeading.state.visited.length,0);
});
function failFormSnapshot(query,{afterSubmit=false,error=new Error('DOMSnapshot.captureSnapshot timed out.')}={}) {
  const snapshot=query.tab.playwright.domSnapshot;let fired=false;
  query.tab.playwright.domSnapshot=async()=>{
    if(!fired&&(!afterSubmit||query.formState.submitted)){fired=true;throw error;}
    return snapshot();
  };
}
test('checkRate retries form once after initial known transport failure',async()=>{
  const q=await propertyQueryBrowser();failFormSnapshot(q);
  const r=await runPropertyQuery(q.tab);assert.equal(r.status,'AVAILABLE');assert.equal(q.state.reloads,1);
  assert.equal(q.formState.clicks.filter(x=>x==='View Prices').length,1);
  assert.ok(r.timing.stages.some(s=>s.name==='search_form_after_reload'));
});
test('checkRate avoids duplicate submission when timed-out form already produced canonical results',async()=>{
  const q=await propertyQueryBrowser();failFormSnapshot(q,{afterSubmit:true});
  const r=await runPropertyQuery(q.tab);assert.equal(r.status,'AVAILABLE');assert.equal(q.state.reloads,1);
  assert.equal(q.formState.clicks.filter(x=>x==='View Prices').length,1);
  assert.ok(!r.timing.stages.some(s=>s.name==='search_form_after_reload'));
});
test('checkRate shares a single reload budget across form and readiness',async()=>{
  const q=await propertyQueryBrowser({readErrors:[undefined,new Error('Runtime.evaluate timed out.')]});failFormSnapshot(q);
  const r=await runPropertyQuery(q.tab);assert.equal(r.status,'UNKNOWN');assert.equal(q.state.reloads,1);
  assert.equal(r.timing.stages.filter(s=>s.name==='ordinary_reload').length,1);
});
test('checkRate never retries denied form failures or recovery challenges',async()=>{
  for(const error of [new Error('DOMSnapshot.captureSnapshot timed out. Access denied'),new Error('CAPTCHA timeout'),new Error('Unknown failure')]){
    const q=await propertyQueryBrowser();failFormSnapshot(q,{error});const r=await runPropertyQuery(q.tab);
    assert.equal(r.status,'UNKNOWN');assert.equal(q.state.reloads,0);assert.equal(q.formState.clicks.length,0);
  }
  const challenge=await propertyQueryBrowser({readiness:'Verify you are human CAPTCHA'});failFormSnapshot(challenge);
  assert.equal((await runPropertyQuery(challenge.tab)).status,'BLOCKED');assert.equal(challenge.state.reloads,1);assert.equal(challenge.formState.clicks.length,0);
});
test('checkRate does not reload a second form transport failure',async()=>{
  const q=await propertyQueryBrowser();q.tab.playwright.domSnapshot=async()=>{throw new Error('Runtime.evaluate timed out.');};
  const r=await runPropertyQuery(q.tab);assert.equal(r.status,'UNKNOWN');assert.equal(q.state.reloads,1);
});

test('calendar navigation supports both observed month button capitalizations',async()=>{
  for(const nextLabel of ['Next Month','Next month']) {
    const {tab,state}=formBrowser({startDecember:true,nextLabel});
    const r=await submitSearchForm(tab,validSearch(),'Example destination');
    assert.equal(r.stage,'SEARCH_SUBMITTED');assert.equal(state.monthMoves,1);
  }
  for(const previousLabel of ['Previous Month','Previous month']) {
    const {tab,state}=formBrowser({unreachableMonth:true,previousLabel});
    await assert.rejects(()=>submitSearchForm(tab,validSearch(),'Example destination'),/bound/i);
    assert.equal(state.monthMoves,24);
  }
});
