/* ADHDIKTED OBD-II driver: ELM327-compatible adapters over Web Bluetooth LE or Web Serial.
   Read-only except Mode 04 (clear codes). Never writes ECU parameters. */
(function(root){
var SVC=[0xFFF0,0xFFE0,0x18F0,0xFFE5,'6e400001-b5a3-f393-e0a9-e50e24dcca9e','e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
var PROTO=['','J1850 PWM','J1850 VPW','ISO 9141-2','KWP 5-baud','KWP fast','CAN 11/500','CAN 29/500','CAN 11/250','CAN 29/250'];
var P=[
['0C','RPM',function(a,b){return (a*256+b)/4},'rpm'],
['0D','SPEED',function(a){return Math.round(a*0.621371)},'mph'],
['04','LOAD',function(a){return a*100/255},'%'],
['05','COOLANT',function(a){return (a-40)*1.8+32},'°F'],
['0F','INTAKE TEMP',function(a){return (a-40)*1.8+32},'°F'],
['0B','MAP',function(a){return a*0.145038},'psi abs'],
['33','BARO',function(a){return a*0.145038},'psi'],
['10','MAF',function(a,b){return (a*256+b)/100},'g/s'],
['11','THROTTLE',function(a){return a*100/255},'%'],
['0E','TIMING',function(a){return a/2-64},'°'],
['06','STFT B1',function(a){return (a-128)*100/128},'%'],
['07','LTFT B1',function(a){return (a-128)*100/128},'%'],
['23','RAIL PRESS',function(a,b){return (a*256+b)*10*0.145038},'psi'],
['2F','FUEL LEVEL',function(a){return a*100/255},'%'],
['42','VOLTAGE',function(a,b){return (a*256+b)/1000},'V'],
['5C','OIL TEMP',function(a){return (a-40)*1.8+32},'°F'],
['46','AMBIENT',function(a){return (a-40)*1.8+32},'°F'],
['5E','FUEL RATE',function(a,b){return (a*256+b)/20*0.264172},'gal/h']
];
var DB={P0300:'Random/multiple cylinder misfire',P0171:'System too lean (bank 1)',P0172:'System too rich (bank 1)',P0174:'System too lean (bank 2)',P0175:'System too rich (bank 2)',P0420:'Catalyst efficiency below threshold (bank 1)',P0430:'Catalyst efficiency below threshold (bank 2)',P0401:'EGR flow insufficient',P0442:'EVAP small leak',P0455:'EVAP large leak',P0456:'EVAP very small leak',P0128:'Coolant below thermostat regulating temp',P0113:'Intake air temp sensor high',P0101:'MAF sensor range/performance',P0102:'MAF circuit low',P0135:'O2 sensor heater circuit (B1S1)',P0141:'O2 sensor heater circuit (B1S2)',P0335:'Crankshaft position sensor circuit',P0340:'Camshaft position sensor circuit',P0507:'Idle speed higher than expected',P0700:'Transmission control system fault',P2002:'Particulate filter efficiency below threshold'};
for(var i=1;i<=6;i++)DB['P030'+i]='Cylinder '+i+' misfire';

var dec=new TextDecoder(),enc=new TextEncoder();
var st={status:'idle',msg:'',adapter:'',proto:'',vin:'',mil:null,nd:0,values:{},dtcs:[],pending:[],read:false,log:[]};
var subs=[],T=null,SUP=[],protoNum=0,busy=Promise.resolve(),waiter=null,buf='';
function snap(){return Object.assign({},st,{values:Object.assign({},st.values),dtcs:st.dtcs.slice(),pending:st.pending.slice(),log:st.log.slice()});}
function emit(){var s=snap();subs.forEach(function(f){f(s)});}
function set(o){Object.assign(st,o);emit();}
function log(m){st.log.push(m);if(st.log.length>60)st.log.shift();}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)});}

/* transports */
async function openBLE(){
  var dev=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:SVC});
  var srv=await dev.gatt.connect(),svcs=await srv.getPrimaryServices(),rx=null,tx=null;
  for(var s of svcs){var cs=await s.getCharacteristics();for(var c of cs){var p=c.properties;if(!rx&&(p.notify||p.indicate))rx=c;if(!tx&&(p.write||p.writeWithoutResponse))tx=c;}if(rx&&tx)break;}
  if(!rx||!tx)throw new Error('No serial characteristic found on this device.');
  var cb=function(){};
  await rx.startNotifications();
  rx.addEventListener('characteristicvaluechanged',function(e){cb(dec.decode(e.target.value))});
  dev.addEventListener('gattserverdisconnected',function(){if(st.status==='connected')drop('Adapter disconnected.')});
  return{name:dev.name||'BLE adapter',onData:function(f){cb=f},
    write:function(t){var b=enc.encode(t);return (tx.properties.writeWithoutResponse&&!tx.properties.write)?tx.writeValueWithoutResponse(b):tx.writeValue(b)},
    close:function(){dev.gatt.disconnect()}};
}
async function openSerial(port,baud){
  await port.open({baudRate:baud});
  var w=port.writable.getWriter(),r=port.readable.getReader(),cb=function(){},alive=true;
  (async function(){try{while(alive){var x=await r.read();if(x.done)break;cb(dec.decode(x.value))}}catch(e){}})();
  return{name:'USB serial',onData:function(f){cb=f},write:function(t){return w.write(enc.encode(t))},
    close:async function(){alive=false;try{await r.cancel()}catch(e){}try{w.releaseLock();r.releaseLock();await port.close()}catch(e){}}};
}
async function serialT(){
  var port=await navigator.serial.requestPort(),bauds=[38400,115200];
  for(var b of bauds){var t=await openSerial(port,b);wire(t);try{await cmd('ATZ',3500);return t}catch(e){await t.close()}}
  throw new Error('Adapter not responding over USB serial.');
}

/* ELM327 layer */
function wire(t){T=t;buf='';t.onData(function(s){buf+=s;if(buf.indexOf('>')>=0&&waiter){var w=waiter,r=buf;waiter=null;buf='';w(r)}})}
function cmd(c,to){
  var p=busy.then(function(){return new Promise(function(res,rej){
    if(!T)return rej(new Error('Not connected'));
    buf='';
    var tm=setTimeout(function(){waiter=null;rej(new Error('Timeout: '+c))},to||6000);
    waiter=function(r){clearTimeout(tm);var L=r.replace(/>/g,'').split(/[\r\n]+/).map(function(x){return x.trim()}).filter(function(x){return x&&x!==c});log(c+' > '+L.join(' | '));res(L)};
    Promise.resolve(T.write(c+'\r')).catch(function(e){clearTimeout(tm);waiter=null;rej(e)});
  })});
  busy=p.catch(function(){});return p;
}
function hexLines(L){return L.map(function(l){return l.replace(/^\d+:\s*/,'')}).filter(function(l){return /^([0-9A-F]{2}\s?)+$/i.test(l)&&!/^[0-9A-F]{3}$/i.test(l)})}
function bytesOf(l){return l.trim().split(/\s+/).map(function(h){return parseInt(h,16)})}
async function q01(p){
  var hl=hexLines(await cmd('01'+p));
  for(var i=0;i<hl.length;i++){var b=bytesOf(hl[i]);if(b[0]===0x41&&b[1]===parseInt(p,16))return b.slice(2)}
  return null;
}
async function scan(){
  var out=[],base=0,more=true;
  while(more&&base<=0x60){
    var b=await q01(base.toString(16).toUpperCase().padStart(2,'0'));
    if(!b||b.length<4)break;
    var m=((b[0]<<24)|(b[1]<<16)|(b[2]<<8)|b[3])>>>0;
    for(var i=0;i<32;i++)if(m&(1<<(31-i)))out.push(base+i+1);
    more=!!(m&1);base+=0x20;
  }
  return out;
}
async function refreshMIL(){var b=await q01('01');if(b)set({mil:!!(b[0]&0x80),nd:b[0]&0x7F})}
async function init(t){
  wire(t);set({msg:'Initializing adapter…'});
  var ver=(await cmd('ATZ',4000)).join(' ');
  await cmd('ATE0');await cmd('ATL0');await cmd('ATH0');await cmd('ATSP0');
  var r=(await cmd('0100',15000)).join(' ');
  if(!/41 00/.test(r))throw new Error('Adapter connected, but the vehicle did not answer. Turn ignition ON (engine off is fine) and retry.');
  var dp=(await cmd('ATDPN')).join('').replace(/^A/,'');protoNum=parseInt(dp,16)||0;
  SUP=await scan();
  var name=(ver.match(/ELM\S*\s*v?[\d.]+/)||['ELM327-compatible'])[0];
  set({status:'connected',msg:'',adapter:(t.name||'')+' · '+name,proto:PROTO[protoNum]||('PROTO '+dp)});
  try{await refreshMIL()}catch(e){}
}
async function poll(){
  var want=P.filter(function(x){return SUP.indexOf(parseInt(x[0],16))>=0}),errs=0;
  if(!want.length){set({msg:'Vehicle reports no standard live PIDs.'});return}
  while(st.status==='connected'){
    for(var x of want){
      if(st.status!=='connected')return;
      try{var b=await q01(x[0]);if(b)st.values[x[1]]={v:x[2].apply(null,b),u:x[3]};errs=0}
      catch(e){if(st.status==='connected'&&++errs>5){drop('Lost communication with adapter.');return}}
      emit();
    }
  }
}
function closeT(t){try{Promise.resolve(t.close()).catch(function(){})}catch(e){}}
function drop(msg){var t=T;T=null;SUP=[];if(t)closeT(t);set({status:msg?'error':'idle',msg:msg||'',values:{}})}
async function start(getT){
  if(st.status==='connecting'||st.status==='connected')return;
  set({status:'connecting',msg:'Connecting…',values:{},dtcs:[],pending:[],read:false,vin:'',mil:null,nd:0});
  var t=null;
  try{t=await getT();await init(t);poll()}
  catch(e){if(t)closeT(t);T=null;set({status:'error',msg:e.name==='NotFoundError'?'No device selected.':e.message,values:{}})}
}

/* diagnostics */
async function codes(mode){
  var resp=parseInt(mode,16)+0x40,msgs=[],out=[];
  hexLines(await cmd(mode,8000)).forEach(function(l){var b=bytesOf(l);if(b[0]===resp)msgs.push(b.slice(1));else if(msgs.length)msgs[msgs.length-1]=msgs[msgs.length-1].concat(b)});
  msgs.forEach(function(d){
    if(protoNum>=6)d=d.slice(1);
    for(var i=0;i+1<d.length;i+=2){var a=d[i],c=d[i+1];if(!a&&!c)continue;
      var code=('PCBU'[a>>6]+((a>>4)&3)+(a&15).toString(16)+(c>>4).toString(16)+(c&15).toString(16)).toUpperCase();
      if(out.indexOf(code)<0)out.push(code)}
  });
  return out;
}
var api={
  caps:function(){return{ble:!!(root.navigator&&root.navigator.bluetooth),serial:!!(root.navigator&&root.navigator.serial)}},
  snapshot:snap,
  subscribe:function(f){subs.push(f);return function(){subs=subs.filter(function(x){return x!==f})}},
  connectBLE:function(){return start(openBLE)},
  connectSerial:function(){return start(serialT)},
  connectWith:function(getT){return start(getT)},
  disconnect:function(){drop('')},
  readCodes:async function(){var d=await codes('03');set({dtcs:d,read:true});await refreshMIL()},
  readPending:async function(){var d=await codes('07');set({pending:d,read:true})},
  clearCodes:async function(){var hl=hexLines(await cmd('04',8000));var ok=hl.some(function(l){return bytesOf(l)[0]===0x44});set({dtcs:[],pending:[],read:true});await refreshMIL();if(!ok)throw new Error('Vehicle did not confirm the clear. Try with ignition ON, engine off.')},
  readVIN:async function(){
    var bytes=[];
    hexLines(await cmd('0902',10000)).forEach(function(l){var b=bytesOf(l);if(b[0]===0x49&&b[1]===2)b=b.slice(3);bytes=bytes.concat(b)});
    var s=bytes.filter(function(x){return x>=32&&x<127}).map(function(x){return String.fromCharCode(x)}).join('');
    var m=s.match(/[A-HJ-NPR-Z0-9]{17}/);
    if(!m)throw new Error('VIN not available from this vehicle.');
    set({vin:m[0]});
  },
  describe:function(c){return DB[c]||'Not in the built-in list. Tap AI EXPLAIN.'}
};
root.ADOBD=api;
})(typeof window!=='undefined'?window:globalThis);
    
