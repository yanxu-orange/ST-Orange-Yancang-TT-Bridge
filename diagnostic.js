// Bounded production local diagnostics. No native/HTTP global hooks or resource inspection.
const KEY = 'yancang.tt.production.diagnostic.v1';
const BUILD = 'TT-PRODUCTION-1', LIMIT = 1024, MAX = 256 * 1024, WINDOW = 1200000, RETAIN = 86400000;
const prefixes = ['startup_cleanup','connection_cleanup','cancel_execution','notify_peer','registration_list','permission_off','registration_pause','registration_remove','proxy','registration_create','registration_activate','discover','permission_allow','queue','native_start','native_call','business','receipt'];
const stages = new Set(['page_start','visible','hidden','pagehide','click_connect','decode_ok','confirm','busy_guard','same_connection','local_detach','scope_stale','task_visible','result','retention_expired', ...prefixes.flatMap(p => [p+'_begin',p+'_end',p+'_fail'])]);
const kinds = new Set(['none','connect','receive','send','cancel','disconnect','status','get','put','catalog','thumbnail','beginBusiness','finish','itemFailed','known_response','not_sent','outcome_unknown','other','to_tt','from_tt','uncorrelated_id','initialize_timeout','initialize_failed','call_timeout','call_cancelled','response_failed']);
const fields = new Set(['generation','call','current','hasTask','businessStarted','sameTask','accepted']);
function validEvent(e) {
    if (!e || Object.keys(e).some(k => !['seq','segment','ms','stage','kind',...fields].includes(k))) return false;
    if (!Number.isInteger(e.seq) || e.seq < 0 || !Number.isInteger(e.segment) || e.segment < 1 || !Number.isFinite(e.ms) || e.ms < 0 || !stages.has(e.stage) || !kinds.has(e.kind)) return false;
    return [...fields].every(k => e[k] === undefined || (['generation','call'].includes(k) ? Number.isInteger(e[k]) && e[k] >= 0 && e[k] <= 65535 : typeof e[k] === 'boolean'));
}
function validTrace(t) {
    return t && Object.keys(t).sort().join(',') === ['schema','source','build','events','dropped','stopped','persistIncomplete'].sort().join(',') &&
        t.schema === 2 && t.source === 'extension' && t.build === BUILD && Array.isArray(t.events) && t.events.length <= LIMIT && t.events.every(validEvent) &&
        Number.isInteger(t.dropped) && t.dropped >= 0 && t.stopped === false && typeof t.persistIncomplete === 'boolean';
}
function classify(error) {
    // Inspect only in memory, project to fixed enum; never send exception text to the recorder.
    const text = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '';
    if (/expected id 1/.test(text) && /carried 0/.test(text)) return 'uncorrelated_id';
    if (text.includes('mcp.discovery_initialize_timeout') || text.includes('mcp.call_initialize_timeout')) return 'initialize_timeout';
    if (text.includes('mcp.discovery_initialize_failed') || text.includes('mcp.call_initialize_failed')) return 'initialize_failed';
    return 'other';
}
export function createDiagnostic({ storage = globalThis.localStorage, clock = () => performance.now(), wall = () => Date.now(), download = null } = {}) {
    let born = wall(), origin = clock(), segment = 1, seq = 0, events = [], dropped = 0, lastSave = -Infinity, saveTimer = null, cleared = false;
    const important = e => e.stage.endsWith('_fail') || ['page_start','click_connect','local_detach','confirm','task_visible','retention_expired'].includes(e.stage) || e.stage==='result' && !['known_response','other'].includes(e.kind);
    try {
        const raw = storage?.getItem(KEY);
        if (raw && raw.length <= MAX + 128) {
            const s = JSON.parse(raw);
            if (Object.keys(s).sort().join(',') === 'born,trace' && Number.isFinite(s.born) && wall()-s.born >= 0 && wall()-s.born < RETAIN && validTrace(s.trace) && s.trace.events.filter(important).length<=256 && s.trace.events.filter(e=>!important(e)).length<=768) {
                born = s.born; events = s.trace.events; dropped = s.trace.dropped;
                seq = Math.max(0,...events.map(e=>e.seq)); segment = Math.max(0,...events.map(e=>e.segment))+1;
            } else { storage?.removeItem(KEY); if (Number.isFinite(s.born) && wall()-s.born >= RETAIN) events=[{seq:++seq,segment,ms:0,stage:'retention_expired',kind:'none'}]; }
        }
    } catch { try { storage?.removeItem(KEY); } catch {} }
    function expire() {
        if (wall()-born < 0 || wall()-born >= RETAIN) {
            born=wall(); origin=clock(); segment++; events=[]; dropped=0;
            events.push({seq:++seq,segment,ms:0,stage:'retention_expired',kind:'none'});
        }
    }
    const snapshot = () => { expire(); return {schema:2,source:'extension',build:BUILD,events:events.map(e=>({...e})),dropped,stopped:false,persistIncomplete:true}; };
    function save() {
        saveTimer = null;
        if (cleared) return;
        try { const t = snapshot(); if (validTrace(t)) { const raw = JSON.stringify({born,trace:t}); if (raw.length <= MAX) storage?.setItem(KEY,raw); } lastSave=clock(); } catch {}
    }
    function event(stage, detail = {}) {
        try {
            expire();
            if (clock()-origin >= WINDOW || stage==='click_connect') { segment++; origin=clock(); }
            cleared=false;
            if (!stages.has(stage) || Object.keys(detail).some(k=>k!=='kind'&&!fields.has(k))) return;
            const e = {seq:seq+1,segment,ms:Math.max(0,Math.floor(clock()-origin)),stage,kind:detail.kind??'none'};
            for (const k of fields) if (detail[k] !== undefined) e[k] = detail[k];
            if (!validEvent(e)) return;
            seq++;
            const summary=important(e), same=events.map((v,i)=>important(v)===summary?i:-1).filter(i=>i>=0);
            if (same.length >= (summary?256:768)) { events.splice(same[0],1); dropped++; }
            events.push(e);
            if (clock()-lastSave >= 500) save(); else if (!saveTimer) saveTimer=setTimeout(save,500);
        } catch {}
    }
    async function run(stage, fn, detail = {}) {
        event(stage+'_begin',detail);
        try { const value=await fn(); event(stage+'_end',detail); return value; }
        catch(error) { event(stage+'_fail',{...detail,kind:classify(error)}); throw error; }
    }
    function result(value, detail = {}) {
        let kind = ['known_response','not_sent','outcome_unknown'].includes(value?.outcome) ? value.outcome : 'other';
        const codes = {'mcp.call_initialize_timeout':'initialize_timeout','mcp.call_initialize_failed':'initialize_failed','mcp.call_timeout':'call_timeout','mcp.call_cancelled':'call_cancelled','mcp.call_response_failed':'response_failed'};
        event('result',{...detail,kind:codes[value?.code]??kind});
    }
    function clear() { cleared=true; clearTimeout(saveTimer); saveTimer=null; events=[];dropped=0;seq=0;born=wall();origin=clock();segment++;try{storage?.removeItem(KEY);}catch{} }
    async function exportFile() {
        expire();
        const t=snapshot(); if (!validTrace(t)) throw new Error('diagnostic_export_unavailable');
        const text=JSON.stringify(t);if(new TextEncoder().encode(text).length>MAX)throw new Error('diagnostic_export_unavailable');
        if (download) await download(new Blob([text],{type:'application/json'}),'Yancang-TT-extension-diagnostic.json');
        else { const { downloadBlobWithRuntime } = await import('../../../file-export.js'); await downloadBlobWithRuntime(new Blob([text],{type:'application/json'}),'Yancang-TT-extension-diagnostic.json'); }
        return text;
    }
    event('page_start');
    return {event,run,result,clear,exportFile,snapshot,save};
}
export function attachDiagnostic(panel) {
    const d=createDiagnostic();
    const controls=document.createElement('div');
    controls.innerHTML='<details><summary>联动诊断</summary><button class="menu_button" data-diag-export>导出TT诊断</button><button class="menu_button" data-diag-clear>清除联动诊断</button><output data-diag-notice></output></details>';
    panel.querySelector('.inline-drawer-content').append(controls);
    const notice=controls.querySelector('[data-diag-notice]');
    controls.querySelector('[data-diag-export]').addEventListener('click',async()=>{try{await d.exportFile();const t=d.snapshot();notice.textContent=t.events.length===0?'暂无联动记录':t.events.some(e=>e.stage==='retention_expired')?'此前记录已过期，已导出最近记录':'TT诊断已导出';}catch{notice.textContent='诊断未保存，记录仍保留';}});
    controls.querySelector('[data-diag-clear]').addEventListener('click',()=>{d.clear();notice.textContent='本次诊断已清除';});
    document.addEventListener('visibilitychange',()=>d.event(document.visibilityState==='visible'?'visible':'hidden'));
    window.addEventListener('pagehide',()=>{d.event('pagehide');d.save();});
    return d;
}
