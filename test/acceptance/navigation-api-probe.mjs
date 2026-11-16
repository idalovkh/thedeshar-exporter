import assert from 'node:assert/strict';

/** Probe the browser's native cross-world event timing without production hooks. */
export async function probeNavigationAPI({ evaluate, workerSession, sourceSession, sourceTabId, book, section }) {
  const installed = await evaluate(workerSession, `(async()=>{
    const result=await chrome.scripting.executeScript({target:{tabId:${sourceTabId},frameIds:[0]},world:'ISOLATED',func:()=>{
      if(!globalThis.navigation?.addEventListener) return {supported:false};
      const probe={epoch:0,events:[]}; globalThis.__navigationApiProbe=probe;
      document.documentElement.dataset.navigationProbeEpoch='0';
      navigation.addEventListener('currententrychange',event=>{
        probe.epoch++;
        probe.events.push({epoch:probe.epoch,isTrusted:event.isTrusted,type:event.navigationType,
          from:event.from?.url,to:navigation.currentEntry?.url,href:location.href});
        document.documentElement.dataset.navigationProbeEpoch=String(probe.epoch);
      });
      return {supported:true,currentEntry:navigation.currentEntry?.url};
    }});return result[0].result;
  })()`);
  assert.equal(installed.supported, true, 'Native Navigation API is unavailable in the extension isolated world');
  const ordering = await evaluate(sourceSession, `(async()=>{
    const snapshots=[];
    const run=(name,action)=>{const before=Number(document.documentElement.dataset.navigationProbeEpoch);action();
      snapshots.push({name,before,atReturn:Number(document.documentElement.dataset.navigationProbeEpoch),href:location.href});};
    run('same-url-replace',()=>history.replaceState({probe:1},'',location.href));
    run('push-to-section',()=>history.pushState({probe:2},'',${JSON.stringify(section)}));
    run('replace-back-to-book',()=>history.replaceState({probe:3},'',${JSON.stringify(book)}));
    await Promise.resolve();return {snapshots,afterMicrotask:Number(document.documentElement.dataset.navigationProbeEpoch)};
  })()`);
  const observed = await evaluate(workerSession, `(async()=>{
    const result=await chrome.scripting.executeScript({target:{tabId:${sourceTabId},frameIds:[0]},world:'ISOLATED',
      func:()=>globalThis.__navigationApiProbe});return result[0].result;
  })()`);
  for (const snapshot of ordering.snapshots) assert.ok(snapshot.atReturn > snapshot.before,
    `${snapshot.name}: isolated currententrychange did not run before the history call returned`);
  assert.equal(observed.epoch, ordering.afterMicrotask);
  assert.ok(observed.events.every(event => event.isTrusted));
  assert.deepEqual(observed.events.slice(-2).map(event => [event.from, event.to]), [[book, section], [section, book]]);
  return { installed, ordering, observed };
}
