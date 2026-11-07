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
  const displayDate=day=>`01/${String(day).padStart(2,'0')}/2030`;
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
      if(role==='menuitemradio' && name==='Reward Nights' && !options.ignoreRewardSelection)state.reward=true;
      if(name==='Search')state.submitted=true;
    },
    async allTextContents(){
      if(name==='Choose Month')return [options.unreachableMonth?'February':'January'];
      if(name==='Choose Year')return ['2030'];
      throw new Error(`Unexpected allTextContents: ${name}`);
    },
    async count(){return role==='gridcell'?(options.dayCount??1):1;},
    async isVisible(){
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
      async domSnapshot(){return state.submitted?'Twin room\n90,000 points total stay':
        'Example destination\n1 Room, 2 Guests\n01/19/2030\n01/21/2030\nReward Nights';}
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
