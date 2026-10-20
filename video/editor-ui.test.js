import test from 'node:test';
import assert from 'node:assert/strict';
import {controlMarkup,setControl} from './editor-ui.js';
test('icons retain an escaped visible name and are hidden from assistive speech',()=>{
  const markup=controlMarkup('play','<再生 & "停止">');
  assert.match(markup,/aria-hidden="true"/);assert.match(markup,/&lt;再生 &amp; &quot;停止&quot;&gt;/);
  assert.ok(!markup.includes('<再生'));
});
test('control updates avoid frame-by-frame DOM replacement and restore overwritten icons',()=>{
  let writes=0,html='',present=false;
  const element={dataset:{},set innerHTML(value){html=value;present=true;writes++;},querySelector(){return present?{}:null;},setAttribute(name,value){this[name]=value;}};
  setControl(element,'play','再生','曲を再生');setControl(element,'play','再生','曲を再生');assert.equal(writes,1);
  assert.equal(element['aria-label'],'曲を再生');assert.equal(element.title,'曲を再生');
  present=false;setControl(element,'play','再生');assert.equal(writes,2);
  setControl(element,'pause','停止');assert.equal(writes,3);assert.ok(html.includes('停止'));
});
