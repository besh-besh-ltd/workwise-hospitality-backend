/**
 * Inventory route shape: every API-contract route is mounted, authenticated and
 * guarded by user type. Handlers answer whatever their domain says for id 1
 * (404, 400, 403 ...) but never a crash; an unimplemented stub answers 501
 * 'not implemented' until its owning track lands.
 */
import { httpClient } from '../helpers/http.js';
import { IDS } from '../fixtures/ids.js';
import { db, closeDb } from '../setup/db.js';
import InventoryRoutes from '../../app/routes/inventory/index.js';
import { lookupEvent, isNotAnEvent } from '../../app/services/activity/eventRegistry.js';

const BASE = '/api/v1/inventory';

// [method, path] for buyer routes. Path params are filled with 1.
const BUYER_ROUTES = [
  ['get', '/po/1/deliveries'],
  ['put', '/po/1/deliveries'],
  ['patch', '/po/1/deliveries/1'],
  ['post', '/po/1/short-close'],
  ['post', '/po/1/short-close/reopen'],
  ['post', '/po/1/site-rep/revoke'],
  ['get', '/receive/awaiting'],
  ['get', '/receive/po/1'],
  ['post', '/grn'],
  ['get', '/grn'],
  ['get', '/grn/1'],
  ['put', '/grn/1'],
  ['post', '/grn/1/post'],
  ['delete', '/grn/1'],
  ['post', '/grn/1/reverse'],
  ['post', '/grn/1/attachments'],
  ['delete', '/grn/1/attachments/1'],
  ['get', '/grn/1/pdf'],
  ['post', '/rtv'],
  ['get', '/rtv/1'],
  ['post', '/rtv/1/dispatch'],
  ['post', '/rtv/1/close'],
  ['post', '/rtv/1/cancel'],
  ['get', '/items'],
  ['post', '/items'],
  ['get', '/items/suggest'],
  ['put', '/items/1'],
  ['post', '/items/1/variants'],
  ['get', '/items/1/uoms'],
  ['put', '/items/1/uoms'],
  ['post', '/items/1/barcodes'],
  ['delete', '/items/1/barcodes/1'],
  ['get', '/hotel-items'],
  ['put', '/hotel-items/1/1'],
  ['get', '/settings/company'],
  ['put', '/settings/company'],
  ['get', '/settings/hotel/1'],
  ['put', '/settings/hotel/1'],
  ['get', '/category-defaults'],
  ['put', '/category-defaults'],
  ['post', '/opening/1/preview'],
  ['post', '/opening/1/post'],
  ['get', '/stock'],
  ['get', '/stock/1/items/1'],
  ['get', '/stock/1/items/1/ledger'],
  ['post', '/out'],
  ['get', '/out'],
  ['get', '/out/1'],
  ['post', '/adjustments'],
  ['get', '/adjustments'],
  ['get', '/adjustments/1'],
  ['post', '/adjustments/1/approve'],
  ['post', '/adjustments/1/reject'],
  ['post', '/counts'],
  ['get', '/counts'],
  ['get', '/counts/1'],
  ['put', '/counts/1/lines'],
  ['post', '/counts/1/submit'],
  ['post', '/counts/1/approve'],
  ['post', '/counts/1/cancel'],
  ['get', '/overview'],
  ['get', '/scan/resolve'],
  ['post', '/labels/items'],
  ['post', '/labels/grn/1'],
  ['get', '/s/resolve'],
  ['get', '/reorder'],
  ['post', '/reorder/mr-draft'],
];

const VENDOR_ROUTES = [
  ['get', '/vendor/po/1/deliveries'],
  ['post', '/vendor/po/1/dispatches'],
  ['post', '/vendor/po/1/dispatches/1/cancel'],
];

const TOKEN_ROUTES = [
  ['get', '/token/receive-context'],
  ['post', '/token/grn'],
  ['post', '/token/grn/1/attachments'],
];

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

const prev = {};
const stamp = async (id, type) => {
  const row = await db.one('SELECT user_type, status FROM tbl_users WHERE id=$1', [id]);
  prev[id] = row;
  await db.none('UPDATE tbl_users SET user_type=$2, status=1 WHERE id=$1', [id, type]);
};

beforeAll(async () => {
  await stamp(BUYER, 2);
  await stamp(VENDOR, 3);
});

afterAll(async () => {
  for (const [id, row] of Object.entries(prev)) {
    await db.none('UPDATE tbl_users SET user_type=$2, status=$3 WHERE id=$1', [
      id,
      row.user_type,
      row.status,
    ]);
  }
  await closeDb();
});

const call = (client, [method, path]) => client[method](`${BASE}${path}`);

// Express's own 404 for an unmounted path is HTML; every inventory handler
// answers JSON, including its own 404s.
const isUnmounted = (res) => res.status === 404 && !/json/.test(res.type);
const isStub = (res) => res.status === 501 && res.body?.message === 'not implemented';

const outcome = (route, res) => ({
  route: route.join(' '),
  mounted: !isUnmounted(res),
  authed: res.status !== 401,
  noCrash: res.status < 500 || isStub(res),
});
const reached = (route) => ({ route: route.join(' '), mounted: true, authed: true, noCrash: true });

describe('inventory route scaffolding', () => {
  it('every contract route is mounted and authenticated', async () => {
    const anon = await httpClient(null);
    const buyer = await httpClient(BUYER);

    for (const route of [...BUYER_ROUTES, ...VENDOR_ROUTES]) {
      const res = await call(anon, route);
      expect([route.join(' '), res.status]).toEqual([route.join(' '), 401]);
    }
    for (const route of BUYER_ROUTES) {
      const res = await call(buyer, route);
      expect(outcome(route, res)).toEqual(reached(route));
    }
  });

  it('vendor routes reject buyers', async () => {
    const buyer = await httpClient(BUYER);
    for (const route of VENDOR_ROUTES) {
      const res = await call(buyer, route);
      expect([route.join(' '), res.status]).toEqual([route.join(' '), 403]);
    }
  });

  it('vendor routes reach their handler for a vendor, and buyer routes reject vendors', async () => {
    const vendor = await httpClient(VENDOR);
    for (const route of VENDOR_ROUTES) {
      const res = await call(vendor, route);
      expect(outcome(route, res)).toEqual(reached(route));
      expect([route.join(' '), res.status]).not.toEqual([route.join(' '), 403]);
    }
    for (const route of [BUYER_ROUTES[0], ['get', '/stock'], ['post', '/grn']]) {
      const res = await call(vendor, route);
      expect([route.join(' '), res.status]).toEqual([route.join(' '), 403]);
    }
  });

  it('token routes get 401 without X-Receive-Token; a bogus token never reaches a handler', async () => {
    const anon = await httpClient(null);
    for (const route of TOKEN_ROUTES) {
      const res = await call(anon, route);
      expect([route.join(' '), res.status]).toEqual([route.join(' '), 401]);
      expect(res.body).toEqual({ status: 0, message: 'Invalid or expired link' });
      const withHeader = await call(anon, route).set('X-Receive-Token', 'abc');
      expect([route.join(' '), [401, 501].includes(withHeader.status)]).toEqual([
        route.join(' '),
        true,
      ]);
    }
  });

  it('every mutating inventory route is in the activity registry or NOT_AN_EVENT', () => {
    const found = [];
    const walk = (stack, prefix) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const m of Object.keys(layer.route.methods)) {
            if (m !== 'get') found.push([m.toUpperCase(), prefix + layer.route.path]);
          }
        } else if (layer.handle?.stack) {
          const mount = layer.regexp.source.match(/^\^\\\/(\w+)\\\/\?\(\?=/);
          walk(layer.handle.stack, prefix + (mount ? `/${mount[1]}` : ''));
        }
      }
    };
    walk(InventoryRoutes.stack, '/inventory');
    expect(found.length).toBeGreaterThan(40);
    expect(found).toContainEqual(['POST', '/inventory/token/grn']);
    const gaps = found
      .filter(([m, p]) => !lookupEvent(m, p) && !isNotAnEvent(m, p))
      .map(([m, p]) => `${m} ${p}`);
    expect(gaps).toEqual([]);
  });
});
