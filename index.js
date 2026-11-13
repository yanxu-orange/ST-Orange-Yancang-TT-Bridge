// Independent interoperating extension. No TT implementation or model calls.
// Safe recent linkage diagnostics are available in ordinary builds.
let diagnostic = null, diagnosticCallSequence = 0, diagnosticLastTask = '';
const dEvent = (stage, detail = {}) => { try { diagnostic?.event(stage, { generation: connectionGeneration, ...detail }); } catch {} };
const dRun = (stage, fn, detail = {}) => diagnostic ? diagnostic.run(stage, fn, { generation: connectionGeneration, ...detail }) : fn();
const TOOL = 'yancang_single_card';
const OWNER = 'yancang-tt-single-card-v1';
const CHUNK = 96 * 1024, MAX_CARD = 64 * 1024 * 1024;
const CATALOG_PAGE_SIZE = 24, CATALOG_FETCH_TIMEOUT_MS = 40_000;
const STORAGE_KEY = 'yancangTTRegistration';
const CLIENT_KEY = 'yancangAndroidClient', ENABLED_KEY = 'yancangAndroidEnabled';
const ENDPOINT = 'http://127.0.0.1:18771/mcp';
let pairGeneration = 0, pairQueue = Promise.resolve(), pairCallId = null, reconnectTimer = null, reconnectDelay = 1500, autoEnabled = true; // Nonsecret registration ID only.
let connection = null, registrationId = null, callId = null, busy = false, stopped = false;
let pollTimer = null, polling = false;
const receivingOperations = new Set(), attemptedImports = new Set();
let entries = new Map(), catalogRequest = '', catalogIdentityKey = null, lastDisplayedTask = '', lastImportedOperation = '';
let refreshNeeded = false, thumbnailBusy = false;
const serialCalls = { tail: Promise.resolve() };
let operationGeneration = 0, currentTask = null;
let connectionGeneration = 0, actionGeneration = 0, connecting = false, ready = false;
let startupCleanup = Promise.resolve(), connectionCleanup = Promise.resolve();
const captureConnection = () => ({ value: connection, registration: registrationId, generation: connectionGeneration });
const isCurrent = scope => scope.generation === connectionGeneration && scope.value === connection && scope.registration === registrationId;
const requireCurrent = scope => { if (!isCurrent(scope)) { dEvent("scope_stale", { generation: scope.generation, current: false }); throw new Error("stale_connection"); } };
const panel = document.createElement('div');
panel.id = 'yancang-tt';
panel.innerHTML = `<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header"><b>砚藏联动</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content">
<div class="yc-actions"><button data-action="enable" class="menu_button">开启自动连接</button><button data-action="disconnect" class="menu_button" hidden>关闭连接</button></div>
<div data-pending hidden></div><div class="yc-actions"><button data-action="cancel" class="menu_button" hidden>取消本次传输</button></div>
<output role="status">未连接</output>
<button data-action="refresh" class="menu_button" hidden>刷新角色列表</button>
<details data-backup hidden><summary>备用：发送TT当前角色</summary><button data-action="send" class="menu_button">发送当前角色至砚藏预览</button></details>
</div></div>`;
function updatePanel() {
    const connected = ready && !!connection;
    panel.querySelector('[data-action="disconnect"]').hidden = !autoEnabled && !connected;
    panel.querySelector('[data-action="enable"]').hidden = autoEnabled;
    panel.querySelector('[data-backup]').hidden = !connected || currentTask?.direction !== 'from_tt' || !!currentTask.entryId;
    const pending = connected && currentTask?.direction === 'to_tt';
    panel.querySelector('[data-pending]').hidden = !pending;
    panel.querySelector('[data-action="cancel"]').hidden = !connected || !currentTask;
    panel.querySelector('[data-action="refresh"]').hidden = !refreshNeeded;
}
const status = text => { panel.querySelector('output').textContent = text; updatePanel(); };
const host = () => {
    const h = window.__TAURITAVERN__;
    if (!h?.api?.mcp || !h?.invoke?.safeInvoke) throw new Error('host_unavailable');
    return h;
};
async function settingsModule() { return await import('../../../extensions.js'); }
async function requestHeaders() { return (await import('../../../../script.js')).getRequestHeaders(); }
async function checkProxy() {
    const settings = await dRun('proxy', () => host().invoke.safeInvoke('get_tauritavern_settings'));
    const proxy = settings?.requestProxy ?? settings?.request_proxy;
    if (proxy?.enabled !== false) throw new Error('proxy_enabled');
}

async function forgetRegistration(id) {
    if (!id) return;
    const api = host().api.mcp;
    const record = (await dRun('registration_list', () => api.servers.list())).servers.find(s => s.id === id);
    // Never delete a registration not owned by this extension.
    if (record && record.displayName === OWNER && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(record.endpoint)) {
        await dRun('permission_off', () => api.tools.setPermission({ registrationId: id, nativeName: TOOL, permission: 'off' }));
        await dRun('registration_pause', () => api.servers.setState({ registrationId: id, state: 'paused' }));
        await dRun('registration_remove', () => api.servers.remove(id));
    }
    const module = await settingsModule();
    if (module.extension_settings[STORAGE_KEY] === id) {
        delete module.extension_settings[STORAGE_KEY];
        (await import('../../../../script.js')).saveSettingsDebounced();
    }
}
function disconnect(notify = true, invalidateAction = true) {
    pairGeneration++; clearTimeout(reconnectTimer);
    const scope = captureConnection(), execution = callId;
    // Detach before any native await: an old poll must not reanimate the UI,
    // and a queued call must never borrow a later registration/capability.
    dEvent('local_detach', { current: !!connection });
    connectionGeneration++; operationGeneration++;
    if (invalidateAction) actionGeneration++;
    clearTimeout(pollTimer); pollTimer = null;
    connection = null; registrationId = null; callId = null; currentTask = null;
    ready = false; connecting = false; stopped = true; polling = false;
    if (invalidateAction) busy = false;
    entries.clear(); catalogRequest = ''; catalogIdentityKey = null; serialCalls.tail = Promise.resolve();
    updatePanel();
    const cleanup = (async () => {
    if (execution) {
        try { await dRun('cancel_execution', () => host().invoke.safeInvoke('cancel_legacy_mcp_tool_call', { dto: { executionCallId: execution } })); } catch { /* No payload diagnostics. */ }
    }
    let peerEnded = false;
    if (notify && scope.value && scope.registration) {
        try { peerEnded = (await dRun('notify_peer', () => performCall('disconnect', {}, scope, true), { generation: scope.generation })).disconnected === true; } catch { /* An unreachable peer is not proof that its authorization ended. */ }
    }
    try { await forgetRegistration(scope.registration); } catch { /* Next startup retries the nonsecret owned ID. */ }
    return peerEnded;
    })();
    // A new pairing waits for old native teardown. Otherwise a late explicit
    // disconnect could detach a newly paired session.
    connectionCleanup = Promise.allSettled([connectionCleanup, cleanup]).then(() => {});
    return cleanup;
}
function call(action, extra = {}) {
    const scope = captureConnection();
    const call = ++diagnosticCallSequence;
    dEvent('queue_begin', { kind: action, call, generation: scope.generation });
    const attempt = serialCalls.tail.then(() => { dEvent('queue_end', { kind: action, call, generation: scope.generation }); return performCall(action, extra, scope, false, call); });
    serialCalls.tail = attempt.catch(() => {});
    return attempt;
}
async function performCall(action, extra = {}, scope = captureConnection(), detached = false, diagnosticCall = ++diagnosticCallSequence) {
    if (!detached) requireCurrent(scope);
    if (!scope.value || !scope.registration) throw new Error('permission_or_connection');
    await checkProxy();
    if (!detached) requireCurrent(scope);
    const argumentsJson = JSON.stringify({ sessionId: scope.value.sessionId, capability: scope.value.capability, action, clientRevision: 3, ...extra });
    if (new TextEncoder().encode(argumentsJson).length > 256 * 1024) throw new Error('size_limit');
    const id = crypto.randomUUID(); if (!detached) callId = id;
    let result;
    try {
        await dRun('native_start', () => host().invoke.safeInvoke('start_legacy_mcp_tool_call', { dto: { executionCallId: id } }), { kind: action, call: diagnosticCall, generation: scope.generation });
        if (!detached) requireCurrent(scope);
        result = await dRun('native_call', () => host().invoke.safeInvoke('call_legacy_mcp_tool', { dto: {
            executionCallId: id, toolId: `mcp/${scope.registration}:${TOOL}`, argumentsJson,
        } }), { kind: action, call: diagnosticCall, generation: scope.generation });
        try { diagnostic?.result(result, { call: diagnosticCall, generation: scope.generation }); } catch {}
    } finally { if (callId === id) callId = null; }
    if (!detached) requireCurrent(scope);
    if (result.outcome !== 'known_response') throw new Error(result.outcome === 'outcome_unknown' ? 'unknown' : 'permission_or_connection');
    if (result.response?.kind !== 'tool_result' || result.response.isError) throw new Error('rejected');
    let value;
    try { value = JSON.parse(result.response.structuredJson || result.response.textBlocks.map(b => b.text).join('')); }
    catch { throw new Error('invalid_response'); }
    if (value.operationCancelled) throw new Error('cancelled');
    return value;
}
function encode(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
}
function pairAndroid() {
    if (connecting || ready) return Promise.resolve();
    const attempt=++pairGeneration;connecting=true;
    const work=pairQueue.then(()=>pairAttempt(attempt));pairQueue=work.catch(()=>{});return work;
}
async function pairAttempt(attempt) {
    let module=null, localRegistration=null, created=false, execution=null;
    const active=()=>{if(attempt!==pairGeneration||!autoEnabled||module?.extension_settings[ENABLED_KEY]===false)throw Error('stale_pair');};
    const checked=async work=>{const value=await work;active();return value;};
    try {
        active();module=await checked(settingsModule());
        await checked(connectionCleanup); await checked(checkProxy());
        let client = module.extension_settings[CLIENT_KEY];
        if (!client || !/^[a-f0-9]{32}$/.test(client.clientId) || !/^[a-f0-9]{64}$/.test(client.secret)) {
            const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
            client = { clientId: crypto.randomUUID().replaceAll('-',''), secret };
            module.extension_settings[CLIENT_KEY] = client;
            (await checked(import('../../../../script.js'))).saveSettingsDebounced();
        }
        if (!registrationId) {
            const prior = module.extension_settings[STORAGE_KEY];
            const registrations = (await checked(host().api.mcp.servers.list())).servers;
            const existing = registrations.find(row => row.id === prior && row.displayName === OWNER && row.endpoint === ENDPOINT);
            if(!existing&&prior)await checked(forgetRegistration(prior));
            const registration = existing || await host().api.mcp.servers.create({displayName:OWNER,endpoint:ENDPOINT,headers:{},protocolVersion:'2025-03-26'});
            localRegistration=registration.id;created=!existing;active();registrationId=localRegistration;module.extension_settings[STORAGE_KEY]=localRegistration;
            (await checked(import('../../../../script.js'))).saveSettingsDebounced();
            await checked(host().api.mcp.servers.setState({registrationId:localRegistration,state:'active'}));
        }
        localRegistration=localRegistration||registrationId;active();
        await checked(host().api.mcp.servers.discover(localRegistration));
        await checked(host().api.mcp.tools.setPermission({registrationId:localRegistration,nativeName:'yancang_android_pair',permission:'allow'}));
        execution=crypto.randomUUID();pairCallId=execution;
        await checked(host().invoke.safeInvoke('start_legacy_mcp_tool_call',{dto:{executionCallId:execution}}));
        const result=await checked(host().invoke.safeInvoke('call_legacy_mcp_tool',{dto:{executionCallId:execution,toolId:`mcp/${localRegistration}:yancang_android_pair`,argumentsJson:JSON.stringify(client)}}));
        if(result.outcome!=='known_response'||result.response?.kind!=='tool_result'||result.response.isError)throw Error('unavailable');
        const value=JSON.parse(result.response.structuredJson||result.response.textBlocks.map(b=>b.text).join(''));
        if(value.state!=='connected') { status(value.state==='pending'?'请在砚藏 中允许首次连接':value.state==='denied'?'砚藏 尚未允许此连接':'等待砚藏'); return; }
        const parsed=value.credentials;
        if(!parsed||!Number.isInteger(parsed.port)||parsed.port!==18771||!/^[a-f0-9]{32}$/.test(parsed.sessionId)||!/^[a-f0-9]{64}$/.test(parsed.capability))throw Error('invalid_response');
        await checked(host().api.mcp.tools.setPermission({registrationId:localRegistration,nativeName:TOOL,permission:'allow'}));
        const identityKey = await checked(crypto.subtle.importKey(
            'raw', new TextEncoder().encode(client.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        ));
        active();connectionGeneration++;operationGeneration++;connection=parsed;stopped=false;ready=true;reconnectDelay=1500;
        catalogIdentityKey = identityKey;
        status('已连接砚藏');schedulePoll();
    } catch {
        if(attempt!==pairGeneration){if(created&&localRegistration)await forgetRegistration(localRegistration).catch(()=>{});return;}
        connection=null;ready=false;status('等待砚藏，后台自动重连');reconnectDelay=Math.min(15000,Math.round(reconnectDelay*1.5));
    } finally {
        if(pairCallId===execution)pairCallId=null;
        if(attempt!==pairGeneration&&execution)await host().invoke.safeInvoke('cancel_legacy_mcp_tool_call',{dto:{executionCallId:execution}}).catch(()=>{});
        if(attempt===pairGeneration){connecting=false;clearTimeout(reconnectTimer);if(!ready&&module?.extension_settings[ENABLED_KEY]!==false)reconnectTimer=setTimeout(pairAndroid,reconnectDelay);}
    }
}
async function taskFor(direction) {
    const info = await call('status');
    if (!info.task || info.task.direction !== direction || !/^[a-f0-9]{32}$/.test(info.task.operationId)) throw new Error('no_task');
    return info.task;
}
async function receive(task, scope, generation) {
    requireCurrent(scope);
    if (stopped || generation !== operationGeneration) throw new Error('cancelled');
    if (task.businessStarted || attemptedImports.has(task.operationId) || task.operationId === lastImportedOperation) throw new Error('unknown');
    if (!Number.isInteger(task.bytes) || task.bytes < 8 || task.bytes > MAX_CARD || task.chunkBytes !== CHUNK) throw new Error('invalid_response');
    const parts = [];
    const total = Math.ceil(task.bytes / CHUNK);
    for (let index = 0; index < total; index++) {
        if (stopped || generation !== operationGeneration) throw new Error('cancelled');
        const part = await call('get', { operationId: task.operationId, index });
        const bytes = Uint8Array.from(atob(part.chunk), c => c.charCodeAt(0));
        if (part.index !== index || bytes.length !== Math.min(CHUNK, task.bytes - index * CHUNK)) throw new Error('invalid_response');
        parts.push(bytes); status(`正在接收 ${index + 1} / ${total}`);
    }
    if (stopped || generation !== operationGeneration) throw new Error('cancelled');
    const body = new FormData();
    body.set('avatar', new File(parts, 'yancang-character.png', { type: 'image/png' }));
    body.set('file_type', 'png');
    const headers = await requestHeaders(); delete headers['Content-Type'];
    requireCurrent(scope);
    if (stopped || generation !== operationGeneration) throw new Error('cancelled');
    attemptedImports.add(task.operationId);
    if (attemptedImports.size > 128) attemptedImports.delete(attemptedImports.values().next().value);
    await call('beginBusiness', { operationId: task.operationId });
    requireCurrent(scope);
    if (stopped || generation !== operationGeneration) throw new Error('unknown');
    // A dispatched business import must never be automatically retried.
    status('正在导入角色卡…');
    let result;
    try {
        const response = await dRun('business', () => {
            requireCurrent(scope);
            if (stopped || generation !== operationGeneration) throw new Error('unknown');
            return fetch('/api/characters/import', { method: 'POST', headers, body });
        });
        if (!response.ok) throw new Error('unknown');
        result = await response.json();
        if (!result.file_name || result.replaced !== false) throw new Error('unknown');
    } catch { throw new Error('unknown'); }
    requireCurrent(scope);
    if (stopped || generation !== operationGeneration) throw new Error("unknown");
    lastImportedOperation = task.operationId;
    const post = result.post_import;
    const attachedWarning = !!post && (post.has_agent_profiles === true || post.has_agent_skills === true);
    try { await call('finish', { operationId: task.operationId, receipt: true, attachedWarning: !!attachedWarning }); }
    catch {
        requireCurrent(scope);
        if (stopped || generation !== operationGeneration) throw new Error('unknown');
        status('角色已导入TT，砚藏回执未确认；请勿重复发送'); await refreshCharacters(); return;
    }
    requireCurrent(scope);
    if (stopped || generation !== operationGeneration) throw new Error('unknown');
    status(attachedWarning ? '角色已导入，附带资料请查看TT提示' : '已导入 TauriTavern');
    await refreshCharacters();
}
async function receiveObserved(task, scope) {
    if (task.businessStarted || attemptedImports.has(task.operationId) || receivingOperations.has(task.operationId)) return;
    if (!/^[a-f0-9]{32}$/.test(task.operationId) || !isCurrent(scope) || stopped) return;
    receivingOperations.add(task.operationId);
    const generation = operationGeneration;
    busy = true; updatePanel();
    try { await receive(task, scope, generation); }
    finally { receivingOperations.delete(task.operationId); if (isCurrent(scope)) { busy = false; updatePanel(); } }
}
async function send() {
    const task = await taskFor('from_tt');
    if (task.entryId) throw new Error('selected_batch');
    const context = window.SillyTavern?.getContext?.();
    const id = context?.characterId;
    const character = id !== undefined && id !== null && id !== '' ? context.characters?.[id] : null;
    if (!character?.avatar || context.groupId) throw new Error('select_character');
    const avatar = character.avatar;
    if (!window.confirm(`发送「${String(character.name || '当前角色').slice(0, 120)}」至砚藏预览？`)) return;
    await exportSelected(task, avatar);
    currentTask = null;
    status('已接收，请返回砚藏完成导入预览');
}

async function exportSelected(task, avatar) {
    const generation = operationGeneration;
    status('正在准备所选角色卡，请等待发送完成后返回砚藏');
    const response = await fetch('/api/characters/export', { method: 'POST', headers: await requestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, format: 'png' }) });
    if (!response.ok) throw new Error('export_failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 8 || bytes.length > MAX_CARD) throw new Error('size_limit');
    if (![137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value)) throw new Error('export_failed');
    const total = Math.ceil(bytes.length / CHUNK);
    for (let index = 0; index < total; index++) {
        if (stopped || generation !== operationGeneration) throw new Error('cancelled');
        const chunk = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
        await call('put', { operationId: task.operationId, index, bytes: chunk.length, total: bytes.length,
            chunk: encode(chunk) });
        status(`正在发送 ${index + 1} / ${total}`);
    }
    if (generation !== operationGeneration) throw new Error('cancelled');
    return await call('finish', { operationId: task.operationId });

}
async function refreshCharacters() {
    try {
        await (await import('../../../../script.js')).getCharacters();
        refreshNeeded = false;
        panel.querySelector('[data-action="refresh"]').hidden = true;
    } catch {
        refreshNeeded = true;
        panel.querySelector('[data-action="refresh"]').hidden = false;
        status('已导入，角色列表刷新未完成；可仅刷新列表');
    }
}
function schedulePoll() {
    clearTimeout(pollTimer);
    if (connection && !stopped) pollTimer = setTimeout(poll, 1200);
}
async function thumbnail(id) {
    const scope = captureConnection();
    let encoded = '';
    const requestId = catalogRequest;
    const character = entries.get(id);
    if (character) try {
        const mod = await import('../../../../script.js');
        const image = new Image(); image.src = mod.getThumbnailUrl('avatar', character.avatar);
        await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/jpeg', 0.75).split(',')[1];
        if (data.length <= 87384) encoded = data;
    } catch { /* A thumbnail failure never changes card selection or reads a full PNG. */ }
    requireCurrent(scope);
    await call('thumbnail', { requestId, entryId: id, chunk: encoded });
}
async function catalogEntryId(key, avatar) {
    const input = new TextEncoder().encode('yancang/catalog/avatar/v1\0' + avatar);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
    return Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

async function readCatalogResponse() {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), CATALOG_FETCH_TIMEOUT_MS);
    try {
        const headers = await requestHeaders();
        const response = await dRun('catalog_fetch', () => fetch('/api/characters/all', {
            method: 'POST', headers, body: '{}', signal: abort.signal,
        }));
        if (!response.ok) throw new Error('catalog_failed');
        const list = await dRun('catalog_parse', () => response.json());
        if (!Array.isArray(list)) throw new Error('catalog_failed');
        return list;
    } finally {
        clearTimeout(timeout);
    }
}

async function publishCatalog(request) {
    const scope = captureConnection();
    const key = catalogIdentityKey;
    await call('catalogStarted', { requestId: request });
    try {
        const list = await readCatalogResponse();
        requireCurrent(scope);
        const candidates = new Map();
        for (const value of list) {
            if (typeof value?.avatar !== 'string' || !value.avatar || candidates.has(value.avatar)) continue;
            if (candidates.size >= 100000) break;
            candidates.set(value.avatar, String(value.name || '角色卡').slice(0, 120));
        }
        const rows = [...candidates];
        const activeEntries = new Map();
        for (let offset = 0; offset < Math.max(1, rows.length); offset += CATALOG_PAGE_SIZE) {
            const page = await Promise.all(rows.slice(offset, offset + CATALOG_PAGE_SIZE).map(async ([avatar, name]) => ({
                id: await catalogEntryId(key, avatar), avatar, name,
            })));
            requireCurrent(scope);
            for (const entry of page) activeEntries.set(entry.id, entry);
            const done = offset + CATALOG_PAGE_SIZE >= rows.length;
            if (done) entries = activeEntries;
            await call('catalog', {
                requestId: request, index: offset / CATALOG_PAGE_SIZE,
                entries: page.map(({ id, name }) => ({ id, name })), done,
            });
        }
        requireCurrent(scope);
        catalogRequest = request;
        status('角色列表已就绪，可返回砚藏选择');
    } catch (error) {
        if (!isCurrent(scope) || error?.message === 'cancelled') throw error;
        // A successful failure receipt retires the request even when the connection is still healthy.
        await call('catalogFailed', { requestId: request });
        requireCurrent(scope);
        status('角色列表读取中断，可返回砚藏重试');
    }
}
async function poll() {
    if (polling || busy || !connection || stopped) { schedulePoll(); return; }
    polling = true;
    const scope = captureConnection();
    try {
        const info = await call('status', { catalogLoaded: catalogRequest }); requireCurrent(scope);
        if (info.catalogRequest) await publishCatalog(info.catalogRequest);
        requireCurrent(scope);
        const task = info.task;
        dEvent('task_visible', { kind: task?.direction || 'none', hasTask: !!task, businessStarted: task?.businessStarted === true, sameTask: !!task && diagnosticLastTask === task.operationId });
        if (task) diagnosticLastTask = task.operationId;
        currentTask = task || null; updatePanel();
        const pending = panel.querySelector('[data-pending]');
        if (task?.direction === 'to_tt') {
            pending.textContent = task.businessStarted ? '已发出导入请求，等待结果；请勿重复接收' : `待接收：${String(task.name || '角色卡').slice(0, 120)}`;
            lastDisplayedTask = task.operationId;
            await receiveObserved(task, scope);
            requireCurrent(scope);
        } else pending.textContent = '';
        if (task?.direction === 'from_tt' && task.entryId) {
            const selected = entries.get(task.entryId);
            if (!selected) await call('itemFailed', { operationId: task.operationId });
            else {
                try { const result = await exportSelected(task, selected.avatar); if (result.batchComplete) { currentTask = null; status('已读取，请返回砚藏完成导入预览'); } }
                catch (error) {
                    if (error?.message === 'export_failed' || error?.message === 'size_limit') await call('itemFailed', { operationId: task.operationId });
                    else throw error;
                }
            }
        }
        // Decoration must not hold the task polling loop or end a valid connection.
        if (!task && !thumbnailBusy && Array.isArray(info.thumbnails) && info.thumbnails.length) {
            thumbnailBusy = true;
            void thumbnail(info.thumbnails[0]).catch(() => {}).finally(() => { thumbnailBusy = false; });
        }
    } catch (error) {
        if (!isCurrent(scope)) return;
        const lost = error?.message === 'permission_or_connection' || !errors[error?.message];
        status(lost ? 'TT通信暂时中断，正在等待自动重连' : errors[error.message]);
        if (error?.message === 'cancelled') { currentTask = null; stopped = false; updatePanel(); }
        else if (error?.message === 'proxy_enabled') await disconnect();
        else { await disconnect(false); if (autoEnabled) reconnectTimer=setTimeout(pairAndroid,reconnectDelay); } // Never replay a business request.
    } finally { if (isCurrent(scope)) { polling = false; schedulePoll(); } }
}
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (ready) schedulePoll(); else if (autoEnabled) void pairAndroid(); } });
const errors = {
    selected_batch: '角色已在砚藏选定，将按所选项目读取',
    rejected: '请求未被接受，请确认砚藏和配套扩展均已更新、本次连接仍有效',
    proxy_enabled: 'TT请求代理已开启，本次连接停止；请自行核对代理设置',
    no_task: '请先在砚藏发起对应的单卡发送或导入',
    select_character: '请先在TT正常选择一张角色卡', cancelled: '已取消传输',
    unknown: '上次发送结果未确认，不会自动重发；可主动开始新操作',
    permission_or_connection: 'TT通信暂时中断，正在等待自动重连',
    invalid_response: '联动响应无法识别，连接已结束；请更新两端后重试',
    size_limit: '角色卡超过本次传输上限', export_failed: 'TT未能导出该角色卡',
    host_unavailable: '需要官方 TauriTavern 2.3.0 的联动能力',
};
panel.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'enable') { autoEnabled=true; const module=await settingsModule(); module.extension_settings[ENABLED_KEY]=true; (await import('../../../../script.js')).saveSettingsDebounced(); await pairAndroid(); return; }
    if (action === 'disconnect') {
        autoEnabled=false; const module=await settingsModule(); module.extension_settings[ENABLED_KEY]=false; (await import('../../../../script.js')).saveSettingsDebounced();
        const ending = disconnect(); const generation = connectionGeneration;
        status('已断开TT连接，正在通知砚藏…');
        const ended = await ending;
        if (generation === connectionGeneration) status('已关闭连接，配对已保留');
        return;
    }
    if (action === 'cancel') {
        const scope = captureConnection();
        operationGeneration++;
        stopped = true;
        try {
            const task = (await call('status')).task;
            requireCurrent(scope);
            if (task) await call('cancel', { operationId: task.operationId });
            requireCurrent(scope);
            currentTask = null;
            status(task?.businessStarted ? '上次发送结果未确认，不会自动重发；可主动开始新操作' : '本次操作已取消，原连接仍有效');
        } catch { if (isCurrent(scope)) status('取消结果未确认，不会自动重发；可返回砚藏开始新操作'); }
        finally { if (isCurrent(scope)) { stopped = false; updatePanel(); schedulePoll(); } }
        return;
    }
    if (busy || polling) { dEvent('busy_guard'); status(connecting ? '正在连接砚藏…' : '正在处理本次任务，请稍候'); return; }
    const actionToken = ++actionGeneration;
    busy = true; stopped = false; updatePanel();
    try { if (action === 'send') await send(); else if (action === 'refresh') await refreshCharacters(); }
    catch (error) {
        if (actionToken !== actionGeneration || error?.message === 'stale_connection') return;
        status(errors[error?.message] || '连接或传输未完成，请检查连接与权限后重试');
        if (error?.message === 'proxy_enabled') await disconnect(ready, false);
    } finally { if (actionToken === actionGeneration) { busy = false; currentTask = null; updatePanel(); schedulePoll(); } }
});
jQuery(async () => {
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return;
    container.append(panel);
    try { diagnostic = (await import('./diagnostic.js')).attachDiagnostic(panel); } catch { /* Diagnostic failure must not alter business. */ }
    startupCleanup = (async () => {
        try { await forgetRegistration((await settingsModule()).extension_settings[STORAGE_KEY]); } catch { /* No data/secret diagnostics. */ }
    })();
    await startupCleanup;
    autoEnabled=(await settingsModule()).extension_settings[ENABLED_KEY]!==false;
    if(autoEnabled) await pairAndroid(); else status("已关闭连接");
});
window.addEventListener('pagehide', () => { void disconnect(); });
