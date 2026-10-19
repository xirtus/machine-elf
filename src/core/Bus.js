/**
 * Tiny synchronous event bus. Zero allocation on emit for <=4 args.
 * Every system talks through this so nothing needs a direct reference to
 * anything else. Event names are namespaced `domain:verb`.
 *
 * Canonical events (keep this list authoritative):
 *   player:hit        {damage}
 *   player:dead       {}
 *   player:boost      {on:boolean}
 *   weapon:lockAdd    {target, count}
 *   weapon:fire       {targets:[], count}
 *   weapon:hit        {target, position, damage, killed:boolean}
 *   enemy:spawn       {enemy}
 *   enemy:killed      {enemy, position, value}
 *   graze             {position, chain, intensity}
 *   combo:change      {value, tier}
 *   score:add         {amount, total}
 *   boss:spawn        {boss}
 *   boss:phase        {boss, phase}
 *   boss:dead         {boss}
 *   dimension:enter   {index, def}
 *   dimension:shift   {from, to, progress}
 *   camera:shake      {amount, duration}
 *   time:hitstop      {duration}
 *   audio:cue         {id, opts}
 */
class EventBus {
  constructor() {
    this._map = new Map();
    this._onceMap = new Map();
  }

  on(name, fn) {
    let list = this._map.get(name);
    if (!list) this._map.set(name, (list = []));
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const wrap = (...a) => { this.off(name, wrap); fn(...a); };
    return this.on(name, wrap);
  }

  off(name, fn) {
    const list = this._map.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(name, a, b, c, d) {
    const list = this._map.get(name);
    if (!list || list.length === 0) return;
    // iterate over a snapshot length so handlers can unsubscribe safely
    for (let i = 0; i < list.length; i++) {
      try { list[i](a, b, c, d); }
      catch (e) { console.error(`[bus] handler for "${name}" threw:`, e); }
    }
  }

  clear() { this._map.clear(); this._onceMap.clear(); }
}

export const Bus = new EventBus();
export default Bus;
