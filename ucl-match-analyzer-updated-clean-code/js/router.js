/** router.js — tiny hash router: '#/analysis/<id>' -> route 'analysis', params ['<id>']. */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  class Router {
    constructor(routes, onChange) { this.routes = routes; this.onChange = onChange; }
    parse(hash) {
      const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      const name = parts[0] && this.routes.includes(parts[0]) ? parts[0] : 'dashboard';
      return { name, params: parts.slice(1) };
    }
    start() { global.addEventListener('hashchange', () => this.onChange(this.parse(global.location.hash))); this.onChange(this.parse(global.location.hash)); }
    go(name, ...params) { global.location.hash = '#/' + [name, ...params].map(encodeURIComponent).join('/'); }
  }
  NS.router = { Router };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.router;
})(typeof window !== 'undefined' ? window : globalThis);
