/**
 * storage.js — namespaced, versioned JSON persistence over localStorage (or any Storage-like backend).
 * Falls back to an in-memory map when localStorage is unavailable (private mode, blocked storage) and
 * reports `persistent: false` so the UI can warn the user. Never throws.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const PREFIX = 'ucl.v1.';

  function memoryBackend() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
    };
  }

  function createStorage(backend) {
    let persistent = true;
    if (!backend) {
      try { backend = global.localStorage; backend.setItem('__ucl_probe', '1'); backend.removeItem('__ucl_probe'); }
      catch (e) { backend = memoryBackend(); persistent = false; }
    }
    return {
      get persistent() { return persistent; },
      /** @returns parsed value or `fallback` (also when the stored JSON is corrupt) */
      get(key, fallback = null) {
        try { const raw = backend.getItem(PREFIX + key); return raw === null ? fallback : JSON.parse(raw); }
        catch (e) { return fallback; }
      },
      /** @returns {ok:boolean, error?:string} */
      set(key, value) {
        try { backend.setItem(PREFIX + key, JSON.stringify(value)); return { ok: true }; }
        catch (e) {
          const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
          return { ok: false, error: quota ? 'Browser storage quota exceeded — export your data and clear old entries.' : 'Could not write to storage: ' + (e && e.message) };
        }
      },
      remove(key) { try { backend.removeItem(PREFIX + key); } catch (e) { /* ignore */ } },
      keys() { const out = []; try { for (let i = 0; i < backend.length; i++) { const k = backend.key(i); if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length)); } } catch (e) { /* ignore */ } return out; },
      /** Approximate bytes used by this app's keys. */
      usage() { let n = 0; try { for (const k of this.keys()) n += (backend.getItem(PREFIX + k) || '').length * 2; } catch (e) { /* ignore */ } return n; },
      clearAll() { for (const k of this.keys()) this.remove(k); },
    };
  }

  const api = { PREFIX, createStorage, memoryBackend };
  NS.storage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
