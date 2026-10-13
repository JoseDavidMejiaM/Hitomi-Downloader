// ==UserScript==
// @name         Hitomi.la descarga de galerias por tags
// @namespace    https://github.com/JoseDavidMejiaM/Hitomi-Downloader
// @version      1.0
// @description  Descarga por lotes galerias de hitomi.la como HTML autonomo. Tabla persistente, historial TXT, reintentos, interfaz grafica. Inicia minimizado.
// @author       JoseDavidMejiaM
// @homepage     https://github.com/JoseDavidMejiaM/Hitomi-Downloader
// @supportURL   https://github.com/JoseDavidMejiaM/Hitomi-Downloader/issues
// @match        https://hitomi.la/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      hitomi.la
// @connect      *.hitomi.la
// @connect      gold-usergeneratedcontent.net
// @connect      *.gold-usergeneratedcontent.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // SECCION 1 — CONFIGURACION
    const CFG = {
        DELAY_BETWEEN_GALLERIES : 4000,
        DELAY_BETWEEN_IMAGES    : 150,
        IMAGE_CONCURRENCY       : 3,
        MAX_RETRIES             : 2,
        TIMEOUT_FETCH           : 45000,
        BACKOFF_BASE            : 1500,
        MAX_IDS_PER_LISTING     : 3000,
        GG_TTL                  : 5 * 60 * 1000,
        LOCK_STALE_MS           : 120000,
        IMAGE_PASSES            : 3,
        PASS_PAUSE              : 4000,
        SAVE_INCOMPLETE         : false,
        TXT_INCLUDE_HISTORY     : true,
        TABLE_PAGE_SIZE         : 50,
    };

    const IMG_DOMAIN   = 'gold-usergeneratedcontent.net';
    const LTN_HOSTS    = [`https://ltn.${IMG_DOMAIN}`, 'https://ltn.hitomi.la'];
    const NOZOMI_BASES = LTN_HOSTS.flatMap(h => [`${h}/n`, h]);

    const KNOWN_AREAS   = ['artist', 'group', 'series', 'character', 'type'];
    const GALLERY_TYPES = 'manga|doujinshi|gamecg|artistcg|imageset|anime|cg|reader|galleries';

    const KEY_ITEMS    = 'hdl_v5_items';
    const KEY_HISTORY  = 'hdl_v5_history';
    const KEY_PROGRESS = 'hdl_v5_progress';
    const KEY_META     = 'hdl_v5_meta';
    const KEY_RUNNING  = 'hdl_v5_running';
    const KEY_LOCK     = 'hdl_v5_lock';
    const KEY_LOG      = 'hdl_v5_log';
    const KEY_BASE     = 'hdl_v5_nozomi_base_idx';
    const KEY_UI_POS   = 'hdl_v5_ui_pos';

    const INSTANCE_ID = Math.random().toString(36).slice(2);
    let loopActive    = false;

    // SECCION 2 — UTILIDADES BASE
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $id   = id => document.getElementById(id);
    const esc   = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function appendLog(msg) {
        const logs = GM_getValue(KEY_LOG, []);
        logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (logs.length > 100) logs.splice(0, logs.length - 100);
        GM_setValue(KEY_LOG, logs);
    }
    const log  = (...a) => { console.log('[HitomiBatch]', ...a);   appendLog('i ' + a.join(' ')); };
    const warn = (...a) => { console.warn('[HitomiBatch]', ...a);  appendLog('! ' + a.join(' ')); };
    const err  = (...a) => { console.error('[HitomiBatch]', ...a); appendLog('x ' + a.join(' ')); };

    const safeDecode = s => { try { return decodeURIComponent(s); } catch (_) { return s; } };

    class HttpError extends Error {
        constructor(status, url) { super(`HTTP ${status} en ${url}`); this.status = status; }
    }
    const NO_RETRY = new Set([400, 401, 403, 404, 410]);

    function gmRequest(url, responseType, extraHeaders) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType,
                timeout: CFG.TIMEOUT_FETCH,
                headers: Object.assign({ 'Referer':'https://hitomi.la/','Origin':'https://hitomi.la','Accept':'*/*' }, extraHeaders),
                onload: resolve,
                onerror: () => reject(new Error(`Error de red en ${url}`)),
                ontimeout: () => reject(new Error(`Timeout (${CFG.TIMEOUT_FETCH}ms) en ${url}`)),
            });
        });
    }

    async function fetchURL(url, { responseType='text', retries=CFG.MAX_RETRIES, headers={} }={}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const resp = await gmRequest(url, responseType, headers);
                if (resp.status >= 200 && resp.status < 300) return resp;
                throw new HttpError(resp.status, url);
            } catch (e) {
                lastErr = e;
                if (e instanceof HttpError && NO_RETRY.has(e.status)) throw e;
                if (attempt >= retries) throw e;
                const wait = CFG.BACKOFF_BASE * Math.pow(2, attempt);
                warn(`Intento ${attempt+1}/${retries+1} fallo (${e.message}). Reintento en ${wait}ms...`);
                await sleep(wait);
            }
        }
        throw lastErr;
    }

    function sanitizeFilename(str) {
        return str.replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').trim().substring(0,170);
    }

    // SECCION 3 — LISTADOS: URL/TAG a IDs via .nozomi
    function makeSpec(ns, value) {
        ns    = (ns||'').toLowerCase().trim();
        value = (value||'').replace(/_/g,' ').trim().toLowerCase();
        if (!value) throw new Error(`Valor vacio para "${ns||'tag'}"`);
        if (ns === 'language')                return { lang: value };
        if (KNOWN_AREAS.includes(ns))         return { area: ns, tag: value };
        if (ns === 'female' || ns === 'male') return { area: 'tag', tag: `${ns}:${value}` };
        if (ns === '' || ns === 'tag')        return { area: 'tag', tag: value };
        return { area: 'tag', tag: `${ns}:${value}` };
    }

    function parseQueryTerms(terms) {
        const include = [], exclude = [];
        let lang = 'all';
        for (const raw of terms) {
            const neg  = raw.length > 1 && raw.startsWith('-');
            const t    = neg ? raw.slice(1) : raw;
            const i    = t.indexOf(':');
            const spec = i > 0 ? makeSpec(t.slice(0,i), t.slice(i+1)) : makeSpec('', t);
            if (spec.tag === undefined) { lang = spec.lang; continue; }
            (neg ? exclude : include).push(spec);
        }
        if (!include.length) include.push({ area:'', tag:'index' });
        return { include, exclude, lang };
    }

    function splitTerms(text) {
        const terms = [];
        for (const tk of text.trim().split(/\s+/).filter(Boolean)) {
            if (!terms.length || /^-?[a-z]+:/i.test(tk)) terms.push(tk);
            else terms[terms.length-1] += ' ' + tk;
        }
        return terms;
    }

    function parseListingUrl(urlStr) {
        const u    = new URL(urlStr, 'https://hitomi.la');
        let   path = safeDecode(u.pathname).replace(/^\/+/,'');

        if (/^search\.html$/i.test(path)) {
            const q = safeDecode(u.search.replace(/^\?/,'').replace(/\+/g,' ')).replace(/^q=/i,'').replace(/&page=\d+/i,'');
            if (!q.trim()) throw new Error('Busqueda vacia.');
            return parseQueryTerms(splitTerms(q));
        }

        path = path.replace(/\.html$/i,'');
        if (path === '') path = 'index-all';

        let m = path.match(/^index-([a-z]+)(?:-\d+)?$/i);
        if (m) return { include:[{area:'',tag:'index'}], exclude:[], lang:m[1].toLowerCase() };

        const slash = path.indexOf('/');
        if (slash > 0) {
            const area = path.slice(0,slash).toLowerCase();
            const rest = path.slice(slash+1);
            m = rest.match(/^(.+?)-([a-z]+)(?:-(\d+))?$/i);
            const tag  = m ? m[1] : rest;
            const lang = m ? m[2].toLowerCase() : 'all';
            let spec;
            if (area === 'tag') {
                const i = tag.indexOf(':');
                spec = i > 0 ? makeSpec(tag.slice(0,i),tag.slice(i+1)) : makeSpec('',tag);
            } else if (KNOWN_AREAS.includes(area)) {
                spec = makeSpec(area, tag);
            } else {
                spec = { area, tag };
            }
            if (spec.tag === undefined) return { include:[{area:'',tag:'index'}], exclude:[], lang:spec.lang };
            return { include:[spec], exclude:[], lang };
        }
        throw new Error(`No reconozco este tipo de pagina: ${urlStr}`);
    }

    const specPath = (spec, lang) => `${spec.area ? spec.area+'/' : ''}${spec.tag}-${lang}`;

    function listingLabel(l) {
        return l.include.map(s=>(s.area?s.area+':':'')+s.tag).join(' + ')
             + (l.exclude.length ? ' - '+l.exclude.map(s=>s.tag).join(', ') : '')
             + ` [${l.lang}]`;
    }

    function decodeNozomi(buf) {
        const out = [];
        if (!buf) return out;
        const dv = new DataView(buf);
        for (let i = 0; i+4 <= dv.byteLength; i += 4) {
            const id = dv.getUint32(i, false);
            if (id > 0 && id < 100000000) out.push(id);
        }
        return out;
    }

    async function fetchNozomi(path) {
        const rel   = encodeURI(path) + '.nozomi';
        const start = Math.min(GM_getValue(KEY_BASE,0), NOZOMI_BASES.length-1);
        const order = [start, ...NOZOMI_BASES.map((_,i)=>i).filter(i=>i!==start)];
        let lastErr;
        for (const idx of order) {
            const url = `${NOZOMI_BASES[idx]}/${rel}`;
            try {
                const r = await fetchURL(url, { responseType:'arraybuffer', retries:1 });
                if (/text\/html/i.test(r.responseHeaders||'')) throw new Error('Respuesta HTML en vez de binario');
                const ids = decodeNozomi(r.response);
                GM_setValue(KEY_BASE, idx);
                log(`Indice OK (${ids.length} IDs): ${url}`);
                return ids;
            } catch (e) { lastErr = e; }
        }
        throw new Error(`No existe el indice "${path}". Ultimo error: ${lastErr.message}`);
    }

    async function fetchListingIds(listing) {
        const lang = listing.lang || 'all';
        let ids = await fetchNozomi(specPath(listing.include[0], lang));
        for (const spec of listing.include.slice(1)) {
            const set = new Set(await fetchNozomi(specPath(spec, lang)));
            ids = ids.filter(x => set.has(x));
        }
        for (const spec of listing.exclude) {
            const set = new Set(await fetchNozomi(specPath(spec, lang)));
            ids = ids.filter(x => !set.has(x));
        }
        return ids;
    }

    async function resolveListing(listing) {
        log(`Listado: ${listingLabel(listing)}`);
        let ids = await fetchListingIds(listing);
        const found = ids.length;
        if (ids.length > CFG.MAX_IDS_PER_LISTING) {
            warn(`El listado tiene ${ids.length} galerias; se recorta a ${CFG.MAX_IDS_PER_LISTING}.`);
            ids = ids.slice(0, CFG.MAX_IDS_PER_LISTING);
        }
        const out = ids.map(String);
        out.found = found;          // total real encontrado, antes del recorte
        return out;
    }

    function galleryIdFromUrl(urlStr) {
        try {
            const u = new URL(urlStr, 'https://hitomi.la');
            const m = u.pathname.match(new RegExp(`^/(?:${GALLERY_TYPES})/(?:[^/]*-)?(\\d{3,9})\\.html$`,'i'));
            return m ? m[1] : null;
        } catch (_) { return null; }
    }

    async function collectIdsFromUrl(urlStr) {
        const gid = galleryIdFromUrl(urlStr);
        if (gid) { const one = [gid]; one.found = 1; return one; }
        return resolveListing(parseListingUrl(urlStr));
    }

    function resolveEntry(input) {
        const s = input.trim();
        if (/^https?:\/\//i.test(s) || s.startsWith('/')) {
            const url = new URL(s, 'https://hitomi.la');
            if (!/(^|\.)hitomi\.la$/i.test(url.hostname)) throw new Error('La URL no es de hitomi.la');
            const gid = galleryIdFromUrl(url.href);
            if (gid) return { type:'gallery', id:gid };
            return { type:'listing', listing:parseListingUrl(url.href) };
        }
        if (/^\d{3,9}$/.test(s)) return { type:'gallery', id:s };
        return { type:'listing', listing:parseQueryTerms(splitTerms(s)) };
    }

    // SECCION 3B — TABLA, HISTORIAL, REGLA DEL 100%
    const ST = { PENDING:'pending', RUNNING:'downloading', DONE:'done', FAILED:'failed' };

    const getItems    = () => GM_getValue(KEY_ITEMS, []);
    const saveItems   = items => GM_setValue(KEY_ITEMS, items);
    const getHistory  = () => GM_getValue(KEY_HISTORY, {});
    const saveHistory = h => GM_setValue(KEY_HISTORY, h);
    const getMeta     = () => GM_getValue(KEY_META, {});
    const patchMeta   = p => GM_setValue(KEY_META, Object.assign({}, getMeta(), p));

    const canonicalUrl = id => `https://hitomi.la/galleries/${id}.html`;
    const hasPending   = (items=getItems()) => items.some(it=>it.status===ST.PENDING||it.status===ST.RUNNING);
    const allDone      = items => items.length>0 && items.every(it=>it.status===ST.DONE);
    // Se puede exportar con todo completo, o con la tabla vacia si hay historial (p. ej. tras "Quitar completadas").
    const canExport    = items => items.every(it=>it.status===ST.DONE) && (items.length>0 || Object.keys(getHistory()).length>0);

    function summarize(items=getItems()) {
        const s = { total:items.length, pending:0, downloading:0, done:0, failed:0 };
        for (const it of items) if (it.status in s) s[it.status]++;
        return s;
    }

    function updateItem(id, patch) {
        const items = getItems();
        const it    = items.find(x=>x.id===id);
        if (!it) return null;
        Object.assign(it, patch, { t:Date.now() });
        saveItems(items);
        return it;
    }

    function galleryPageUrl(info, id) {
        try {
            if (info && info.galleryurl) {
                const u = new URL(info.galleryurl, 'https://hitomi.la');
                if (/(^|\.)hitomi\.la$/i.test(u.hostname) && galleryIdFromUrl(u.href)===String(id)) return u.href;
            }
        } catch (_) {}
        return canonicalUrl(id);
    }

    // Historial: importar TXT
    function parseGalleryLine(line) {
        if (/^\d{3,9}$/.test(line)) return { id:line, url:canonicalUrl(line) };
        const cand = (/^https?:\/\//i.test(line)||line.startsWith('/')) ? line : (line.match(/https?:\/\/\S+/i)||[])[0];
        if (!cand) return null;
        try {
            const u = new URL(cand, 'https://hitomi.la');
            if (!/(^|\.)hitomi\.la$/i.test(u.hostname)) return null;
            u.hash=''; u.search='';
            const id = galleryIdFromUrl(u.href);
            return id ? { id, url:u.href } : null;
        } catch (_) { return null; }
    }

    function parseTxtLinks(text) {
        const map = {};
        let ignored = 0;
        for (const raw of String(text).split(/\r?\n/)) {
            const line = raw.replace(/^\uFEFF/,'').trim();
            if (!line || line.startsWith('#')) continue;
            const g = parseGalleryLine(line);
            if (g) map[g.id] = g.url; else ignored++;
        }
        return { map, ignored };
    }

    function importTxtText(text) {
        const { map, ignored } = parseTxtLinks(text);
        const hist = getHistory();
        let added = 0;
        for (const [id, url] of Object.entries(map)) {
            if (!hist[id]) { hist[id]=url; added++; }
        }
        saveHistory(hist);
        const items = getItems();
        const keep  = items.filter(it=>!(it.status===ST.PENDING && map[it.id]));
        const dropped = items.length - keep.length;
        if (dropped) saveItems(keep);
        refreshQueueInfo();
        return { found:Object.keys(map).length, added, ignored, dropped };
    }

    async function importTxtFiles(files) {
        const list = [...files];
        if (!list.length) return;
        const tot = { found:0, added:0, ignored:0, dropped:0 };
        for (const f of list) {
            try {
                const r = importTxtText(await f.text());
                for (const k of Object.keys(tot)) tot[k]+=r[k];
                log(`TXT "${f.name}": ${r.found} enlaces (${r.added} nuevos).`);
            } catch (e) {
                err(`No se pudo leer "${f.name}": ${e.message}`);
            }
        }
        const total = Object.keys(getHistory()).length;
        const lines = [
            `TXT importado: ${tot.found} enlaces (${tot.added} nuevos)`,
            `Historial total: ${total} galerias`,
        ];
        if (tot.dropped) lines.push(`${tot.dropped} pendientes quitadas (ya descargadas)`);
        if (tot.ignored) lines.push(`${tot.ignored} lineas ignoradas`);
        updateStatus(lines.join('\n'), 'info');
    }

    // Tabla
    function addIds(ids) {
        const items   = getItems();
        const inTable = new Set(items.map(x=>x.id));
        const hist    = getHistory();
        let added=0, inHistory=0, inTbl=0;
        for (const id of ids) {
            if (hist[id])        { inHistory++; continue; }
            if (inTable.has(id)) { inTbl++;     continue; }
            items.push({ id, title:'', url:'', status:ST.PENDING, ok:0, total:0, err:'', tries:0, t:Date.now() });
            inTable.add(id);
            added++;
        }
        saveItems(items);
        if (inHistory) patchMeta({ skipped:(getMeta().skipped||0)+inHistory });
        refreshQueueInfo();
        return { added, inHistory, inTable:inTbl };
    }

    async function addManualEntries(rawText) {
        const lines  = rawText.split(/[\n;,]+/).map(l=>l.trim()).filter(Boolean);
        const errors = [];
        const tot    = { added:0, inHistory:0, inTable:0, found:0 };
        for (const line of lines) {
            try {
                const r = resolveEntry(line);
                let ids;
                if (r.type === 'gallery') {
                    ids = [r.id];
                } else {
                    updateStatus(`Leyendo indice...\n${listingLabel(r.listing)}`, 'info');
                    ids = await resolveListing(r.listing);
                    if (!ids.length) errors.push(`Sin resultados: ${line}`);
                }
                tot.found += (ids.found ?? ids.length);
                const res = addIds(ids);
                for (const k of ['added','inHistory','inTable']) tot[k]+=res[k];
            } catch (e) {
                errors.push(`"${line}": ${e.message}`);
                err(`Entrada manual "${line}":`, e.message);
            }
        }
        if (tot.found) patchMeta({ lastScan:{ label:'Manual', found:tot.found, added:tot.added, inHistory:tot.inHistory, inTable:tot.inTable, at:Date.now() } });
        return Object.assign(tot, { errors });
    }

    function retryItems(pred) {
        const items = getItems();
        let n = 0;
        for (const it of items) {
            if (it.status!==ST.RUNNING && pred(it)) { it.status=ST.PENDING; it.err=''; n++; }
        }
        saveItems(items);
        refreshQueueInfo();
        return n;
    }

    function archiveDone(items) {
        const h = getHistory();
        for (const it of items) if (it.status===ST.DONE) h[it.id]=it.url||canonicalUrl(it.id);
        saveHistory(h);
    }

    function removeItems(pred, force=false) {
        const items = getItems();
        const gone  = items.filter(it=>pred(it)&&(force||it.status!==ST.RUNNING));
        if (!gone.length) return 0;
        archiveDone(gone);
        saveItems(items.filter(it=>!gone.includes(it)));
        refreshQueueInfo();
        return gone.length;
    }

    function recoverInterrupted() {
        const items = getItems();
        let n = 0;
        for (const it of items) if (it.status===ST.RUNNING) { it.status=ST.PENDING; n++; }
        if (n) { saveItems(items); log(`${n} galeria(s) estaban a medias; vuelven a pendiente.`); }
    }

    // TXT de enlaces
    function collectDownloadedLinks() {
        const links = new Map();
        if (CFG.TXT_INCLUDE_HISTORY) for (const [id,url] of Object.entries(getHistory())) links.set(id,url);
        for (const it of getItems()) if (it.status===ST.DONE) links.set(it.id, it.url||canonicalUrl(it.id));
        return [...links.entries()].sort((a,b)=>Number(a[0])-Number(b[0])).map(([,url])=>url);
    }

    function stamp() {
        const d=new Date(), p=n=>String(n).padStart(2,'0');
        return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a   = Object.assign(document.createElement('a'), { href:url, download:filename, style:'display:none' });
        document.body.appendChild(a);
        a.click();
        setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 60000);
        log(`Descarga iniciada: ${filename}`);
    }

    function generateTxt() {
        const items = getItems();
        if (!canExport(items)) return false;
        const links = collectDownloadedLinks();
        const blob  = new Blob([links.join('\n')+'\n'], { type:'text/plain;charset=utf-8' });
        downloadBlob(blob, `hitomi_descargados_${stamp()}.txt`);
        archiveDone(items);
        patchMeta({ lastTxt:Date.now(), lastTxtCount:links.length });
        log(`TXT generado con ${links.length} enlaces.`);
        return true;
    }

    // SECCION 4 — GALERIA: galleryinfo + gg.js
    async function fetchGalleryInfo(id) {
        let lastErr;
        for (const host of LTN_HOSTS) {
            try {
                const r = await fetchURL(`${host}/galleries/${id}.js`, { retries:1 });
                return parseGalleryInfo(r.responseText);
            } catch (e) { lastErr=e; }
        }
        throw new Error(`galleryinfo de ${id} no disponible: ${lastErr.message}`);
    }

    function parseGalleryInfo(js) {
        const a=js.indexOf('{'), b=js.lastIndexOf('}');
        if (a<0||b<=a) throw new Error('galleryinfo vacio o con formato inesperado');
        return JSON.parse(js.slice(a,b+1));
    }

    function parseGG(text) {
        const map = new Map();
        let keys  = [];
        for (const mt of text.matchAll(/case\s+(\d+):(?:\s*o\s*=\s*(\d+))?/g)) {
            keys.push(+mt[1]);
            if (mt[2]!==undefined) { keys.forEach(k=>map.set(k,+mt[2])); keys=[]; }
        }
        for (const mt of text.matchAll(/if\s*\(\s*g\s*===?\s*(\d+)\s*\)[\s{]*o\s*=\s*(\d+)/g)) {
            map.set(+mt[1],+mt[2]);
        }
        const d = text.match(/(?:var\s|default:)\s*o\s*=\s*(\d+)/);
        const b = text.match(/\bb\s*[:=]\s*["']([^"']+)["']/);
        if (!b) throw new Error('gg.js: no se encontro gg.b');
        const def = d ? +d[1] : 0;
        return { m:g=>(map.has(g)?map.get(g):def), b:b[1].replace(/^\/+|\/+$/g,'') };
    }

    let ggCache = null;
    async function getGG(force=false) {
        if (!force && ggCache && Date.now()-ggCache.t<CFG.GG_TTL) return ggCache.v;
        let lastErr;
        for (const host of LTN_HOSTS) {
            try {
                const r = await fetchURL(`${host}/gg.js`, { retries:1, headers:{'Cache-Control':'no-cache'} });
                ggCache = { t:Date.now(), v:parseGG(r.responseText) };
                log(`gg.js cargado (b=${ggCache.v.b})`);
                return ggCache.v;
            } catch (e) { lastErr=e; }
        }
        throw new Error(`No se pudo cargar gg.js: ${lastErr.message}`);
    }

    function buildImageCandidates(file, gg) {
        const h    = file.hash;
        const inum = parseInt(h.slice(-1)+h.slice(-3,-1),16);
        const mval = gg.m(inum);
        const n    = 1+mval;
        const o    = n===1 ? 2 : 1;
        const p    = `${gg.b}/${inum}/${h}`;
        const c    = [];
        if (file.haswebp!==0) {
            c.push(`https://w${n}.${IMG_DOMAIN}/${p}.webp`);
            c.push(`https://w${o}.${IMG_DOMAIN}/${p}.webp`);
        }
        if (file.hasavif) c.push(`https://a${n}.${IMG_DOMAIN}/${p}.avif`);
        c.push(`https://${'ab'[mval]||'a'}a.hitomi.la/webp/${p}.webp`);
        return [...new Set(c)];
    }

    function detectMime(headers, url) {
        const m = (headers||'').match(/content-type:\s*([^\r\n;]+)/i);
        if (m && /^image\//i.test(m[1].trim())) return m[1].trim();
        if (/\.avif/i.test(url)) return 'image/avif';
        if (/\.webp/i.test(url)) return 'image/webp';
        if (/\.png/i.test(url))  return 'image/png';
        if (/\.gif/i.test(url))  return 'image/gif';
        return 'image/jpeg';
    }

    function bufferToDataURL(buf, mime) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload  = () => resolve(fr.result);
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(new Blob([buf], { type:mime }));
        });
    }

    async function downloadImage(file, gg) {
        for (const url of buildImageCandidates(file, gg)) {
            try {
                const r = await fetchURL(url, { responseType:'arraybuffer', retries:1 });
                if (!r.response || r.response.byteLength<100) continue;
                return await bufferToDataURL(r.response, detectMime(r.responseHeaders, url));
            } catch (_) {}
        }
        return null;
    }

    // SECCION 5 — HTML DE SALIDA
    const READER_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--bg:#111;--bg2:#1c1c1e;--bg3:#2a2a2e;--accent:#7c3aed;--text:#e5e5e5;--muted:#888;--sidebar:220px}body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}header{display:flex;align-items:center;gap:10px;padding:8px 16px;background:var(--bg2);border-bottom:1px solid #333;flex-shrink:0}header h1{font-size:.95rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{font-size:.75rem;color:var(--muted);white-space:nowrap}.btn{background:var(--bg3);color:var(--text);border:1px solid #444;border-radius:5px;padding:5px 10px;cursor:pointer;font-size:.8rem}.btn:hover{background:var(--accent)}.main{display:flex;flex:1;min-height:0}.sidebar{width:var(--sidebar);background:var(--bg2);border-right:1px solid #333;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding:8px;flex-shrink:0}.thumb{width:100%;height:auto;border-radius:3px;cursor:pointer;opacity:.55;border:2px solid transparent}.thumb:hover{opacity:.9}.thumb.active{opacity:1;border-color:var(--accent)}.thumb-miss{padding:14px;text-align:center;background:#2a1a1a;color:#a66}.reader{flex:1;overflow-y:auto;overflow-x:hidden}.pages{display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px 8px}.page{position:relative;max-width:900px;width:100%}.page img{width:100%;height:auto;display:block}.page-label{position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.65);color:#fff;font-size:.7rem;padding:2px 6px;border-radius:4px;pointer-events:none}.miss{padding:60px 10px;text-align:center;background:#2a1a1a;color:#c88;border-radius:6px}body.paged .reader{overflow:hidden}body.paged .pages{flex-direction:row;flex-wrap:nowrap;gap:0;padding:0;height:100%;align-items:stretch}body.paged .page{min-width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:8px}body.paged .page img{width:auto;max-width:100%;max-height:100%;height:auto;object-fit:contain}footer{background:var(--bg2);border-top:1px solid #333;padding:4px 16px;font-size:.75rem;color:var(--muted);display:flex;gap:16px;flex-shrink:0}@media(max-width:700px){.sidebar{display:none}}`;

    const READER_JS = `var total=__TOTAL__,cur=1,paged=false;var reader=document.getElementById('reader'),sidebar=document.getElementById('sidebar');document.querySelectorAll('.page').forEach(function(p){var n=+p.dataset.page,im=p.querySelector('img'),t=document.createElement(im?'img':'div');t.className='thumb';t.dataset.page=n;t.title='Pagina '+n;if(im){t.src=im.src;t.loading='lazy';}else{t.textContent=n;t.className+=' thumb-miss';}t.onclick=function(){go(n);};sidebar.appendChild(t);});function mark(n){cur=n;document.querySelectorAll('.thumb').forEach(function(t){t.classList.toggle('active',+t.dataset.page===n);});var a=document.querySelector('.thumb.active');if(a)a.scrollIntoView({block:'nearest'});document.getElementById('statusPage').textContent='Pagina '+n+'/'+total;}function go(n){n=Math.max(1,Math.min(total,n));var el=document.getElementById('p'+n);if(!el)return;el.scrollIntoView(paged?{behavior:'instant',inline:'start',block:'nearest'}:{behavior:'smooth',block:'start'});mark(n);}function toggleMode(){paged=!paged;document.body.classList.toggle('paged',paged);document.getElementById('btnMode').textContent=paged?'Paginado':'Scroll';go(cur);}var obs=new IntersectionObserver(function(es){if(paged)return;es.forEach(function(e){if(e.isIntersecting)mark(+e.target.dataset.page);});},{root:reader,rootMargin:'-40% 0px -59% 0px',threshold:0});document.querySelectorAll('.page').forEach(function(p){obs.observe(p);});document.addEventListener('keydown',function(e){var k=e.key;if(k==='ArrowRight'||k==='d'||k==='D')go(cur+1);else if(k==='ArrowLeft'||k==='a'||k==='A')go(cur-1);else if(k===' '){e.preventDefault();go(cur+1);}else if(k==='Home')go(1);else if(k==='End')go(total);});mark(1);`;

    function buildComicParts(title, id, pages) {
        const total  = pages.length;
        const failed = pages.filter(p=>!p.src).length;
        const t      = esc(title);
        const head = `<!DOCTYPE html>\n<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${t}</title><style>${READER_CSS}</style></head><body>\n<header><h1>${t}</h1><span class="meta">ID ${esc(id)} · ${total-failed}/${total} pags${failed?' · '+failed+' fallidas':''}</span><button class="btn" id="btnMode" onclick="toggleMode()">Scroll</button><button class="btn" onclick="go(1)">|&lt;</button><button class="btn" onclick="go(cur-1)">&lt;</button><button class="btn" onclick="go(cur+1)">&gt;</button><button class="btn" onclick="go(total)">&gt;|</button></header>\n<div class="main"><nav class="sidebar" id="sidebar"></nav><div class="reader" id="reader"><div class="pages" id="pages">\n`;
        const body = pages.map((p,i)=>p.src
            ? `<div class="page" id="p${i+1}" data-page="${i+1}"><img src="${p.src}" width="${p.w||''}" height="${p.h||''}" alt="Pagina ${i+1}" loading="lazy" decoding="async"><span class="page-label">${i+1}/${total}</span></div>\n`
            : `<div class="page" id="p${i+1}" data-page="${i+1}"><div class="miss">Pagina ${i+1} no se pudo descargar</div></div>\n`);
        const tail = `</div></div></div>\n<footer><span id="statusPage">Pagina 1/${total}</span><span>Flechas o A/D para navegar · Espacio = siguiente · Home/End</span></footer>\n<script>${READER_JS.replace('__TOTAL__',String(total))}</script></body></html>`;
        return [head, ...body, tail];
    }

    // SECCION 6 — PROCESAR UNA GALERIA
    async function processGallery(id) {
        const prev = getItems().find(x=>x.id===id);
        updateItem(id, { status:ST.RUNNING, err:'', ok:0, tries:((prev&&prev.tries)||0)+1 });
        GM_setValue(KEY_PROGRESS, { id, done:0, total:0 });
        log(`Galeria ${id}`);
        updateStatus(`Leyendo datos de la galeria ${id}...`, 'info');

        try {
            const info  = await fetchGalleryInfo(id);
            const files = info.files || [];
            const title = String(info.title||info.japanese_title||`Galeria_${id}`).trim();
            const url   = galleryPageUrl(info, id);
            updateItem(id, { title, url, total:files.length });
            if (!files.length) throw new Error('la galeria no tiene archivos');
            log(`"${title}" — ${files.length} imagenes`);

            let gg = await getGG();
            const pages = files.map(f=>({ src:null, w:f.width, h:f.height }));
            let done=0, next=0;

            const worker = async () => {
                while (true) {
                    const i = next++;
                    if (i>=files.length) return;
                    pages[i].src = await downloadImage(files[i], gg);
                    done++;
                    GM_setValue(KEY_PROGRESS, { id, done, total:files.length });
                    updateProgressBar(title, done, files.length);
                    heartbeat();
                    await sleep(CFG.DELAY_BETWEEN_IMAGES);
                }
            };
            await Promise.all(Array.from({ length:Math.min(CFG.IMAGE_CONCURRENCY,files.length) }, worker));

            for (let pass=2; pass<=CFG.IMAGE_PASSES; pass++) {
                const missing = pages.map((p,i)=>(p.src?-1:i)).filter(i=>i>=0);
                if (!missing.length) break;
                warn(`Pasada ${pass}/${CFG.IMAGE_PASSES}: faltan ${missing.length} imagenes; refrescando gg.js...`);
                await sleep(CFG.PASS_PAUSE);
                try { gg = await getGG(true); } catch (e) { warn(`gg.js: ${e.message}`); }
                for (const i of missing) {
                    pages[i].src = await downloadImage(files[i], gg);
                    heartbeat();
                }
            }

            const ok   = pages.filter(p=>p.src).length;
            const lost = files.length - ok;

            if (lost===0 || (CFG.SAVE_INCOMPLETE && ok>0)) {
                const blob = new Blob(buildComicParts(title,id,pages), { type:'text/html;charset=utf-8' });
                downloadBlob(blob, `${sanitizeFilename(title)} [${id}].html`);
            }

            if (lost===0) {
                const row = updateItem(id, { status:ST.DONE, ok, total:files.length, err:'' });
                if (!row) { const h=getHistory(); h[id]=url; saveHistory(h); }
                log(`OK "${title}": ${ok}/${files.length}`);
                updateStatus(`OK: ${title}\n${ok}/${files.length} paginas`, 'success');
            } else {
                updateItem(id, { status:ST.FAILED, ok, total:files.length, err:`Faltan ${lost} de ${files.length} paginas` });
                warn(`"${title}": faltan ${lost} de ${files.length} paginas`);
                updateStatus(`Incompleta: ${title}\nFaltan ${lost}/${files.length} paginas`, 'error');
            }

        } catch (e) {
            err(`Galeria ${id}: ${e.message}`);
            updateItem(id, { status:ST.FAILED, err:e.message });
            updateStatus(`Error en galeria ${id}\n${e.message}`, 'error');
        } finally {
            GM_deleteValue(KEY_PROGRESS);
            refreshQueueInfo();
        }
    }

    // SECCION 7 — LOOP PRINCIPAL
    function heartbeat() { GM_setValue(KEY_LOCK, { owner:INSTANCE_ID, ts:Date.now() }); }
    function lockHeldByOther() {
        const l = GM_getValue(KEY_LOCK, null);
        return !!l && l.owner!==INSTANCE_ID && Date.now()-l.ts<CFG.LOCK_STALE_MS;
    }
    function releaseLock() {
        const l = GM_getValue(KEY_LOCK, null);
        if (l && l.owner===INSTANCE_ID) GM_deleteValue(KEY_LOCK);
    }

    function finishRun() {
        GM_setValue(KEY_RUNNING, false);
        setButtonState('idle');
        const items=getItems(), s=summarize(items);
        if (!items.length) {
            updateStatus('Tabla vacia. Examina un listado primero.', 'info');
        } else if (allDone(items)) {
            const ok = generateTxt();
            updateStatus(`100% completado! ${s.done} galerias\n${ok?'TXT de historial generado.':''}`, 'success');
            log('Tabla completada al 100%.');
        } else {
            updateStatus(`Vuelta terminada\nOK:${s.done}  Fallidas:${s.failed}  Pendientes:${s.pending}\nEl TXT se genera con el 100% completo.`, 'warn');
            log(`Vuelta terminada con ${s.failed} fallidas.`);
        }
        refreshQueueInfo();
    }

    async function runDownloadLoop() {
        if (loopActive) return;
        if (lockHeldByOther()) { setButtonState('idle'); updateStatus('Otra pestana ya esta descargando.','warn'); return; }
        loopActive = true;
        GM_setValue(KEY_RUNNING, true);
        heartbeat();
        recoverInterrupted();
        log('Loop de descarga iniciado.');
        try {
            while (GM_getValue(KEY_RUNNING,false)) {
                const next = getItems().find(it=>it.status===ST.PENDING);
                if (!next) { finishRun(); break; }
                await processGallery(next.id);
                if (!GM_getValue(KEY_RUNNING,false)) break;
                heartbeat();
                if (hasPending()) await sleep(CFG.DELAY_BETWEEN_GALLERIES);
            }
        } finally {
            loopActive = false;
            releaseLock();
            if (!GM_getValue(KEY_RUNNING,false)) log('Loop detenido.');
        }
    }

    // Iniciar: solo descarga, no recolecta
    function startLoop() {
        // Si la galeria en curso aun no termino (pausa reciente), el bucle sigue vivo: solo hay que reactivarlo.
        if (loopActive) GM_setValue(KEY_RUNNING, true);
        setButtonState('running');
        runDownloadLoop();
    }

    function retryFailedAndStart() {
        const n = retryItems(it=>it.status===ST.FAILED);
        if (!n) { updateStatus('No hay galerias fallidas.', 'warn'); return 0; }
        updateStatus(`Reintentando ${n} galeria(s) fallida(s)...`, 'info');
        startLoop();
        return n;
    }

    // Examinar todo: recolecta el listado completo del tag/artista actual y agrega a la cola
    async function examinarTodo() {
        const btn = $id('hdl-examine');
        if (btn) btn.disabled = true;
        updateStatus('Leyendo indice completo del listado...\nEsto puede tardar unos segundos.', 'info');
        try {
            const ids   = await collectIdsFromUrl(location.href);
            const found = ids.found ?? ids.length;
            const r     = addIds(ids);
            patchMeta({ lastScan:{ label:safeDecode(location.pathname), found, kept:ids.length, added:r.added, inHistory:r.inHistory, inTable:r.inTable, at:Date.now() } });
            const lines = [`Listado examinado: ${found} galerias encontradas`];
            if (found > ids.length) lines.push(`Aviso: solo se toman las ${ids.length} mas recientes (limite MAX_IDS_PER_LISTING)`);
            if (r.added)     lines.push(`${r.added} nuevas agregadas a la cola`);
            if (r.inHistory) lines.push(`${r.inHistory} omitidas (ya en historial)`);
            if (r.inTable)   lines.push(`${r.inTable} ya estaban en la tabla`);
            if (!r.added && !r.inHistory && !r.inTable) lines.push('No se encontraron galerias en esta pagina');
            updateStatus(lines.join('\n'), r.added>0 ? 'success' : 'warn');
        } catch (e) {
            err('Examinar todo:', e.message);
            updateStatus(`Error al examinar: ${e.message}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // SECCION 8 — PANEL DE INTERFAZ
    // Paleta con alto contraste: textos blancos sobre fondos oscuros bien diferenciados
    const C = {
        bg0:    '#06060e',   // fondo mas oscuro (status box, log)
        bg1:    '#0e0e1c',   // fondo del panel
        bg2:    '#161628',   // titlebar y footer
        bg3:    '#1e1e35',   // botones neutros y chips
        border: '#2e2e52',   // bordes
        acc:    '#7c3aed',   // acento violeta
        acc2:   '#c4b5fd',   // acento claro (titulos) — mas claro para mejor contraste
        text:   '#f1f5f9',   // texto principal — casi blanco
        muted:  '#94a3b8',   // texto secundario — gris mas claro que antes
        green:  '#22c55e',   // exito
        red:    '#f87171',   // error
        amber:  '#fbbf24',   // advertencia
        blue:   '#60a5fa',   // info
        // colores de botones de accion con mayor contraste
        btnTxt: '#ffffff',
    };

    let uiMinimized = true;
    let btnState    = 'idle';   // idle | running | paused

    function createUI() {
        if ($id('hdl-panel')) return;

        const savedPos = GM_getValue(KEY_UI_POS, null);

        const panel = document.createElement('div');
        panel.id = 'hdl-panel';
        panel.className = 'hdl-root';
        panel.style.cssText = `
            position:fixed;
            ${savedPos ? `top:${savedPos.top}px;left:${savedPos.left}px;right:auto;bottom:auto;` : 'bottom:20px;right:20px;'}
            z-index:2147483645;
            width:350px;
            font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
            font-size:12px;
            user-select:none;
            filter:drop-shadow(0 8px 40px rgba(0,0,0,.95));
        `;

        panel.innerHTML = `
<style>
/* Aislamiento: ignora reglas globales del sitio sobre div, button, table, a, etc. */
.hdl-root{all:initial;display:block;box-sizing:border-box}
.hdl-root *,.hdl-root *::before,.hdl-root *::after{all:revert;box-sizing:border-box}
#hdl-panel *{box-sizing:border-box}

/* Shell */
#hdl-shell{
    background:${C.bg1};
    border:1px solid ${C.border};
    border-radius:12px;
    overflow:hidden;
}

/* Titlebar */
#hdl-titlebar{
    display:flex;
    align-items:center;
    gap:8px;
    padding:9px 12px;
    background:${C.bg2};
    cursor:grab;
    border-bottom:2px solid ${C.border};
}
#hdl-titlebar:active{cursor:grabbing}
#hdl-logo{
    width:24px;height:24px;
    background:linear-gradient(135deg,${C.acc},#a855f7);
    border-radius:6px;
    display:flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:700;color:#fff;
    flex-shrink:0;
    letter-spacing:-.5px;
}
#hdl-title-text{
    flex:1;
    font-size:12px;
    font-weight:700;
    color:${C.acc2};
    letter-spacing:.2px;
}
#hdl-version{
    font-size:10px;
    color:${C.muted};
    background:${C.bg3};
    padding:2px 6px;
    border-radius:6px;
    border:1px solid ${C.border};
    font-weight:600;
}
.hdl-wbtn{
    width:20px;height:20px;
    border-radius:5px;
    border:1px solid ${C.border};
    background:${C.bg3};
    color:${C.muted};
    cursor:pointer;
    font-size:11px;font-weight:700;
    display:flex;align-items:center;justify-content:center;
    padding:0;
    transition:all .15s;
    flex-shrink:0;
}
.hdl-wbtn:hover{background:${C.border};color:${C.text}}

/* Body */
#hdl-body{padding:12px;display:flex;flex-direction:column;gap:9px;max-height:calc(100vh - 110px);overflow-y:auto}

/* Status box — contraste mejorado */
#hdl-status-box{
    background:${C.bg0};
    border:1px solid ${C.border};
    border-radius:8px;
    padding:10px 12px;
    font-size:11px;
    color:${C.muted};
    line-height:1.65;
    min-height:54px;
    white-space:pre-line;
    transition:border-color .2s, color .2s;
    font-weight:500;
}
#hdl-status-box.s-success{border-color:${C.green};color:#bbf7d0}
#hdl-status-box.s-error{border-color:${C.red};color:#fecaca}
#hdl-status-box.s-warn{border-color:${C.amber};color:#fef08a}
#hdl-status-box.s-info{border-color:${C.blue};color:#bfdbfe}

/* Barra de progreso */
#hdl-prog-wrap{display:none;gap:5px;flex-direction:column}
#hdl-prog-track{height:5px;background:${C.bg3};border-radius:3px;overflow:hidden;border:1px solid ${C.border}}
#hdl-prog-bar{height:100%;width:0%;background:linear-gradient(90deg,${C.acc},#a855f7);border-radius:3px;transition:width .3s}
#hdl-prog-meta{display:flex;justify-content:space-between;font-size:10px;color:${C.muted};font-weight:600}

/* Secciones */
.hdl-section{display:flex;flex-direction:column;gap:5px}
.hdl-section-label{
    font-size:9px;
    text-transform:uppercase;
    letter-spacing:1px;
    color:${C.muted};
    padding:0 2px;
    font-weight:700;
}
.hdl-row{display:flex;gap:5px}

/* Botones — texto blanco forzado, fondos con suficiente contraste */
.hdl-btn{
    flex:1;
    padding:7px 8px;
    border-radius:7px;
    border:1px solid transparent;
    color:#ffffff;
    cursor:pointer;
    font-family:inherit;
    font-size:11px;
    font-weight:600;
    transition:all .15s;
    white-space:nowrap;
    text-align:center;
    display:flex;align-items:center;justify-content:center;
    gap:4px;
    letter-spacing:.1px;
}
.hdl-btn:hover{filter:brightness(1.18);transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,0,0,.4)}
.hdl-btn:active{transform:translateY(0);filter:brightness(.95)}
.hdl-btn:disabled{opacity:.35;cursor:not-allowed;transform:none;filter:none;box-shadow:none}

/* Colores de botones con mayor contraste */
.hdl-btn-start{background:#6d28d9;border-color:#7c3aed}
.hdl-btn-pause{background:#374151;border-color:#4b5563}
.hdl-btn-examine{background:#0369a1;border-color:#0284c7}
.hdl-btn-manual{background:#065f46;border-color:#059669}
.hdl-btn-table{background:#0f5156;border-color:#0e7490}
.hdl-btn-import{background:#1e3a8a;border-color:#1d4ed8}
.hdl-btn-retry{background:#92400e;border-color:#b45309}
.hdl-btn-danger{background:#7f1d1d;border-color:#991b1b}

/* Separador fino entre grupos */
.hdl-divider{height:1px;background:${C.border};margin:1px 0}

/* Footer */
#hdl-footer{
    background:${C.bg2};
    border-top:2px solid ${C.border};
    padding:7px 12px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:6px;
}
#hdl-queue-info{
    font-size:10px;
    color:${C.muted};
    font-weight:600;
    white-space:nowrap;
}
#hdl-log-toggle{
    background:none;border:none;
    color:${C.muted};
    cursor:pointer;
    font-size:10px;
    padding:2px 6px;
    border-radius:4px;
    font-family:inherit;
    font-weight:600;
    flex-shrink:0;
}
#hdl-log-toggle:hover{color:${C.text};background:${C.bg3}}

/* Log */
#hdl-log-box{
    max-height:110px;
    overflow-y:auto;
    background:${C.bg0};
    border:1px solid ${C.border};
    border-radius:6px;
    padding:6px 8px;
    font-size:10px;
    color:${C.muted};
    white-space:pre-wrap;
    line-height:1.55;
    font-family:'Consolas','Courier New',monospace;
}
</style>

<div id="hdl-shell">
  <div id="hdl-titlebar">
    <div id="hdl-logo">DL</div>
    <span id="hdl-title-text">Hitomi-Downloader</span>
    <span id="hdl-version">v1.0</span>
    <button class="hdl-wbtn" id="hdl-minimize-btn" title="Expandir/Contraer">+</button>
    <button class="hdl-wbtn" id="hdl-close-btn" title="Cerrar">x</button>
  </div>

  <div id="hdl-body">
    <div id="hdl-status-box">Listo. Importa tu TXT y usa "Examinar todo" para cargar el listado.</div>

    <div id="hdl-prog-wrap">
      <div id="hdl-prog-meta">
        <span id="hdl-prog-label">Imagen 0/0</span>
        <span id="hdl-prog-pct">0%</span>
      </div>
      <div id="hdl-prog-track"><div id="hdl-prog-bar"></div></div>
    </div>

    <div class="hdl-section">
      <span class="hdl-section-label">Recolectar</span>
      <div class="hdl-row">
        <button class="hdl-btn hdl-btn-examine" id="hdl-examine">Examinar todo</button>
        <button class="hdl-btn hdl-btn-manual"  id="hdl-manual">Manual</button>
      </div>
    </div>

    <div class="hdl-divider"></div>

    <div class="hdl-section">
      <span class="hdl-section-label">Control de descarga</span>
      <div class="hdl-row">
        <button class="hdl-btn hdl-btn-start" id="hdl-start">Iniciar descarga</button>
        <button class="hdl-btn hdl-btn-pause" id="hdl-pause">Pausar</button>
      </div>
    </div>

    <div class="hdl-divider"></div>

    <div class="hdl-section">
      <span class="hdl-section-label">Historial y Tabla</span>
      <div class="hdl-row">
        <button class="hdl-btn hdl-btn-table"  id="hdl-table">Ver tabla</button>
        <button class="hdl-btn hdl-btn-import" id="hdl-import">Importar TXT</button>
      </div>
    </div>

    <div class="hdl-divider"></div>

    <div class="hdl-section">
      <span class="hdl-section-label">Mantenimiento</span>
      <div class="hdl-row">
        <button class="hdl-btn hdl-btn-retry"  id="hdl-retry">Reintentar fallidas</button>
        <button class="hdl-btn hdl-btn-danger" id="hdl-clear-table">Limpiar tabla</button>
      </div>
      <div class="hdl-row">
        <button class="hdl-btn hdl-btn-danger" id="hdl-clear-history">Limpiar historial</button>
        <button class="hdl-btn hdl-btn-danger" id="hdl-clear-all">Limpiar todo</button>
      </div>
    </div>

    <div id="hdl-log-box" style="display:none"></div>
  </div>

  <div id="hdl-footer">
    <span id="hdl-queue-info">Tabla: --</span>
    <button id="hdl-log-toggle">Log</button>
  </div>
</div>

<input type="file" id="hdl-file-input" accept=".txt,text/plain" multiple style="display:none">
`;

        document.body.appendChild(panel);

        $id('hdl-body').style.display      = 'none';
        $id('hdl-footer').style.display    = 'none';
        $id('hdl-minimize-btn').textContent = '+';

        $id('hdl-minimize-btn').onclick = toggleMinimize;
        $id('hdl-close-btn').onclick    = () => panel.remove();
        $id('hdl-titlebar').ondblclick  = toggleMinimize;
        $id('hdl-log-toggle').onclick   = () => {
            const lb = $id('hdl-log-box');
            lb.style.display = lb.style.display==='none' ? 'block' : 'none';
            refreshLog();
        };

        makeDraggable(panel, $id('hdl-titlebar'));
        clampPanel();
        window.addEventListener('resize', clampPanel);

        // Iniciar: solo inicia la descarga de lo que ya esta en cola
        $id('hdl-start').onclick = () => {
            const s = summarize();
            if (!hasPending()) {
                if (s.failed > 0) {
                    updateStatus(`No hay pendientes.\nHay ${s.failed} fallidas — usa "Reintentar fallidas".`, 'warn');
                } else if (s.total === 0) {
                    updateStatus('La cola esta vacia.\nUsa "Examinar todo" para cargar un listado.', 'warn');
                } else {
                    updateStatus('No hay galerias pendientes de descarga.', 'warn');
                }
                return;
            }
            startLoop();
        };

        // Pausar solo pausa; Reanudar solo reanuda. En reposo no hace nada (antes arrancaba el bucle
        // y, con todo completo, volvia a descargar el TXT en cada clic).
        $id('hdl-pause').onclick = () => {
            if (btnState === 'running') {
                GM_setValue(KEY_RUNNING, false);
                setButtonState('paused');
                updateStatus('Pausando...\nLa galeria en curso terminara y se detendra.', 'warn');
            } else if (btnState === 'paused') {
                startLoop();
            } else {
                updateStatus('No hay una descarga en curso.\nUsa "Iniciar descarga".', 'info');
            }
        };

        // Examinar todo: recolecta el listado completo del tag/artista actual
        $id('hdl-examine').onclick = examinarTodo;

        $id('hdl-table').onclick  = openTableModal;
        $id('hdl-manual').onclick = openManualModal;
        $id('hdl-import').onclick = () => $id('hdl-file-input').click();
        $id('hdl-retry').onclick  = retryFailedAndStart;

        $id('hdl-file-input').onchange = e => {
            const list = [...e.target.files];
            e.target.value = '';
            importTxtFiles(list);
        };

        $id('hdl-clear-table').onclick = () => {
            const s = summarize();
            if (!s.total) { updateStatus('La tabla ya esta vacia.', 'info'); return; }
            if (!confirm(`Vaciar la tabla (${s.total} filas)?\n- ${s.done} completadas pasan al historial\n- ${s.pending+s.failed} pendientes/fallidas se pierden\n\nEl historial NO se toca.`)) return;
            GM_setValue(KEY_RUNNING, false);
            removeItems(()=>true, true);
            GM_deleteValue(KEY_PROGRESS);
            patchMeta({ skipped:0, lastScan:null });
            updateStatus('Tabla vaciada.\nEl historial permanece intacto.', 'info');
            setButtonState('idle');
        };

        $id('hdl-clear-history').onclick = () => {
            const h = Object.keys(getHistory()).length;
            if (!h) { updateStatus('El historial ya esta vacio.', 'info'); return; }
            if (!confirm(`Eliminar el historial completo?\n- ${h} galerias registradas se olvidaran\n- La tabla NO se toca\n- La proxima recoleccion las incluira de nuevo`)) return;
            GM_deleteValue(KEY_HISTORY);
            patchMeta({ skipped:0 });
            refreshQueueInfo();
            updateStatus(`Historial eliminado (${h} registros borrados).\nLa tabla permanece intacta.`, 'warn');
        };

        $id('hdl-clear-all').onclick = () => {
            const s = summarize();
            const h = Object.keys(getHistory()).length;
            if (!s.total && !h) { updateStatus('Ya todo esta vacio.', 'info'); return; }
            if (!confirm(`ELIMINAR TODO?\n- Tabla: ${s.total} filas\n- Historial: ${h} galerias\n\nLas proximas recolecciones descargaran todo desde cero.`)) return;
            GM_setValue(KEY_RUNNING, false);
            removeItems(()=>true, true);
            GM_deleteValue(KEY_HISTORY);
            GM_deleteValue(KEY_PROGRESS);
            patchMeta({ skipped:0, lastScan:null, lastTxt:null, lastTxtCount:0 });
            refreshQueueInfo();
            updateStatus(`Todo eliminado.\nTabla (${s.total}) e historial (${h}) borrados.`, 'warn');
            setButtonState('idle');
        };

        refreshQueueInfo();
        setInterval(()=>{ if ($id('hdl-log-box') && $id('hdl-log-box').style.display!=='none') refreshLog(); }, 3000);
        setInterval(refreshQueueInfo, 4000);
        window.addEventListener('beforeunload', releaseLock);
    }

    function toggleMinimize() {
        uiMinimized = !uiMinimized;
        $id('hdl-body').style.display   = uiMinimized ? 'none' : '';
        $id('hdl-footer').style.display = uiMinimized ? 'none' : '';
        $id('hdl-minimize-btn').textContent = uiMinimized ? '+' : '-';
        clampPanel();
    }

    // Mantiene el panel dentro de la ventana (posicion guardada de otro monitor, ventana mas chica, panel expandido).
    function clampPanel() {
        const p = $id('hdl-panel');
        if (!p || !p.style.top || p.style.top==='auto') return;   // anclado abajo-derecha: no hace falta
        const r    = p.getBoundingClientRect();
        const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth  - r.width));
        const top  = Math.min(Math.max(0, r.top),  Math.max(0, window.innerHeight - r.height));
        p.style.left = left+'px';
        p.style.top  = top+'px';
    }

    function updateStatus(msg, type='') {
        const el = $id('hdl-status-box');
        if (!el) return;
        el.textContent = msg;
        el.className   = type ? `s-${type}` : '';
    }

    function updateProgressBar(title, current, total) {
        const wrap = $id('hdl-prog-wrap');
        if (!wrap) return;
        const pct = Math.round((current/total)*100);
        wrap.style.display = 'flex';
        $id('hdl-prog-bar').style.width       = pct+'%';
        $id('hdl-prog-label').textContent     = `Imagen ${current}/${total}`;
        $id('hdl-prog-pct').textContent       = pct+'%';
        const short = title.length>34 ? title.substring(0,31)+'...' : title;
        updateStatus(`Descargando: ${short}\n${current}/${total} imagenes (${pct}%)`, 'info');
    }

    function refreshQueueInfo() {
        const el = $id('hdl-queue-info');
        if (el) {
            const s = summarize(), h = Object.keys(getHistory()).length;
            el.textContent = `OK:${s.done} Fail:${s.failed} Pend:${s.pending} | Hist:${h}`;
        }
    }

    function refreshLog() {
        const el = $id('hdl-log-box');
        if (!el) return;
        el.textContent = GM_getValue(KEY_LOG,[]).slice(-30).join('\n');
        el.scrollTop   = el.scrollHeight;
    }

    function setButtonState(state) {
        const start = $id('hdl-start'), pause = $id('hdl-pause');
        btnState = state;
        if (!start) return;
        const prog = $id('hdl-prog-wrap');
        if (state==='running') {
            start.disabled    = true;
            pause.textContent = 'Pausar';
            pause.className   = 'hdl-btn hdl-btn-retry';
        } else if (state==='paused') {
            start.disabled    = false;
            pause.textContent = 'Reanudar';
            pause.className   = 'hdl-btn hdl-btn-manual';
        } else {
            start.disabled    = false;
            pause.textContent = 'Pausar';
            pause.className   = 'hdl-btn hdl-btn-pause';
            if (prog) prog.style.display = 'none';
        }
    }

    function makeDraggable(el, handle) {
        if (!handle) return;
        let dx, dy, dragging = false;
        handle.addEventListener('mousedown', e => {
            if (e.target.tagName==='BUTTON') return;
            e.preventDefault();
            const r = el.getBoundingClientRect();
            dx = e.clientX-r.left; dy = e.clientY-r.top;
            dragging = true;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        function onMove(ev) {
            if (!dragging) return;
            el.style.left   = (ev.clientX-dx)+'px';
            el.style.top    = (ev.clientY-dy)+'px';
            el.style.right  = 'auto';
            el.style.bottom = 'auto';
        }
        function onUp() {
            dragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            clampPanel();
            const r = el.getBoundingClientRect();
            GM_setValue(KEY_UI_POS, { top:Math.round(r.top), left:Math.round(r.left) });
        }
    }

    // SECCION 9 — MODAL TABLA
    const tbl = { filter:'all', page:0, timer:null, lastHtml:'' };
    const FILTERS = [
        ['all','Todas'],['pending','Pendientes'],['downloading','Descargando'],
        ['done','Completadas'],['failed','Fallidas'],
    ];

    const DONATE_KOFI   = 'https://ko-fi.com/josemejiam';
    const DONATE_PAYPAL = 'https://paypal.me/JoseDMejiaM';
    const GITHUB_URL    = 'https://github.com/JoseDavidMejiaM/Hitomi-Downloader';

    function openTableModal() {
        if ($id('hdl-tbl-overlay')) return;
        const ov = document.createElement('div');
        ov.id = 'hdl-tbl-overlay';
        ov.className = 'hdl-root';
        ov.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:2147483646;display:flex;align-items:center;justify-content:center`;

        ov.innerHTML = `
<style>
/* Aislamiento: ignora reglas globales del sitio sobre div, button, table, a, etc. */
.hdl-root{all:initial;display:block;box-sizing:border-box}
.hdl-root *,.hdl-root *::before,.hdl-root *::after{all:revert;box-sizing:border-box}
#hdl-tbl-modal *{box-sizing:border-box}
#hdl-tbl-modal{
    background:${C.bg1};
    border:1px solid ${C.border};
    border-radius:14px;
    padding:16px;
    width:1080px;
    max-width:96vw;
    max-height:92vh;
    display:flex;
    flex-direction:column;
    font-family:'Segoe UI',system-ui,sans-serif;
    color:${C.text};
    font-size:12px;
    box-shadow:0 20px 60px rgba(0,0,0,.95);
}
#hdl-tbl-header{
    display:flex;
    align-items:center;
    justify-content:space-between;
    margin-bottom:12px;
    padding-bottom:10px;
    border-bottom:1px solid ${C.border};
}
#hdl-tbl-title{font-size:14px;font-weight:700;color:${C.acc2}}

/* Chips de resumen */
.hdl-t-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.hdl-t-chip{
    background:${C.bg3};
    border:1px solid ${C.border};
    border-radius:20px;
    padding:3px 10px;
    font-size:11px;
    color:${C.muted};
    font-weight:600;
}
.hdl-t-chip.c-ok{color:#86efac;border-color:#166534}
.hdl-t-chip.c-err{color:#fca5a5;border-color:#7f1d1d}
.hdl-t-chip.c-hist{color:#93c5fd;border-color:#1e3a8a}
.hdl-t-chip.c-found{color:#fde68a;border-color:#92400e}

/* Filtros */
.hdl-t-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.hdl-t-fb{
    background:${C.bg3};
    border:1px solid ${C.border};
    color:${C.muted};
    border-radius:6px;
    padding:4px 12px;
    cursor:pointer;
    font-size:11px;
    font-family:inherit;
    font-weight:600;
    transition:all .15s;
}
.hdl-t-fb:hover{border-color:${C.acc};color:${C.text}}
.hdl-t-fb.on{background:${C.acc};border-color:${C.acc};color:#fff}

/* Tabla */
.hdl-t-scroll{overflow:auto;flex:1;min-height:120px;border:1px solid ${C.border};border-radius:8px;background:${C.bg0}}
.hdl-t-scroll table{width:100%;border-collapse:collapse;font-size:11px}
.hdl-t-scroll th{
    position:sticky;top:0;
    background:#0a0a18;
    text-align:left;
    padding:8px 10px;
    color:${C.muted};
    border-bottom:2px solid ${C.border};
    white-space:nowrap;
    font-size:10px;
    text-transform:uppercase;
    letter-spacing:.6px;
    font-weight:700;
}
.hdl-t-scroll td{
    padding:7px 10px;
    border-bottom:1px solid #0e0e1e;
    vertical-align:middle;
    color:${C.text};
}
.hdl-t-scroll tr:hover td{background:#0c0c20}
.hdl-t-scroll a{color:#93c5fd;text-decoration:none;font-weight:600}
.hdl-t-scroll a:hover{text-decoration:underline}
td.hdl-nm{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Badges */
.hdl-badge{
    display:inline-flex;
    align-items:center;
    padding:2px 9px;
    border-radius:12px;
    font-size:10px;
    font-weight:700;
    white-space:nowrap;
}
.b-pending{background:#1e293b;color:#cbd5e1}
.b-downloading{background:#1e3a8a;color:#bfdbfe}
.b-done{background:#14532d;color:#86efac}
.b-failed{background:#450a0a;color:#fca5a5}
.hdl-err-note{color:#f87171;font-size:10px;margin-top:2px}

/* Botones inline de la tabla */
.hdl-t-ib{
    background:${C.bg3};
    border:1px solid ${C.border};
    color:${C.muted};
    border-radius:5px;
    padding:3px 9px;
    cursor:pointer;
    font-size:10px;
    font-family:inherit;
    font-weight:700;
    transition:all .15s;
}
.hdl-t-ib:hover{background:${C.border};color:${C.text}}
.hdl-t-ib:disabled{opacity:.3;cursor:not-allowed}

/* Paginacion */
.hdl-t-pagination{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:12px;
    margin-top:8px;
    color:${C.muted};
    font-size:11px;
    font-weight:600;
}

/* Footer de la tabla */
.hdl-t-footer{
    display:flex;
    flex-wrap:wrap;
    gap:7px;
    align-items:center;
    margin-top:10px;
    padding-top:10px;
    border-top:1px solid ${C.border};
}
.hdl-t-act{
    color:#fff;
    border:none;
    border-radius:7px;
    padding:7px 13px;
    cursor:pointer;
    font-size:11px;
    font-family:inherit;
    font-weight:600;
    transition:all .15s;
}
.hdl-t-act:hover{filter:brightness(1.18);transform:translateY(-1px)}
.hdl-t-act:disabled{opacity:.35;cursor:not-allowed;transform:none}
.hdl-t-note{
    font-size:11px;
    color:${C.muted};
    flex:1;
    min-width:200px;
    line-height:1.5;
    font-weight:500;
}
.hdl-t-note.complete{color:#86efac;font-weight:600}

/* Separador de donaciones */
.hdl-t-donate-sep{
    width:100%;
    height:1px;
    background:${C.border};
    margin:4px 0 2px 0;
}
.hdl-t-donate-label{
    width:100%;
    font-size:10px;
    color:${C.muted};
    font-weight:600;
    letter-spacing:.5px;
}
</style>

<div id="hdl-tbl-modal">
  <div id="hdl-tbl-header">
    <span id="hdl-tbl-title">Tabla de descargas</span>
    <button class="hdl-t-ib" data-act="close" style="padding:5px 12px;font-size:12px;font-weight:700">Cerrar</button>
  </div>
  <div id="hdl-tbl-root" style="display:flex;flex-direction:column;min-height:0;flex:1"></div>
</div>`;

        document.body.appendChild(ov);
        ov.addEventListener('click', onTableClick);
        tbl.lastHtml = '';
        tbl.timer    = setInterval(renderTable, 1200);
        renderTable();
    }

    function closeTableModal() {
        clearInterval(tbl.timer);
        $id('hdl-tbl-overlay')?.remove();
    }

    function onTableClick(e) {
        if (e.target.id==='hdl-tbl-overlay') { closeTableModal(); return; }
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const id = el.dataset.id;

        switch (el.dataset.act) {
            case 'close':        closeTableModal(); return;
            case 'filter':       tbl.filter=el.dataset.f; tbl.page=0; break;
            case 'prev':         tbl.page=Math.max(0,tbl.page-1); break;
            case 'next':         tbl.page++; break;
            case 'retry-one':    retryItems(it=>it.id===id); if (!loopActive) startLoop(); break;
            case 'remove-one':   removeItems(it=>it.id===id); break;
            case 'retry-failed': retryFailedAndStart(); break;
            case 'import-txt':   $id('hdl-file-input')?.click(); break;
            case 'export-txt':   if (!generateTxt()) updateStatus('El TXT solo se genera cuando el 100% esta completo.','warn'); break;
            case 'donate-kofi':
                GM_openInTab(DONATE_KOFI, { active: true });
                return;
            case 'donate-paypal':
                GM_openInTab(DONATE_PAYPAL, { active: true });
                return;
            case 'open-github':
                GM_openInTab(GITHUB_URL, { active: true });
                return;
            case 'clear-done': {
                const n = summarize().done;
                if (n && confirm(`Quitar ${n} filas completadas de la tabla?\nQuedaran en el historial.`)) {
                    removeItems(it=>it.status===ST.DONE);
                }
                break;
            }
            case 'clear-history': {
                const h = Object.keys(getHistory()).length;
                if (!h) { updateStatus('El historial ya esta vacio.', 'info'); break; }
                if (confirm(`Eliminar el historial completo?\n- ${h} galerias registradas se olvidaran\n- La tabla NO se toca`)) {
                    GM_deleteValue(KEY_HISTORY);
                    patchMeta({ skipped:0 });
                    refreshQueueInfo();
                    updateStatus(`Historial eliminado (${h} registros).\nLa tabla permanece intacta.`, 'warn');
                }
                break;
            }
        }
        tbl.lastHtml = '';
        renderTable();
    }

    function rowHtml(it, n, prog) {
        const url  = it.url||canonicalUrl(it.id);
        const name = it.title ? esc(it.title) : `<span style="color:${C.muted}">-- pendiente</span>`;

        let badge = '';
        if (it.status===ST.DONE) {
            badge = `<span class="hdl-badge b-done">OK</span>`;
        } else if (it.status===ST.FAILED) {
            const tries = it.tries>1 ? ` int.${it.tries}` : '';
            badge = `<span class="hdl-badge b-failed">Fallida${tries}</span>${it.err?`<div class="hdl-err-note">${esc(it.err)}</div>`:''}`;
        } else if (it.status===ST.RUNNING) {
            const p = prog&&prog.id===it.id ? ` ${prog.done}/${prog.total||it.total||'?'}` : '';
            badge = `<span class="hdl-badge b-downloading">Desc.${p}</span>`;
        } else {
            badge = `<span class="hdl-badge b-pending">Pendiente</span>`;
        }

        const acts = [];
        if (it.status===ST.FAILED) acts.push(`<button class="hdl-t-ib" data-act="retry-one" data-id="${esc(it.id)}" title="Reintentar">R</button>`);
        if (it.status===ST.DONE)   acts.push(`<button class="hdl-t-ib" data-act="retry-one" data-id="${esc(it.id)}" title="Descargar de nuevo">R</button>`);
        if (it.status!==ST.RUNNING) acts.push(`<button class="hdl-t-ib" data-act="remove-one" data-id="${esc(it.id)}" title="Quitar de la tabla">X</button>`);

        return `<tr>
<td style="color:${C.muted};width:36px;font-weight:600">${n}</td>
<td style="width:80px"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(it.id)}</a></td>
<td class="hdl-nm" title="${esc(it.title||'')}">${name}</td>
<td>${badge}</td>
<td style="width:70px;color:${C.muted};font-weight:600">${it.total?(it.ok||0)+'/'+it.total:'--'}</td>
<td style="width:78px;white-space:nowrap">${acts.join(' ')}</td>
</tr>`;
    }

    function renderTable() {
        const root = $id('hdl-tbl-root');
        if (!root) { clearInterval(tbl.timer); return; }

        const items = getItems(), s=summarize(items);
        const hist  = Object.keys(getHistory()).length;
        const prog  = GM_getValue(KEY_PROGRESS, null);
        const meta  = getMeta();
        const num   = new Map(items.map((it,i)=>[it.id,i+1]));
        const list  = tbl.filter==='all' ? items : items.filter(it=>it.status===tbl.filter);
        const size  = CFG.TABLE_PAGE_SIZE;
        const pages = Math.max(1, Math.ceil(list.length/size));
        tbl.page    = Math.min(tbl.page, pages-1);
        const slice = list.slice(tbl.page*size, (tbl.page+1)*size);
        const rows  = slice.map(it=>rowHtml(it,num.get(it.id),prog)).join('');
        const complete   = allDone(items);
        const exportable = canExport(items);

        const html = `
<div class="hdl-t-chips">
  ${meta.lastScan ? `<span class="hdl-t-chip c-found" title="${esc(meta.lastScan.label||'')}">Encontrados: ${meta.lastScan.found}${meta.lastScan.kept && meta.lastScan.kept<meta.lastScan.found ? ` (se toman ${meta.lastScan.kept})` : ''}</span>` : ''}
  <span class="hdl-t-chip">En tabla: ${s.total}</span>
  <span class="hdl-t-chip">Pend: ${s.pending}</span>
  <span class="hdl-t-chip">Desc: ${s.downloading}</span>
  <span class="hdl-t-chip c-ok">OK: ${s.done}</span>
  <span class="hdl-t-chip c-err">Fail: ${s.failed}</span>
  <span class="hdl-t-chip">Omitidas: ${meta.skipped||0}</span>
  <span class="hdl-t-chip c-hist">Historial: ${hist}</span>
</div>
<div class="hdl-t-filters">
  ${FILTERS.map(([f,label])=>`<button class="hdl-t-fb${tbl.filter===f?' on':''}" data-act="filter" data-f="${f}">${label}</button>`).join('')}
</div>
<div class="hdl-t-scroll" id="hdl-t-scroll">
  <table>
    <thead><tr><th>#</th><th>ID</th><th>Nombre</th><th>Estado</th><th>Paginas</th><th>Accion</th></tr></thead>
    <tbody>${rows||`<tr><td colspan="6" style="padding:24px;text-align:center;color:${C.muted}">Sin resultados en este filtro.</td></tr>`}</tbody>
  </table>
</div>
<div class="hdl-t-pagination">
  <button class="hdl-t-ib" data-act="prev"${tbl.page===0?' disabled':''}>Ant.</button>
  <span>Pagina ${tbl.page+1} / ${pages} &nbsp;|&nbsp; ${list.length} filas</span>
  <button class="hdl-t-ib" data-act="next"${tbl.page>=pages-1?' disabled':''}>Sig.</button>
</div>
<div class="hdl-t-footer">
  <button class="hdl-t-act" style="background:#7c3aed" data-act="retry-failed"${s.failed?'':' disabled'}>Reintentar fallidas (${s.failed})</button>
  <button class="hdl-t-act" style="background:#1d4ed8" data-act="import-txt">Importar TXT</button>
  <button class="hdl-t-act" style="background:#047857" data-act="export-txt"${exportable?'':' disabled title="Solo disponible con 100% completo"'}>Exportar TXT</button>
  <button class="hdl-t-act" style="background:#374151" data-act="clear-done"${s.done?'':' disabled'}>Quitar completadas</button>
  <button class="hdl-t-act" style="background:#7f1d1d" data-act="clear-history"${hist?'':' disabled'}>Limpiar historial (${hist})</button>
  <span class="hdl-t-note${exportable?' complete':''}">
    ${complete
        ? '100% completado — TXT disponible para exportar.'
        : exportable ? `Tabla vacia — puedes exportar el historial (${hist} enlaces).`
        : `TXT disponible con 100% completo. Faltan: ${s.pending+s.downloading} pendientes, ${s.failed} fallidas.`}
  </span>
  <div class="hdl-t-donate-sep"></div>
  <span class="hdl-t-donate-label">Si el script te fue util puedes apoyar para darme algo que comer XD:</span>
  <button class="hdl-t-act" style="background:#ff5e5b;color:#111" data-act="donate-kofi" title="Donar en Ko-fi">Ko-fi</button>
  <button class="hdl-t-act" style="background:#003087" data-act="donate-paypal" title="Donar en PayPal">PayPal</button>
  <div class="hdl-t-donate-sep"></div>
  <span class="hdl-t-donate-label">Codigo fuente y actualizaciones:</span>
  <button class="hdl-t-act" style="background:#24292f;border:1px solid #444" data-act="open-github" title="Ver repositorio en GitHub">GitHub</button>
</div>`;

        if (html===tbl.lastHtml) return;
        tbl.lastHtml = html;
        const sc  = $id('hdl-t-scroll') ? $id('hdl-t-scroll').scrollTop : 0;
        root.innerHTML = html;
        const sc2 = $id('hdl-t-scroll');
        if (sc2) sc2.scrollTop = sc;
    }

    // SECCION 10 — MODAL ENTRADA MANUAL
    function openManualModal() {
        if ($id('hdl-manual-overlay')) return;
        const ov = document.createElement('div');
        ov.id = 'hdl-manual-overlay';
        ov.className = 'hdl-root';
        ov.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:2147483646;display:flex;align-items:center;justify-content:center`;
        ov.innerHTML = `
<style>
/* Aislamiento: ignora reglas globales del sitio sobre div, button, table, a, etc. */
.hdl-root{all:initial;display:block;box-sizing:border-box}
.hdl-root *,.hdl-root *::before,.hdl-root *::after{all:revert;box-sizing:border-box}
#hdl-manual-modal *{box-sizing:border-box}
#hdl-manual-modal{
    background:${C.bg1};
    border:1px solid ${C.border};
    border-radius:14px;
    padding:20px;
    width:530px;
    max-width:95vw;
    font-family:'Segoe UI',system-ui,sans-serif;
    color:${C.text};
    font-size:12px;
    box-shadow:0 20px 60px rgba(0,0,0,.95);
}
#hdl-manual-modal h3{
    font-size:14px;font-weight:700;
    color:${C.acc2};
    margin-bottom:12px;
    padding-bottom:10px;
    border-bottom:1px solid ${C.border};
}
.hdl-m-hint{
    background:${C.bg0};
    border:1px solid ${C.border};
    border-radius:8px;
    padding:10px 13px;
    margin-bottom:12px;
    line-height:1.85;
    color:${C.muted};
    font-weight:500;
}
.hdl-m-hint code{
    background:${C.bg3};
    padding:1px 6px;
    border-radius:4px;
    font-family:'Consolas','Courier New',monospace;
    font-size:11px;
    color:#67e8f9;
    border:1px solid ${C.border};
}
#hdl-manual-textarea{
    width:100%;height:140px;
    background:${C.bg0};
    color:${C.text};
    border:1px solid ${C.border};
    border-radius:8px;
    padding:10px;
    font-family:'Consolas','Courier New',monospace;
    font-size:11px;
    resize:vertical;
    line-height:1.7;
    outline:none;
    font-weight:500;
}
#hdl-manual-textarea:focus{border-color:${C.acc};box-shadow:0 0 0 2px rgba(124,58,237,.2)}
#hdl-manual-result{
    display:none;
    margin-top:10px;
    padding:10px;
    background:${C.bg0};
    border-radius:8px;
    border:1px solid ${C.border};
    font-size:11px;
    line-height:1.7;
    white-space:pre-wrap;
    font-weight:500;
}
.hdl-m-actions{display:flex;gap:8px;margin-top:12px}
.hdl-m-btn{
    flex:1;padding:9px;
    border:none;border-radius:7px;
    color:#fff;
    cursor:pointer;
    font-family:inherit;
    font-size:11px;font-weight:700;
    transition:all .15s;
}
.hdl-m-btn:hover{filter:brightness(1.15);transform:translateY(-1px)}
.hdl-m-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
</style>
<div id="hdl-manual-modal">
  <h3>Agregar entradas manualmente</h3>
  <div class="hdl-m-hint">
    Una entrada por linea (o separadas por coma):<br>
    <code>https://hitomi.la/doujinshi/titulo-123456.html</code> URL de galeria<br>
    <code>123456</code> ID numerico<br>
    <code>artist:nombre artista</code> por artista<br>
    <code>female:glasses language:english</code> combinaciones<br>
    <code>series:nombre -female:ntr</code> con exclusiones<br>
    Lo ya descargado (historial/TXT) se omite automaticamente.
  </div>
  <textarea id="hdl-manual-textarea" placeholder="artist:amanagi yakumo&#10;female:glasses language:english&#10;https://hitomi.la/doujinshi/titulo-123456.html&#10;789012"></textarea>
  <div id="hdl-manual-result"></div>
  <div class="hdl-m-actions">
    <button class="hdl-m-btn" id="hdl-m-add"       style="background:#047857">Agregar a tabla</button>
    <button class="hdl-m-btn" id="hdl-m-add-start" style="background:#7c3aed">Agregar e iniciar</button>
    <button class="hdl-m-btn" id="hdl-m-close"     style="background:${C.bg3};color:${C.muted};flex:0 0 auto;padding:9px 16px">Cancelar</button>
  </div>
</div>`;

        document.body.appendChild(ov);
        ov.addEventListener('click', e=>{ if (e.target===ov) closeManualModal(); });
        $id('hdl-m-close').onclick     = closeManualModal;
        $id('hdl-m-add').onclick       = ()=>handleManualSubmit(false);
        $id('hdl-m-add-start').onclick = ()=>handleManualSubmit(true);
        setTimeout(()=>$id('hdl-manual-textarea')?.focus(), 50);
    }

    function closeManualModal() { $id('hdl-manual-overlay')?.remove(); }

    async function handleManualSubmit(autoStart) {
        const ta  = $id('hdl-manual-textarea');
        const res = $id('hdl-manual-result');
        if (!ta||!res) return;
        const raw = ta.value.trim();
        if (!raw) { res.style.display='block'; res.style.color=C.red; res.textContent='El campo esta vacio.'; return; }

        const btns = ['hdl-m-add','hdl-m-add-start','hdl-m-close'];
        btns.forEach(id=>{ const el=$id(id); if(el) el.disabled=true; });
        res.style.display='block'; res.style.color=C.muted;
        res.textContent='Leyendo indices de hitomi.la...';

        const { added, inHistory, inTable, found, errors } = await addManualEntries(raw);

        res.style.color = added>0 ? C.green : C.amber;
        res.textContent = [
            found     ? `${found} galeria(s) encontrada(s).` : '',
            added     ? `${added} galeria(s) agregada(s) a la tabla.` : 'No se agrego ninguna galeria nueva.',
            inHistory ? `${inHistory} omitidas (ya en historial/TXT).` : '',
            inTable   ? `${inTable} ya estaban en la tabla.` : '',
            errors.length ? `\nErrores:\n${errors.join('\n')}` : '',
        ].filter(Boolean).join('\n');

        btns.forEach(id=>{ const el=$id(id); if(el) el.disabled=false; });
        refreshQueueInfo();

        if (autoStart && added>0) { closeManualModal(); startLoop(); }
    }

    // SECCION 11 — PUNTO DE ENTRADA
    function maybeResume() {
        refreshQueueInfo();
        if (!GM_getValue(KEY_RUNNING,false)) return;
        if (!hasPending()) { GM_setValue(KEY_RUNNING,false); return; }
        if (lockHeldByOther()) return;
        setButtonState('running');
        updateStatus(`Reanudando sesion...\n${summarize().pending} galerias pendientes.`, 'info');
        setTimeout(runDownloadLoop, 1500);
    }

    function init() {
        const boot = () => { createUI(); maybeResume(); };
        if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }

    init();
})();