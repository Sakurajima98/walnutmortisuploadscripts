// Script to upload game api response body in chunks
// author: NeuraXmy 8823
const scriptName = "upload.js";
const version = "0.4.2";

function getJWT() {
    if (typeof $script === 'undefined' || !$script.scriptPath) return '';
    const m = $script.scriptPath.match(/[?&]jwt=([^&]+)/);
    return m ? decodeURI(m[1]) : '';
}

const B64_INV = (function () {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const inv = {};
    for (let i = 0; i < chars.length; i++) inv[chars[i]] = i;
    inv['-'] = inv['+']; inv['_'] = inv['/'];
    return inv;
})();

function base64UrlToBase64(s) {
    if (!s) return '';
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const pad = s.length % 4; if (pad) s += '='.repeat(4 - pad);
    return s;
}

function manualBase64ToUint8Array(b64) {
    b64 = b64.replace(/\s+/g, '');
    const out = []; let buf = 0, bits = 0;
    for (let i = 0; i < b64.length; i++) {
        const ch = b64[i]; if (ch === '=') break;
        const val = B64_INV.hasOwnProperty(ch) ? B64_INV[ch] : -1;
        if (val === -1) continue;
        buf = (buf << 6) | val; bits += 6;
        if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
    }
    return new Uint8Array(out);
}

function utf8BytesToString(bytes) {
    let s = '', i = 0;
    while (i < bytes.length) {
        const c = bytes[i];
        if (c < 128) { s += String.fromCharCode(c); i++; }
        else if ((c & 0xE0) === 0xC0) {
            const c2 = bytes[i + 1] || 0;
            s += String.fromCharCode(((c & 0x1F) << 6) | (c2 & 0x3F)); i += 2;
        } else if ((c & 0xF0) === 0xE0) {
            const c2 = bytes[i + 1] || 0, c3 = bytes[i + 2] || 0;
            s += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F)); i += 3;
        } else {
            const c2 = bytes[i + 1] || 0, c3 = bytes[i + 2] || 0, c4 = bytes[i + 3] || 0;
            let cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F);
            cp -= 0x10000; s += String.fromCharCode((cp >> 10) + 0xD800, (cp & 0x3FF) + 0xDC00); i += 4;
        }
    }
    return s;
}

function parseJWTManual(token) {
    if (!token || typeof token !== 'string') return {};
    token = token.trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1).trim();
    const parts = token.split('.'); if (!parts || parts.length < 2) return {};
    const base64 = base64UrlToBase64(parts[1].replace(/\s+/g, ''));
    const bytes = manualBase64ToUint8Array(base64);
    if (!bytes || bytes.length === 0) return {};
    const s = utf8BytesToString(bytes);
    try { return JSON.parse(s); } catch { return {}; }
}

/* main */
const JWT = getJWT();
console.log(`[${scriptName} v${version}] 开始上传`);
if (!JWT) { console.log(`[${scriptName}] 未找到JWT，跳过`); $done({}); }

console.log(`[${scriptName}] JWT: ${JWT}`);
const payload = parseJWTManual(JWT);
console.log(`[${scriptName}] 解码方法: manualUtf8`);
console.log(`[${scriptName}] 结果:`, payload);

const rawType = (payload && (payload.data_type || payload.dataType)) || '';
const dataType = String(rawType).trim().toLowerCase() || 'suite';
const endpoint = dataType === 'mysekai' ? 'mysekai' : 'suite';

// 配置目标上传地址（按需修改为你的IP与端口）
const TARGET_PROTOCOL = "http";
const TARGET_IP = "43.136.81.133";
const TARGET_PORT = 15933;
const TARGET_PATH = "/upload";

// 构建新的上传URL（不再使用resona.resona.cn）
const UPLOAD_URL = `${TARGET_PROTOCOL}://${TARGET_IP}:${TARGET_PORT}${TARGET_PATH}?jwt=${encodeURIComponent(JWT)}`;

console.log(`[${scriptName}] upload url: ${UPLOAD_URL}`);

const CHUNK_SIZE = 1024 * 1024, CONCURRENCY = 4, MAX_RETRIES = 3, RETRY_BASE = 500;
let body = $response.body;
try {
    if (body && typeof body !== 'string' && !(typeof Buffer !== 'undefined' && body instanceof Buffer) && !(body && body.constructor && body.constructor.name === 'Uint8Array')) {
        body = String(body);
    }
} catch (e) { }

if (!body || (typeof body === 'string' && body.length === 0) || (body && typeof body === 'object' && body.length === 0)) {
    console.log(`[${scriptName}] 响应体为空，跳过`); $done({});
}

const bodyLen = (typeof body === 'string') ? body.length : (body.length || 0);
console.log(`[${scriptName}] 响应体大小: ${bodyLen} bytes`);
const uploadId = Math.random().toString(36).slice(2, 10);
const total = Math.max(1, Math.ceil(bodyLen / CHUNK_SIZE));
console.log(`[${scriptName}] uploadId: ${uploadId}, 分片总数: ${total}`);

function getUserId(url) { const m = url && url.match ? url.match(/\/user\/(\d+)|suite\/user\/(\d+)/) : null; return m ? (m[1] || m[2]) : 'unknown'; }

let inFlight = 0, doneCount = 0, failCount = 0;
const queue = Array.from({ length: total }, (_, i) => i);

function next() {
    while (inFlight < CONCURRENCY && queue.length > 0) { inFlight++; uploadChunk(queue.shift(), 0); }
}

function uploadChunk(idx, attempt) {
    const start = idx * CHUNK_SIZE, end = Math.min(start + CHUNK_SIZE, bodyLen);
    const chunk = (typeof body === 'string') ? body.slice(start, end) : (body && body.slice ? body.slice(start, end) : String(body).slice(start, end));
    console.log(`[${scriptName}] 上传分片 ${idx + 1}/${total}，尝试次数 ${attempt + 1}`);

    const opts = {
        method: 'POST', url: UPLOAD_URL, timeout: 60,
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Script-Version': version,
            'X-Original-Url': $request && $request.url,
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': idx,
            'X-Total-Chunks': total,
            'X-User-Id': getUserId($request && $request.url),
        },
        body: chunk
    };

    $httpClient.post(opts, (err, resp) => {
        const ok = !err && resp && (resp.status === 200 || resp.status === 201 || resp.status === 204);
        if (ok) { console.log(`[${scriptName}] 分片 ${idx + 1} 成功`); finish(true); }
        else if (attempt < MAX_RETRIES) {
            const d = RETRY_BASE * Math.pow(2, attempt);
            console.log(`[${scriptName}] 分片 ${idx + 1} 失败，${d}ms后重试: ${err || (resp && resp.status)}`);
            setTimeout(() => uploadChunk(idx, attempt + 1), d);
        } else { console.log(`[${scriptName}] 分片 ${idx + 1} 最终失败: ${err || (resp && resp.status)}`); finish(false); }

        function finish(success) {
            inFlight--; success ? doneCount++ : failCount++;
            console.log(`[${scriptName}] 进度: 成功 ${doneCount}, 失败 ${failCount}, 进行中 ${inFlight}, 队列剩余 ${queue.length}`);
            if (doneCount + failCount === total) {
                console.log(`[${scriptName}] 上传完成 ${uploadId} — 总数:${total}, 成功:${doneCount}, 失败:${failCount}`);
                $done({});
            } else next();
        }
    });
}

next();